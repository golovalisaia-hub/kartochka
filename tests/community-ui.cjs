/*
 * Раздел «Карты сообщества» и согласие владельца в интерфейсе.
 *
 * Сервер здесь подменён, но подменены именно ответы RPC — то есть проверяется ровно то,
 * что делает клиент, получив тот или иной вердикт. Клиент не должен показывать пул без
 * подтверждённого Premium, не должен включать общий доступ без явного подтверждения и не
 * должен показывать владельца выданной карты.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webmanifest': 'application/manifest+json'
};
const server = http.createServer((request, response) => {
  const route = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const target = path.resolve(root, `.${route === '/' ? '/index.html' : route}`);
  if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    response.writeHead(404); response.end(); return;
  }
  response.setHeader('Content-Type', types[path.extname(target)] || 'application/octet-stream');
  fs.createReadStream(target).pipe(response);
});

const user = {
  id: 'community-user', email: 'telegram-777@telegram.kartochka.invalid',
  email_confirmed_at: '2026-09-24T00:00:00.000Z',
  user_metadata: { auth_source: 'telegram', telegram_id: 777 }
};
const session = {
  access_token: 'community-token', refresh_token: 'community-refresh',
  expires_at: Math.floor(Date.now() / 1000) + 3600, user
};
const card = (id, store, number, extra = {}) => ({
  id, store, number, a: '#333', b: '#111', text: '#fff', lastUsed: 1,
  openedAt: 0, legacyTouchedAt: 1, format: 'code_128', codeImage: null, ...extra
});

async function open(browser, { rpc = {}, cards = [] } = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const calls = [];
  await page.addInitScript(() => {
    window.Telegram = { WebApp: {
      initData: 'signed', initDataUnsafe: { user: { id: 777, first_name: 'Т' } },
      viewportHeight: 800, viewportStableHeight: 800, isExpanded: true,
      safeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 },
      contentSafeAreaInset: { top: 0, bottom: 0, left: 0, right: 0 },
      ready() {}, expand() {}, onEvent() {}, offEvent() {},
      setHeaderColor() {}, setBackgroundColor() {}, enableClosingConfirmation() {},
      BackButton: { onClick() {}, show() {}, hide() {} }
    } };
  });
  await page.addInitScript(seed => {
    localStorage.setItem('kartochka.cards.v1', JSON.stringify(seed));
    localStorage.setItem('kartochka.demo-cleanup.v1', '1');
    localStorage.setItem('kartochka.cloud-user.v1', 'community-user');
  }, cards);

  await page.route('https://qtyqdlkmfojbebgxcqxl.supabase.co/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body, status = 200) =>
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/functions/v1/telegram') return json({ token_hash: 'h', type: 'magiclink' });
    if (url.pathname === '/auth/v1/verify' || url.pathname === '/auth/v1/token') return json(session);
    if (url.pathname === '/rest/v1/telegram_test_cards') {
      return json(cards.map(item => ({
        user_id: user.id, id: item.id, store: item.store, number: item.number,
        color_a: item.a, color_b: item.b, text_color: item.text, last_used: 1,
        last_opened_at: item.openedAt || 0, format: item.format, code_image: null,
        revision: 1, deleted_at: null
      })));
    }
    const rpcName = url.pathname.replace('/rest/v1/rpc/', '');
    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      calls.push({ rpc: rpcName, body: request.postDataJSON() });
      if (rpcName in rpc) return json(rpc[rpcName]);
      return json([]);
    }
    return json({}, 404);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
  return { context, page, calls };
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  const failures = [];
  const check = async (name, body) => {
    try { await body(); console.log(`  ok  ${name}`); }
    catch (error) { failures.push(name); console.error(`  FAIL ${name}\n       ${error.message}`); }
  };

  try {
    await check('без Premium показывается замок, а не список магазинов', async () => {
      const { context, page } = await open(browser, {
        rpc: { community_programs: { available: false, reason: null, programs: [] } }
      });
      await page.locator('.nav-item[data-view=community]').click();
      await page.waitForSelector('#communityLocked:not([hidden])');
      assert.match(await page.locator('#communityLocked').innerText(), /Premium — скоро/);
      assert.equal(await page.locator('#communityStores').isVisible(), false);
      await context.close();
    });

    await check('аварийное отключение показывает нейтральный текст', async () => {
      const { context, page } = await open(browser, {
        rpc: { community_programs: { available: true, reason: 'disabled', programs: [] } }
      });
      await page.locator('.nav-item[data-view=community]').click();
      await page.waitForSelector('#communityOff:not([hidden])');
      assert.match(await page.locator('#communityOff').innerText(), /временно недоступна/);
      await context.close();
    });

    await check('с Premium показываются магазины, но не владельцы', async () => {
      const { context, page } = await open(browser, {
        rpc: { community_programs: { available: true, reason: null, programs: [
          { program: 'x5_club', brand: 'pyaterochka', display_name: 'Пятёрочка', cards_available: 4 },
          { program: 'x5_club', brand: 'perekrestok', display_name: 'Перекрёсток', cards_available: 0 },
          { program: 'lenta', brand: 'lenta', display_name: 'Лента', cards_available: 2 }
        ] } }
      });
      await page.locator('.nav-item[data-view=community]').click();
      await page.waitForSelector('#communityStores:not([hidden])');
      const rows = await page.locator('.store-row').allInnerTexts();
      assert.equal(rows.length, 3);
      assert.ok(rows.some(text => /Пятёрочка/.test(text)));
      assert.ok(rows.some(text => /Лента/.test(text)));
      // Магазин без карт нельзя выбрать.
      assert.equal(await page.locator('.store-row').nth(1).isDisabled(), true);
      // Ни имён, ни идентификаторов владельцев на экране быть не может.
      const screen = await page.locator('#communityView').innerText();
      assert.doesNotMatch(screen, /@|owner|user_id|telegram_id/i);
      await context.close();
    });

    await check('выбор магазина выдаёт одну карту и не раскрывает владельца', async () => {
      const { context, page, calls } = await open(browser, {
        rpc: {
          community_programs: { available: true, reason: null, programs: [
            { program: 'x5_club', brand: 'pyaterochka', display_name: 'Пятёрочка', cards_available: 4 }
          ] },
          claim_shared_card: {
            status: 'served', session_id: 'sess-1', expires_at: new Date(Date.now() + 180000).toISOString(),
            card: { store: 'Пятёрочка', number: 'TEST-COMMUNITY-1', format: 'code_128',
                    code_image: null, color_a: '#2e9e4f', color_b: '#155c2c', text_color: '#fff' }
          }
        }
      });
      await page.locator('.nav-item[data-view=community]').click();
      await page.waitForSelector('.store-row');
      await page.locator('.store-row').first().click();
      await page.waitForSelector('#cardOverlay:not([hidden])');
      assert.equal(await page.locator('#barcodeMount svg').count(), 1, 'код обязан отрисоваться');
      assert.equal(await page.locator('#detailStore').innerText(), 'Пятёрочка');
      // Чужую карту нельзя удалить и нельзя включить для неё общий доступ.
      assert.equal(await page.locator('#deleteCard').isVisible(), false);
      assert.equal(await page.locator('#shareOffer').isVisible(), false);
      // Карта другого человека не попадает в кошелёк на устройстве.
      const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('kartochka.cards.v1') || '[]'));
      assert.equal(stored.some(item => item.number === 'TEST-COMMUNITY-1'), false,
        'чужая карта не должна сохраняться локально');
      const claim = calls.find(item => item.rpc === 'claim_shared_card');
      assert.equal(claim.body.p_program_key, 'x5_club');
      await context.close();
    });

    await check('отказ сервера не роняет экран и не раскрывает причину', async () => {
      const { context, page } = await open(browser, {
        rpc: {
          community_programs: { available: true, reason: null, programs: [
            { program: 'lenta', brand: 'lenta', display_name: 'Лента', cards_available: 1 }
          ] },
          claim_shared_card: { status: 'no_card' }
        }
      });
      await page.locator('.nav-item[data-view=community]').click();
      await page.waitForSelector('.store-row');
      await page.locator('.store-row').first().click();
      await page.waitForSelector('.toast.show');
      const message = await page.locator('.toast').innerText();
      assert.match(message, /нет доступных карт/i);
      assert.equal(await page.locator('#cardOverlay').isVisible(), false);
      await context.close();
    });

    // ------------------------------------------------ согласие владельца ----
    const shareCard = card('11111111-1111-4111-8111-111111111111', 'Пятёрочка', 'TEST-OWN-1', { openedAt: 5000 });
    const plainCard = card('22222222-2222-4222-8222-222222222222', 'Магнит', 'TEST-OWN-2', { openedAt: 4000 });

    await check('предложение поделиться появляется только для поддерживаемой программы', async () => {
      const { context, page } = await open(browser, {
        cards: [shareCard, plainCard],
        rpc: { owner_sharing_stats: { sharing_enabled: false, today: 0, week: 0, total: 0, last_served_at: null } }
      });
      await page.waitForSelector('.stack-card');
      await page.locator('.stack-card').first().click();
      await page.waitForSelector('#shareOffer:not([hidden])');
      assert.match(await page.locator('#shareOffer').innerText(), /Получайте больше пользы/);
      await page.locator('#closeCard').click();

      // Магнит в программах сообщества не участвует — предложения быть не должно.
      await page.locator('.nav-item[data-view=all]').click();
      await page.locator('#cardsGrid .grid-card').nth(1).click();
      await page.waitForSelector('#cardOverlay:not([hidden])');
      await page.waitForTimeout(300);
      assert.equal(await page.locator('#shareOffer').isVisible(), false);
      await context.close();
    });

    await check('включение требует явного подтверждения', async () => {
      const { context, page, calls } = await open(browser, {
        cards: [shareCard],
        rpc: {
          owner_sharing_stats: { sharing_enabled: false, today: 0, week: 0, total: 0, last_served_at: null },
          set_card_sharing: { shared_card_id: 'sc-1', sharing_enabled: true, program: 'x5_club' }
        }
      });
      await page.waitForSelector('.stack-card');
      await page.locator('.stack-card').first().click();
      await page.waitForSelector('#shareOffer:not([hidden])');

      // Первое нажатие только открывает подтверждение и ничего не включает.
      await page.locator('#shareEnable').click();
      await page.waitForSelector('#shareConfirmOverlay:not([hidden])');
      assert.equal(calls.some(item => item.rpc === 'set_card_sharing'), false,
        'общий доступ не должен включаться без подтверждения');
      const terms = await page.locator('#shareConfirmOverlay').innerText();
      assert.match(terms, /не показываются/);
      assert.match(terms, /отключить/);
      // Заранее отмеченных галочек быть не должно.
      assert.equal(await page.locator('#shareConfirmOverlay input[type=checkbox]:checked').count(), 0);

      // Отмена ничего не включает.
      await page.locator('#shareCancel').click();
      assert.equal(calls.some(item => item.rpc === 'set_card_sharing'), false);

      await page.locator('#shareEnable').click();
      await page.locator('#shareConfirm').click();
      await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('включён'));
      const applied = calls.find(item => item.rpc === 'set_card_sharing');
      assert.equal(applied.body.p_enabled, true);
      assert.equal(applied.body.p_program_key, 'x5_club');
      assert.equal(applied.body.p_brand_key, 'pyaterochka');
      await context.close();
    });

    await check('«?» объясняет смысл и ничего не обещает', async () => {
      const { context, page } = await open(browser, {
        cards: [shareCard],
        rpc: { owner_sharing_stats: { sharing_enabled: false, today: 0, week: 0, total: 0, last_served_at: null } }
      });
      await page.waitForSelector('.stack-card');
      await page.locator('.stack-card').first().click();
      await page.waitForSelector('#shareOffer:not([hidden])');
      await page.locator('#shareHelp').click();
      await page.waitForSelector('#shareHelpOverlay:not([hidden])');
      const text = await page.locator('#shareHelpOverlay').innerText();
      assert.match(text, /добровольно/);
      assert.match(text, /зависят от условий программы/);
      assert.match(text, /равномерно/);
      // Гарантий по баллам быть не должно.
      assert.doesNotMatch(text, /гарантир|бесплатные баллы|обязательно получите/i);
      await context.close();
    });

    await check('отказ запоминается и не повторяется при каждом открытии', async () => {
      const { context, page } = await open(browser, {
        cards: [shareCard],
        rpc: { owner_sharing_stats: { sharing_enabled: false, today: 0, week: 0, total: 0, last_served_at: null } }
      });
      await page.waitForSelector('.stack-card');
      await page.locator('.stack-card').first().click();
      await page.waitForSelector('#shareOffer:not([hidden])');
      await page.locator('#shareDismiss').click();
      assert.equal(await page.locator('#shareOffer').isVisible(), false);
      await page.locator('#closeCard').click();
      await page.locator('.stack-card').first().click();
      await page.waitForSelector('#cardOverlay:not([hidden])');
      await page.waitForTimeout(400);
      assert.equal(await page.locator('#shareOffer').isVisible(), false,
        'предложение не должно всплывать снова после отказа');
      await context.close();
    });

    await check('включённый доступ показывает агрегаты и кнопку отключения', async () => {
      const { context, page, calls } = await open(browser, {
        cards: [shareCard],
        rpc: {
          owner_sharing_stats: { sharing_enabled: true, today: 3, week: 17, total: 42,
                                 last_served_at: '2026-09-24T09:00:00.000Z' },
          set_card_sharing: { shared_card_id: 'sc-1', sharing_enabled: false, program: 'x5_club' }
        }
      });
      await page.waitForSelector('.stack-card');
      await page.locator('.stack-card').first().click();
      await page.waitForSelector('#shareStatus:not([hidden])');
      assert.equal(await page.locator('#shareToday').innerText(), '3');
      assert.equal(await page.locator('#shareWeek').innerText(), '17');
      assert.equal(await page.locator('#shareTotal').innerText(), '42');
      const block = await page.locator('#shareStatus').innerText();
      assert.match(block, /Показана сегодня/);
      // Формулировка «покупок» недопустима: данных кассы у приложения нет.
      assert.doesNotMatch(block, /покупк/i);
      assert.equal(await page.locator('#shareOffer').isVisible(), false);

      await page.locator('#shareDisable').click();
      await page.waitForFunction(() => document.querySelector('.toast')?.textContent.includes('отключён'));
      const applied = calls.find(item => item.rpc === 'set_card_sharing');
      assert.equal(applied.body.p_enabled, false);
      await context.close();
    });

    if (failures.length) throw new Error(`${failures.length} проверок провалено: ${failures.join(', ')}`);
    console.log('PASS сообщество: замок без Premium, выбор магазина, приватность и согласие владельца');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error('COMMUNITY UI FAILURE', error);
  process.exitCode = 1;
});
