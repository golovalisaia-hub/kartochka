/*
 * Quick-access regression suite.
 *
 * Covers the launch contract (startapp=quick), the compact layout at a real Telegram sheet
 * height, the "one tap to the code" promise, and the open-history model that decides which
 * card is offered first.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
};
const server = http.createServer((request, response) => {
  const route = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const target = path.resolve(root, `.${route === '/' ? '/index.html' : route}`);
  if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.setHeader('Content-Type', types[path.extname(target)] || 'application/octet-stream');
  fs.createReadStream(target).pipe(response);
});

const user = {
  id: 'telegram-quick-user',
  email: 'telegram-515151@telegram.kartochka.invalid',
  email_confirmed_at: '2026-09-22T00:00:00.000Z',
  user_metadata: { auth_source: 'telegram', telegram_id: 515151 }
};
const session = {
  access_token: 'quick-access-token',
  refresh_token: 'quick-refresh-token',
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user
};

/* A Telegram stub that records what the app asks of it. `stableHeight` mimics a COMPACT
   launch: far shorter than the screen, which is exactly the case the layout must survive. */
function telegramStub({ startParam, stableHeight = 380, loginDelayMs = 0 }) {
  return [{ startParam, stableHeight, loginDelayMs }, function stub(options) {
    window.__tg = { expandCalls: [], readyCalls: 0, backVisible: false, backHandlers: 0 };
    window.Telegram = {
      WebApp: {
        initData: 'signed-quick-init-data',
        initDataUnsafe: {
          user: { id: 515151, first_name: 'Быстрый', username: 'quick_test' },
          start_param: options.startParam
        },
        viewportHeight: options.stableHeight,
        viewportStableHeight: options.stableHeight,
        isExpanded: false,
        safeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 },
        contentSafeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 },
        ready() { window.__tg.readyCalls += 1; },
        expand(...args) {
          window.__tg.expandCalls.push(args);
          this.isExpanded = true;
        },
        onEvent() {},
        offEvent() {},
        setHeaderColor() {},
        setBackgroundColor() {},
        enableClosingConfirmation() {},
        BackButton: {
          onClick(handler) { window.__tg.backHandlers += 1; window.__tgBack = handler; },
          show() { window.__tg.backVisible = true; },
          hide() { window.__tg.backVisible = false; }
        }
      }
    };
  }];
}

async function newSession(browser, { startParam, stableHeight, seedCards = null, height = 844 }) {
  const context = await browser.newContext({
    viewport: { width: 390, height },
    isMobile: true,
    hasTouch: true
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const rows = new Map();
  const opens = [];
  const [options, stub] = telegramStub({ startParam, stableHeight });
  await page.addInitScript(stub, options);
  if (seedCards) {
    await page.addInitScript(options => {
      localStorage.setItem('kartochka.cards.v1', JSON.stringify(options.cards));
      localStorage.setItem('kartochka.demo-cleanup.v1', '1');
      // This wallet belongs to the account that is about to sign in. Without this marker the
      // app deliberately withholds the cards inside Telegram — see telegram-account-privacy.
      localStorage.setItem('kartochka.cloud-user.v1', options.owner);
    }, { cards: seedCards, owner: user.id });
  }

  await page.route('https://qtyqdlkmfojbebgxcqxl.supabase.co/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (url.pathname === '/functions/v1/telegram' && request.postDataJSON()?.action === 'login') {
      return json({ token_hash: 'quick-token-hash', type: 'magiclink' });
    }
    if (url.pathname === '/auth/v1/verify' || url.pathname === '/auth/v1/token') return json(session);
    if (url.pathname === '/rest/v1/telegram_test_cards' && request.method() === 'GET') {
      return json([...rows.values()].filter(row => !row.deleted_at));
    }
    if (url.pathname === '/rest/v1/rpc/record_telegram_test_card_opens') {
      const submitted = request.postDataJSON()?.p_opens || [];
      const applied = [];
      for (const entry of submitted) {
        const row = rows.get(entry.id);
        if (!row || row.deleted_at) continue;
        // Mirrors the SQL: move forward only, never touch `revision`.
        row.last_opened_at = Math.max(Number(row.last_opened_at || 0), Number(entry.at));
        opens.push({ id: entry.id, at: Number(entry.at), revision: row.revision });
        applied.push(entry.id);
      }
      return json(applied);
    }
    if (url.pathname === '/rest/v1/rpc/apply_telegram_test_card_change') {
      const body = request.postDataJSON();
      const current = rows.get(body.p_card_id);
      const expected = Number(body.p_expected_revision || 0);
      if ((current && Number(current.revision) !== expected) || (!current && expected !== 0)) {
        return json({ code: 'P0001', message: 'SYNC_CONFLICT' }, 409);
      }
      if (body.p_delete) {
        rows.set(body.p_card_id, { ...current, deleted_at: new Date().toISOString(), revision: expected + 1 });
        return json({ revision: expected + 1, deleted: true });
      }
      const card = body.p_card;
      rows.set(body.p_card_id, {
        user_id: user.id, id: body.p_card_id, store: card.store, number: card.number,
        color_a: card.color_a, color_b: card.color_b, text_color: card.text_color,
        last_used: card.last_used, last_opened_at: Number(current?.last_opened_at || 0),
        format: card.format, code_image: card.code_image,
        revision: expected + 1, deleted_at: null
      });
      return json({ revision: expected + 1, deleted: false });
    }
    if (url.pathname === '/rest/v1/cards' || url.pathname === '/rest/v1/rpc/apply_card_change') {
      return json({ message: 'production endpoint must not be used by Telegram' }, 403);
    }
    return json({}, 404);
  });

  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  return { context, page, rows, opens };
}

const card = (id, store, number, extra = {}) => ({
  id, store, number, a: '#333', b: '#111', text: '#fff',
  lastUsed: 1, format: 'code_128', codeImage: null, ...extra
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  const failures = [];
  const check = async (name, body) => {
    try { await body(); console.log(`  ok  ${name}`); }
    catch (error) { failures.push(name); console.error(`  FAIL ${name}\n       ${error.message}`); }
  };

  try {
    // ---- launch contract -------------------------------------------------
    await check('startapp=quick opens the compact screen and never expands at startup', async () => {
      const { context, page } = await newSession(browser, { startParam: 'quick' });
      await page.waitForSelector('#quickScreen:not([hidden])');
      const tg = await page.evaluate(() => window.__tg);
      assert.equal(tg.expandCalls.length, 0, 'expand() must not be called on a quick launch');
      assert.equal(tg.readyCalls >= 1, true, 'ready() must be signalled once a screen exists');
      assert.equal(await page.locator('#quickScreen').isVisible(), true);
      assert.equal(await page.locator('.bottom-nav').isVisible(), false, 'nav must not steal space');
      await context.close();
    });

    await check('an ordinary launch opens the normal wallet, not the compact screen', async () => {
      const { context, page } = await newSession(browser, { startParam: undefined });
      await page.waitForSelector('#walletView.active');
      assert.equal(await page.locator('#quickScreen').isVisible(), false);
      const tg = await page.evaluate(() => window.__tg);
      assert.equal(tg.expandCalls.length, 0, 'startup must never expand by itself');
      await context.close();
    });

    await check('an unknown start parameter falls back to the normal wallet', async () => {
      const { context, page } = await newSession(browser, { startParam: 'definitely-not-a-mode' });
      await page.waitForSelector('#walletView.active');
      assert.equal(await page.locator('#quickScreen').isVisible(), false);
      assert.equal(await page.evaluate(() => window.KartochkaTelegram.mode()), 'normal');
      await context.close();
    });

    await check('a hostile start parameter cannot grant anything', async () => {
      const { context, page } = await newSession(browser, { startParam: '../../admin' });
      await page.waitForSelector('#walletView.active');
      assert.equal(await page.evaluate(() => window.KartochkaTelegram.startParam()), '');
      await context.close();
    });

    // ---- open history ----------------------------------------------------
    await check('the last card actually opened is offered first', async () => {
      const seed = [
        card('11111111-1111-4111-8111-111111111111', 'Лента', 'TEST-A', { openedAt: 2000, legacyTouchedAt: 1 }),
        card('22222222-2222-4222-8222-222222222222', 'Магнит', 'TEST-B', { openedAt: 9000, legacyTouchedAt: 1 }),
        card('33333333-3333-4333-8333-333333333333', 'Пятёрочка', 'TEST-C', { openedAt: 5000, legacyTouchedAt: 1 })
      ];
      const { context, page } = await newSession(browser, { startParam: 'quick', seedCards: seed });
      await page.waitForSelector('.quick-card');
      const order = await page.locator('.quick-card-store').allInnerTexts();
      assert.deepEqual(order, ['Магнит', 'Пятёрочка', 'Лента']);
      assert.equal(await page.locator('.quick-card').first().evaluate(el => el.classList.contains('primary')), true);
      await context.close();
    });

    await check('a freshly added card does not displace the last opened card', async () => {
      const seed = [
        card('44444444-4444-4444-8444-444444444444', 'Магнит', 'TEST-OPENED', { openedAt: 5000, legacyTouchedAt: 1 }),
        // Created just now, never opened: `lastUsed` is recent but that is creation time.
        card('55555555-5555-4555-8555-555555555555', 'Новая', 'TEST-NEW', { openedAt: 0, legacyTouchedAt: Date.now() })
      ];
      const { context, page } = await newSession(browser, { startParam: 'quick', seedCards: seed });
      await page.waitForSelector('.quick-card');
      const first = await page.locator('.quick-card-store').first().innerText();
      assert.equal(first, 'Магнит', 'an unopened card must never claim the first slot');
      await context.close();
    });

    await check('a legacy card keeps its data and gains empty, not invented, history', async () => {
      // Legacy shape: `lastUsed` only, which may well be the creation time.
      const seed = [{ id: '66666666-6666-4666-8666-666666666666', store: 'Старая', number: 'TEST-OLD',
        a: '#333', b: '#111', text: '#fff', lastUsed: 1700000000000, format: 'code_128', codeImage: null }];
      const { context, page } = await newSession(browser, { startParam: 'quick', seedCards: seed });
      await page.waitForSelector('#quickEmpty:not([hidden])');
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('kartochka.cards.v1'))[0]);
      assert.equal(stored.openedAt, 0, 'an old timestamp must not be promoted to a confirmed open');
      assert.equal(stored.legacyTouchedAt, 1700000000000, 'the old value must be preserved');
      assert.equal(stored.number, 'TEST-OLD', 'migration must not touch card contents');
      await context.close();
    });

    // ---- one tap to the code ---------------------------------------------
    await check('one tap on a card shows its code, and the open is recorded and synced', async () => {
      const id = '77777777-7777-4777-8777-777777777777';
      const seed = [card(id, 'Магнит', 'TEST-QUICK-1', { openedAt: 4000, legacyTouchedAt: 1 })];
      const { context, page, rows, opens } = await newSession(browser, { startParam: 'quick', seedCards: seed });
      rows.set(id, {
        user_id: user.id, id, store: 'Магнит', number: 'TEST-QUICK-1', color_a: '#333', color_b: '#111',
        text_color: '#fff', last_used: 1, last_opened_at: 4000, format: 'code_128',
        code_image: null, revision: 3, deleted_at: null
      });
      await page.waitForSelector('.quick-card');
      await page.locator('.quick-card').first().click();
      await page.waitForSelector('#cardOverlay:not([hidden])');
      assert.equal(await page.locator('#barcodeMount svg').count(), 1, 'a code must render on the first tap');
      assert.equal(await page.locator('#detailStore').innerText(), 'Магнит');

      await page.waitForFunction(() =>
        JSON.parse(localStorage.getItem('kartochka.cards.v1'))[0].openedAt > 4000);
      await page.waitForFunction(() => {
        const key = Object.keys(localStorage).find(k => k.startsWith('kartochka.card-opens.queue.v1'));
        return key && Object.keys(JSON.parse(localStorage.getItem(key))).length === 0;
      }, null, { timeout: 15000 });
      assert.equal(opens.length >= 1, true, 'the open must reach the server');
      assert.equal(rows.get(id).revision, 3, 'recording an open must not bump the content revision');
      await context.close();
    });

    await check('the compact sheet gets room for the code inside the same tap', async () => {
      const seed = [card('88888888-8888-4888-8888-888888888888', 'Лента', 'TEST-QUICK-2', { openedAt: 4000 })];
      const { context, page } = await newSession(browser, { startParam: 'quick', stableHeight: 380, seedCards: seed });
      await page.waitForSelector('.quick-card');
      await page.locator('.quick-card').first().click();
      await page.waitForSelector('#cardOverlay:not([hidden])');
      const tg = await page.evaluate(() => window.__tg);
      assert.equal(tg.expandCalls.length, 1, 'the short sheet must be expanded exactly once, by the tap itself');
      await context.close();
    });

    await check('a tall sheet is left alone', async () => {
      const seed = [card('99999999-9999-4999-8999-999999999999', 'Лента', 'TEST-QUICK-3', { openedAt: 4000 })];
      const { context, page } = await newSession(browser, { startParam: 'quick', stableHeight: 720, seedCards: seed });
      await page.waitForSelector('.quick-card');
      await page.locator('.quick-card').first().click();
      await page.waitForSelector('#cardOverlay:not([hidden])');
      assert.equal((await page.evaluate(() => window.__tg)).expandCalls.length, 0);
      await context.close();
    });

    // ---- navigation ------------------------------------------------------
    await check('"Все карты" opens the full list and the back button returns to quick', async () => {
      const seed = [card('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Магнит', 'TEST-NAV', { openedAt: 4000 })];
      const { context, page } = await newSession(browser, { startParam: 'quick', seedCards: seed });
      await page.waitForSelector('.quick-card');
      await page.locator('#quickAllCards').click();
      await page.waitForSelector('#allView.active');
      assert.equal(await page.locator('#quickScreen').isVisible(), false);
      assert.equal(await page.locator('#cardsGrid .grid-card').count(), 1, 'the full list must show the card');
      assert.equal((await page.evaluate(() => window.__tg)).backVisible, true, 'back must be offered');

      // Telegram's own back button must return to the compact screen: quick → all → quick.
      await page.evaluate(() => window.__tgBack());
      await page.waitForSelector('#quickScreen:not([hidden])');
      assert.equal(await page.locator('#quickScreen').isVisible(), true);

      // quick → card → quick, and the handler is never registered twice.
      await page.locator('.quick-card').first().click();
      await page.waitForSelector('#cardOverlay:not([hidden])');
      await page.evaluate(() => window.__tgBack());
      await page.waitForSelector('#cardOverlay', { state: 'hidden' });
      assert.equal(await page.locator('#quickScreen').isVisible(), true);
      assert.equal((await page.evaluate(() => window.__tg)).backHandlers, 1,
        'the BackButton handler must be registered exactly once');
      await context.close();
    });

    await check('an empty wallet offers adding a card instead of an empty list', async () => {
      const { context, page } = await newSession(browser, { startParam: 'quick', seedCards: [] });
      await page.waitForSelector('#quickEmpty:not([hidden])');
      assert.equal(await page.locator('#quickAllCards').innerText(), 'Добавить первую карту');
      await context.close();
    });

    await check('cards that exist but were never opened point at the full list', async () => {
      const seed = [card('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Лента', 'TEST-NONE', { openedAt: 0 })];
      const { context, page } = await newSession(browser, { startParam: 'quick', seedCards: seed });
      await page.waitForSelector('#quickEmpty:not([hidden])');
      assert.equal(await page.locator('#quickAllCards').innerText(), 'Все карты');
      assert.match(await page.locator('#quickEmptyText').innerText(), /Выберите карту/);
      await context.close();
    });

    // ---- compact layout --------------------------------------------------
    for (const [label, height, stable] of [
      ['narrow iPhone SE', 667, 360],
      ['standard iPhone', 844, 420],
      ['large iPhone', 932, 480],
      ['very short Telegram sheet', 844, 300],
      ['small Android', 640, 340]
    ]) {
      await check(`compact layout fits: ${label}`, async () => {
        const seed = [
          card('cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'Магнит', 'TEST-1', { openedAt: 3000 }),
          card('cccccccc-cccc-4ccc-8ccc-ccccccccccc2', 'Лента', 'TEST-2', { openedAt: 2000 }),
          card('cccccccc-cccc-4ccc-8ccc-ccccccccccc3', 'Пятёрочка', 'TEST-3', { openedAt: 1000 })
        ];
        const { context, page } = await newSession(browser, { startParam: 'quick', stableHeight: stable, seedCards: seed, height });
        await page.waitForSelector('.quick-card');
        const layout = await page.evaluate(() => {
          const screen = document.querySelector('#quickScreen').getBoundingClientRect();
          const button = document.querySelector('#quickAllCards').getBoundingClientRect();
          return {
            screenBottom: screen.bottom, screenHeight: screen.height,
            buttonBottom: button.bottom, buttonHeight: button.height,
            overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth
          };
        });
        // The primary action must sit fully inside the sheet Telegram actually granted.
        assert.ok(layout.buttonBottom <= layout.screenBottom + 1,
          `"Все карты" is clipped: button ${layout.buttonBottom} > screen ${layout.screenBottom}`);
        assert.ok(layout.buttonHeight >= 44, `tap target too small: ${layout.buttonHeight}px`);
        assert.ok(Math.abs(layout.screenHeight - stable) <= 1,
          `compact screen must follow the Telegram sheet height, got ${layout.screenHeight} for ${stable}`);
        assert.equal(layout.overflowX, 0, 'no horizontal scrolling');
        await context.close();
      });
    }

    if (failures.length) throw new Error(`${failures.length} quick-mode checks failed: ${failures.join(', ')}`);
    console.log('PASS Telegram quick mode: launch contract, open history, one-tap code and compact layout');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error('TELEGRAM QUICK MODE FAILURE', error);
  process.exitCode = 1;
});
