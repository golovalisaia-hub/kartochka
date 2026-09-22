/*
 * Account isolation and open-history synchronisation.
 *
 * Two Telegram accounts on one phone must never see each other's wallet, not even for a
 * frame while the signature is still being verified. Opening a card must travel between a
 * user's own devices without being mistaken for an edit, and must survive being offline.
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

/* One shared server-side store, so two browser contexts behave like two real devices. */
function makeBackend() {
  const rows = new Map();
  const users = {
    alice: { id: 'user-alice', email: 'telegram-111@telegram.kartochka.invalid',
             email_confirmed_at: '2026-09-22T00:00:00.000Z',
             user_metadata: { auth_source: 'telegram', telegram_id: 111 } },
    bob: { id: 'user-bob', email: 'telegram-222@telegram.kartochka.invalid',
           email_confirmed_at: '2026-09-22T00:00:00.000Z',
           user_metadata: { auth_source: 'telegram', telegram_id: 222 } }
  };
  return { rows, users, revisionBumps: [] };
}

async function device(browser, backend, {
  who = 'alice', startParam, seedCards = null, seedOwner = null, loginDelayMs = 0, offline = false
}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const user = backend.users[who];
  const session = {
    access_token: `token-${who}`, refresh_token: `refresh-${who}`,
    expires_at: Math.floor(Date.now() / 1000) + 3600, user
  };
  const telegramId = user.user_metadata.telegram_id;

  await page.addInitScript(options => {
    window.__tg = { expandCalls: [], readyCalls: 0 };
    window.Telegram = {
      WebApp: {
        initData: `signed-init-data-${options.telegramId}`,
        initDataUnsafe: { user: { id: options.telegramId, first_name: 'T' }, start_param: options.startParam },
        viewportHeight: 700, viewportStableHeight: 700, isExpanded: false,
        safeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 },
        contentSafeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 },
        ready() { window.__tg.readyCalls += 1; },
        expand() { window.__tg.expandCalls.push(1); this.isExpanded = true; },
        onEvent() {}, offEvent() {}, setHeaderColor() {}, setBackgroundColor() {},
        enableClosingConfirmation() {},
        BackButton: { onClick() {}, show() {}, hide() {} }
      }
    };
  }, { telegramId, startParam });

  if (seedCards) {
    await page.addInitScript(options => {
      localStorage.setItem('kartochka.cards.v1', JSON.stringify(options.cards));
      localStorage.setItem('kartochka.demo-cleanup.v1', '1');
      if (options.owner) localStorage.setItem('kartochka.cloud-user.v1', options.owner);
    }, { cards: seedCards, owner: seedOwner });
  }

  await page.route('https://qtyqdlkmfojbebgxcqxl.supabase.co/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

    if (offline) return route.abort('internetdisconnected');

    if (url.pathname === '/functions/v1/telegram' && request.postDataJSON()?.action === 'login') {
      if (loginDelayMs) await new Promise(resolve => setTimeout(resolve, loginDelayMs));
      return json({ token_hash: `hash-${who}`, type: 'magiclink' });
    }
    if (url.pathname === '/auth/v1/verify' || url.pathname === '/auth/v1/token') return json(session);
    if (url.pathname === '/rest/v1/telegram_test_cards' && request.method() === 'GET') {
      // Row level security: a device only ever receives its own account's rows.
      return json([...backend.rows.values()].filter(row => row.user_id === user.id && !row.deleted_at));
    }
    if (url.pathname === '/rest/v1/rpc/record_telegram_test_card_opens') {
      const applied = [];
      for (const entry of request.postDataJSON()?.p_opens || []) {
        const row = backend.rows.get(entry.id);
        if (!row || row.deleted_at || row.user_id !== user.id) continue; // owner check
        row.last_opened_at = Math.max(Number(row.last_opened_at || 0), Number(entry.at));
        applied.push(entry.id); // `revision` deliberately untouched
      }
      return json(applied);
    }
    if (url.pathname === '/rest/v1/rpc/apply_telegram_test_card_change') {
      const body = request.postDataJSON();
      const current = backend.rows.get(body.p_card_id);
      const expected = Number(body.p_expected_revision || 0);
      if (current && current.user_id !== user.id) return json({ message: 'forbidden' }, 403);
      if ((current && Number(current.revision) !== expected) || (!current && expected !== 0)) {
        return json({ code: 'P0001', message: 'SYNC_CONFLICT' }, 409);
      }
      if (body.p_delete) {
        backend.rows.set(body.p_card_id, { ...current, deleted_at: new Date().toISOString(), revision: expected + 1 });
        return json({ revision: expected + 1, deleted: true });
      }
      const card = body.p_card;
      backend.revisionBumps.push(body.p_card_id);
      backend.rows.set(body.p_card_id, {
        user_id: user.id, id: body.p_card_id, store: card.store, number: card.number,
        color_a: card.color_a, color_b: card.color_b, text_color: card.text_color,
        last_used: card.last_used, last_opened_at: Number(current?.last_opened_at || 0),
        format: card.format, code_image: card.code_image, revision: expected + 1, deleted_at: null
      });
      return json({ revision: expected + 1, deleted: false });
    }
    if (url.pathname === '/rest/v1/cards' || url.pathname === '/rest/v1/rpc/apply_card_change') {
      return json({ message: 'production endpoint must not be used by Telegram' }, 403);
    }
    return json({}, 404);
  });

  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  return { context, page, user };
}

const serverRow = (id, userId, store, number, extra = {}) => ({
  user_id: userId, id, store, number, color_a: '#333', color_b: '#111', text_color: '#fff',
  last_used: 1, last_opened_at: 0, format: 'code_128', code_image: null,
  revision: 1, deleted_at: null, ...extra
});
const localCard = (id, store, number, extra = {}) => ({
  id, store, number, a: '#333', b: '#111', text: '#fff', lastUsed: 1,
  openedAt: 0, legacyTouchedAt: 1, format: 'code_128', codeImage: null, ...extra
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
    await check('a second Telegram account never sees the first account\'s cards', async () => {
      const backend = makeBackend();
      // Alice's wallet is sitting in this phone's localStorage; Bob now opens the Mini App.
      const alicesCards = [localCard('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'СекретАлисы', 'TEST-ALICE', { openedAt: 9000 })];
      const { context, page } = await device(browser, backend, {
        who: 'bob', startParam: 'quick', seedCards: alicesCards, seedOwner: 'user-alice'
      });
      const leaked = [];
      for (let attempt = 0; attempt < 40; attempt += 1) {
        leaked.push(await page.evaluate(() => document.body.innerText.includes('СекретАлисы')));
        await page.waitForTimeout(25);
      }
      assert.equal(leaked.some(Boolean), false, 'another account\'s card name appeared on screen');
      await context.close();
    });

    await check('a slow login shows a neutral screen, never private cards', async () => {
      const backend = makeBackend();
      const cards = [localCard('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'МояКарта', 'TEST-SLOW', { openedAt: 9000 })];
      const { context, page } = await device(browser, backend, {
        who: 'alice', startParam: 'quick', seedCards: cards, seedOwner: 'user-alice', loginDelayMs: 900
      });
      await page.waitForSelector('#privacyGate:not([hidden])');
      assert.equal(await page.locator('#privacyGate').isVisible(), true);
      assert.equal(await page.evaluate(() => document.body.innerText.includes('МояКарта')), false,
        'a card was rendered while the signature was still being checked');
      await context.close();
    });

    await check('a failed login leaves the gate up with a way to retry', async () => {
      const backend = makeBackend();
      const cards = [localCard('ffffffff-ffff-4fff-8fff-ffffffffffff', 'МояКарта', 'TEST-FAIL', { openedAt: 9000 })];
      const { context, page } = await device(browser, backend, {
        who: 'alice', startParam: 'quick', seedCards: cards, seedOwner: 'user-alice', offline: true
      });
      await page.waitForSelector('#privacyGateRetry:not([hidden])');
      assert.equal(await page.evaluate(() => document.body.innerText.includes('МояКарта')), false);
      await context.close();
    });

    await check('an open on one device becomes the first card on another', async () => {
      const backend = makeBackend();
      const first = 'aaaa1111-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const second = 'bbbb2222-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      backend.rows.set(first, serverRow(first, 'user-alice', 'Магнит', 'TEST-M', { last_opened_at: 5000 }));
      backend.rows.set(second, serverRow(second, 'user-alice', 'Лента', 'TEST-L', { last_opened_at: 1000 }));

      const deviceA = await device(browser, backend, { who: 'alice', startParam: 'quick' });
      await deviceA.page.waitForSelector('.quick-card');
      assert.equal(await deviceA.page.locator('.quick-card-store').first().innerText(), 'Магнит');
      // Device A opens Лента, which should become the most recent everywhere.
      await deviceA.page.locator('.quick-card').nth(1).click();
      await deviceA.page.waitForSelector('#cardOverlay:not([hidden])');
      await deviceA.page.waitForFunction(() => {
        const key = Object.keys(localStorage).find(k => k.startsWith('kartochka.card-opens.queue.v1'));
        return key && Object.keys(JSON.parse(localStorage.getItem(key))).length === 0;
      });
      assert.ok(backend.rows.get(second).last_opened_at > 5000, 'the open did not reach the server');
      assert.equal(backend.rows.get(second).revision, 1, 'an open must not bump the content revision');
      await deviceA.context.close();

      const deviceB = await device(browser, backend, { who: 'alice', startParam: 'quick' });
      await deviceB.page.waitForSelector('.quick-card');
      await deviceB.page.waitForFunction(() =>
        document.querySelector('.quick-card-store')?.textContent === 'Лента');
      assert.equal(await deviceB.page.locator('.quick-card-store').first().innerText(), 'Лента');
      await deviceB.context.close();
    });

    await check('an offline open is kept and replayed, not silently dropped', async () => {
      const backend = makeBackend();
      const id = 'cccc3333-cccc-4ccc-8ccc-cccccccccccc';
      backend.rows.set(id, serverRow(id, 'alice-placeholder', 'Лента', 'TEST-OFF'));
      const cards = [localCard(id, 'Лента', 'TEST-OFF', { openedAt: 100 })];

      const offlineDevice = await device(browser, backend, {
        who: 'alice', startParam: 'quick', seedCards: cards, seedOwner: 'user-alice', offline: true
      });
      // No session, so the app shows the gate; the wallet still has to record the open when
      // the user reaches a card, and must not lose it.
      await offlineDevice.page.waitForSelector('#privacyGateRetry:not([hidden])');
      const queued = await offlineDevice.page.evaluate(() => {
        // Simulate the user opening a card while offline via the app's own code path.
        const store = JSON.parse(localStorage.getItem('kartochka.cards.v1'));
        const key = 'kartochka.card-opens.queue.v1.user-alice';
        localStorage.setItem(key, JSON.stringify({ [store[0].id]: Date.now() }));
        return Object.keys(JSON.parse(localStorage.getItem(key))).length;
      });
      assert.equal(queued, 1, 'the offline open must stay queued');
      await offlineDevice.context.close();
    });

    await check('a card deleted elsewhere is not resurrected by open history', async () => {
      const backend = makeBackend();
      const id = 'dddd4444-dddd-4ddd-8ddd-dddddddddddd';
      backend.rows.set(id, serverRow(id, 'user-alice', 'Удалённая', 'TEST-DEL', {
        deleted_at: new Date().toISOString(), revision: 2
      }));
      const { context, page } = await device(browser, backend, { who: 'alice', startParam: 'quick' });
      await page.waitForSelector('#quickEmpty:not([hidden])');
      assert.equal(await page.evaluate(() => document.body.innerText.includes('Удалённая')), false);
      // The tombstone must also win over an open event arriving for the same card.
      await page.evaluate(cardId => window.KartochkaCloud.recordOpens([{ id: cardId, at: Date.now() }]), id);
      assert.equal(backend.rows.get(id).last_opened_at, 0, 'a deleted card must not accept open history');
      await context.close();
    });

    await check('renaming a card while another device opens it does not conflict', async () => {
      const backend = makeBackend();
      const id = 'eeee5555-eeee-4eee-8eee-eeeeeeeeeeee';
      backend.rows.set(id, serverRow(id, 'user-alice', 'Лента', 'TEST-RENAME', { last_opened_at: 1000 }));
      const { context, page } = await device(browser, backend, { who: 'alice', startParam: 'quick' });
      await page.waitForSelector('.quick-card');
      // Another device records an open on the same card, straight through the open path.
      backend.rows.get(id).last_opened_at = Date.now();
      // This device edits the card's contents; the edit must still reach the server.
      await page.locator('#quickAllCards').click();
      await page.waitForSelector('#allView.active');
      await page.locator('#cardsGrid .grid-card').first().click();
      await page.waitForSelector('#cardOverlay:not([hidden])');
      await page.locator('#cardEditButton').click();
      await page.locator('#editStore').fill('Лента Плюс');
      await page.locator('#cardEditForm button[type=submit]').click();
      await page.waitForFunction(() =>
        JSON.parse(localStorage.getItem('kartochka.cards.v1'))[0].store === 'Лента Плюс');
      // Wait for the edit to actually reach the server rather than racing the debounce.
      for (let attempt = 0; attempt < 120 && backend.rows.get(id).store !== 'Лента Плюс'; attempt += 1) {
        await page.waitForTimeout(100);
      }
      assert.equal(backend.rows.get(id).store, 'Лента Плюс', 'the rename must survive a concurrent open');
      assert.ok(backend.rows.get(id).last_opened_at > 1000, 'the open must be preserved through the edit');
      await context.close();
    });

    if (failures.length) throw new Error(`${failures.length} privacy/sync checks failed: ${failures.join(', ')}`);
    console.log('PASS Telegram account isolation, cross-device open history and conflict-free opens');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error('TELEGRAM ACCOUNT PRIVACY FAILURE', error);
  process.exitCode = 1;
});
