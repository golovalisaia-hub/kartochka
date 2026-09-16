/* Browser regression tests with fake accounts/cards only. No real emails or uploads. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const cardId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const clone = value => JSON.parse(JSON.stringify(value));
const row = number => ({
  user_id:id, id:cardId, store:'Лента', number, color_a:'#245bd0', color_b:'#122d78',
  text_color:'#fff', last_used:1700000000000, format:'qr_code', code_image:null,
  updated_at:'2026-09-16T20:00:00Z'
});
const local = number => ({ id:cardId, store:'Лента', number, a:'#245bd0', b:'#122d78',
  text:'#fff', lastUsed:1700000000000, format:'qr_code', codeImage:null });
const remote = [row('ORIGINAL-001')];
let rejectNetwork = false;
let rejectRefresh = false;
let writes = 0;
const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.png':'image/png', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const name = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : url.pathname));
  if (!name.startsWith(root + path.sep) || !fs.existsSync(name) || !fs.statSync(name).isFile()) { res.writeHead(404); res.end('Not found'); return; }
  res.setHeader('Content-Type', mime[path.extname(name)] || 'application/octet-stream');
  fs.createReadStream(name).pipe(res);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless:true });
  try {
    const context = await browser.newContext({ serviceWorkers:'block', viewport:{width:390,height:844} });
    await context.addInitScript(({ id }) => {
      const session = { access_token:'fake-token', refresh_token:'fake-refresh',
        expires_at:Math.floor(Date.now()/1000)+3600, user:{ id, email:'test@example.test' } };
      localStorage.setItem('kartochka.supabase-session.v1', JSON.stringify(session));
      localStorage.setItem('kartochka.cloud-user.v1', id);
    }, { id });
    await context.route('https://cwiechastoocixpnobuy.supabase.co/**', async route => {
      const req = route.request();
      const url = new URL(req.url());
      const reply = (value, status = 200) => route.fulfill({ status, contentType:'application/json', body:value == null ? '' : JSON.stringify(value) });
      if (url.pathname === '/auth/v1/token') {
        if (rejectRefresh) return reply({ message:'Invalid Refresh Token' }, 401);
        return reply({ access_token:'fake-token', refresh_token:'fake-refresh',
          expires_at:Math.floor(Date.now()/1000)+3600, user:{ id, email:'test@example.test' } });
      }
      if (url.pathname !== '/rest/v1/cards') return reply({}, 204);
      if (rejectNetwork) return reply({ message:'Temporary backend outage' }, 503);
      if (req.method() === 'GET') return reply(clone(remote));
      if (req.method() === 'POST') {
        writes++;
        const updated = req.postDataJSON();
        updated.forEach(card => {
          const pos = remote.findIndex(item => item.id === card.id);
          if (pos >= 0) remote[pos] = card;
          else remote.push(card);
        });
        return reply(null, 204);
      }
      if (req.method() === 'DELETE') { remote.splice(0, remote.length); return reply(null, 204); }
      return reply({}, 404);
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil:'load' });
    await page.waitForFunction(id => Boolean(localStorage.getItem(`kartochka.sync-baseline.v1.${id}`)), id);
    assert.equal(await page.locator('#cardCountTop').innerText(), '1');
    console.log('PASS first sync records a per-account baseline');

    // Device A changes the local card. Device B edits that same card in cloud.
    await page.evaluate(card => localStorage.setItem('kartochka.cards.v1', JSON.stringify([card])), local('DEVICE-A-002'));
    remote[0].number = 'DEVICE-B-003';
    const before = writes;
    const conflict = await page.evaluate(async () => {
      try { await window.KartochkaCloud.listCards(); return null; }
      catch (error) { return error.message; }
    });
    assert.match(conflict, /Конфликт изменений/);
    assert.equal(writes, before);
    assert.equal(remote[0].number, 'DEVICE-B-003');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('kartochka.cards.v1'))[0].number), 'DEVICE-A-002');
    await page.waitForFunction(() => document.querySelector('#syncStatus span')?.textContent.includes('Не все изменения'));
    console.log('PASS divergent card edits are blocked without overwriting either copy');

    // Even when the server changes AFTER the first GET, the second GET before writing must stop a stale upload.
    remote[0].number = 'ORIGINAL-001';
    await page.evaluate(async () => window.KartochkaCloud.listCards());
    remote[0].number = 'DEVICE-B-004';
    const stale = await page.evaluate(async card => {
      try { await window.KartochkaCloud.upsertCards([card]); return null; }
      catch (error) { return error.message; }
    }, local('DEVICE-A-002'));
    assert.match(stale, /Конфликт изменений/);
    assert.equal(remote[0].number, 'DEVICE-B-004');
    assert.equal(writes, before);
    console.log('PASS a change between download and upload blocks stale write');

    rejectNetwork = true;
    const network = await page.evaluate(async () => {
      try { await window.KartochkaCloud.listCards(); return false; } catch { return true; }
    });
    assert.equal(network, true);
    await page.waitForFunction(() => document.querySelector('#syncStatus span')?.textContent.includes('Не все изменения'));
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('kartochka.cards.v1'))[0].number), 'DEVICE-A-002');
    rejectNetwork = false;
    console.log('PASS server outage keeps local card and never labels it as synced');

    // A full storage device must not erase the wallet when a refresh token becomes invalid.
    rejectRefresh = true;
    const quota = await page.evaluate(async () => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('kartochka.user-cache.v1.')) throw new DOMException('Storage full', 'QuotaExceededError');
        return original.call(this, key, value);
      };
      try {
        const session = JSON.parse(localStorage.getItem('kartochka.supabase-session.v1'));
        session.expires_at = Math.floor(Date.now()/1000) - 30;
        original.call(localStorage, 'kartochka.supabase-session.v1', JSON.stringify(session));
        const result = await window.KartochkaCloud.validSession();
        return { retained:Boolean(result?.user?.id), cards:JSON.parse(localStorage.getItem('kartochka.cards.v1')) };
      } finally { Storage.prototype.setItem = original; }
    });
    assert.equal(quota.retained, true);
    assert.equal(quota.cards[0].number, 'DEVICE-A-002');
    assert.deepEqual(pageErrors, []);
    console.log('PASS failed recovery-copy write never erases cards on invalid session');
    await context.close();
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error('FAIL', error); process.exitCode = 1; });
