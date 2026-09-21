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

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  const rows = new Map();
  const requests = [];
  const user = {
    id: 'telegram-test-user',
    email: 'telegram-424242@telegram.kartochka.invalid',
    email_confirmed_at: '2026-09-21T00:00:00.000Z',
    user_metadata: { auth_source: 'telegram', telegram_id: 424242 }
  };
  const session = {
    access_token: 'telegram-test-access-token',
    refresh_token: 'telegram-test-refresh-token',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user
  };
  async function waitForServer(predicate, message) {
    for (let attempt = 0; attempt < 160; attempt += 1) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(message);
  }

  await page.addInitScript(() => {
    window.Telegram = {
      WebApp: {
        initData: 'signed-test-init-data',
        initDataUnsafe: { user: { id: 424242, first_name: 'Тест', username: 'closed_test' } },
        ready() {},
        expand() {},
        setHeaderColor() {},
        setBackgroundColor() {}
      }
    };
  });

  await page.route('https://cwiechastoocixpnobuy.supabase.co/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push({ method: request.method(), path: url.pathname + url.search });
    if (url.pathname === '/functions/v1/telegram-login') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ token_hash: 'test-token-hash', type: 'magiclink' }) });
      return;
    }
    if (url.pathname === '/auth/v1/verify') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) });
      return;
    }
    if (url.pathname === '/rest/v1/telegram_test_cards' && request.method() === 'GET') {
      const active = [...rows.values()].filter(row => !row.deleted_at);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(active) });
      return;
    }
    if (url.pathname === '/rest/v1/rpc/apply_telegram_test_card_change') {
      const body = request.postDataJSON();
      const current = rows.get(body.p_card_id);
      const expected = Number(body.p_expected_revision || 0);
      if ((current && Number(current.revision) !== expected) || (!current && expected !== 0)) {
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ code: 'P0001', message: 'SYNC_CONFLICT' }) });
        return;
      }
      if (body.p_delete) {
        const deleted = { ...current, deleted_at: new Date().toISOString(), revision: expected + 1 };
        rows.set(body.p_card_id, deleted);
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revision: deleted.revision, deleted: true }) });
        return;
      }
      const card = body.p_card;
      const saved = {
        user_id: user.id,
        id: body.p_card_id,
        store: card.store,
        number: card.number,
        color_a: card.color_a,
        color_b: card.color_b,
        text_color: card.text_color,
        last_used: card.last_used,
        format: card.format,
        code_image: card.code_image,
        revision: expected + 1,
        deleted_at: null
      };
      rows.set(saved.id, saved);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ revision: saved.revision, deleted: false }) });
      return;
    }
    if (url.pathname === '/rest/v1/cards' || url.pathname === '/rest/v1/rpc/apply_card_change') {
      await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ message: 'production cards endpoint must not be used by Telegram' }) });
      return;
    }
    if (url.pathname === '/auth/v1/token') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) });
      return;
    }
    await route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelector('#accountDot')?.classList.contains('signed-in') ||
      document.querySelector('#syncStatus')?.classList.contains('online'));
    await page.locator('#addCardHome').click();
    await page.locator('#openManual').click();
    await page.locator('#storeName').fill('Магнит');
    await page.locator('#cardNumber').fill('TEST-QR-001');
    await page.locator('#cardFormat').selectOption('qr_code');
    await page.locator('#cardForm button[type=submit]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('kartochka.cards.v1') || '[]').length === 1);
    await waitForServer(() => rows.size === 1, 'Telegram test card was not uploaded');
    assert.equal(rows.size, 1);

    await page.locator('.stack-card').first().click();
    assert.equal(await page.locator('#barcodeMount svg').count(), 1);
    await page.locator('#cardEditButton').click();
    await page.locator('#editNumber').fill('TEST-QR-002');
    await page.locator('#cardEditForm button[type=submit]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('kartochka.cards.v1') || '[]')[0]?.number === 'TEST-QR-002');
    await waitForServer(() => rows.values().next().value?.number === 'TEST-QR-002', 'Telegram test card edit was not uploaded');
    assert.equal(rows.values().next().value.number, 'TEST-QR-002');

    await page.locator('.stack-card').first().click();
    await page.locator('#deleteCard').click();
    await page.locator('#confirmDelete').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('kartochka.cards.v1') || '[]').length === 0);
    await waitForServer(() => [...rows.values()][0]?.deleted_at, 'Telegram test card deletion was not uploaded');
    assert.equal([...rows.values()][0].deleted_at !== null, true);

    await page.reload({ waitUntil: 'load' });
    assert.equal(await page.locator('#walletEmpty').isVisible(), true);
    await page.locator('.nav-item[data-view=catalog]').click();
    assert.equal(await page.locator('#catalogTitle').innerText(), 'Каталог карт');
    assert.equal(await page.locator('#catalogPayment').isDisabled(), true);
    assert.equal(requests.some(item => item.path.includes('/rest/v1/cards')), false);
    console.log('PASS Telegram Mini App auth, isolated add/edit/delete/reload, barcode, catalog and payment-disabled flow');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => {
  console.error('TELEGRAM BROWSER E2E FAILURE', error);
  process.exitCode = 1;
});
