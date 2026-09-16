/* Mock Supabase at the browser network layer: never create real accounts or upload personal cards. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.png':'image/png', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json' };
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.writeHead(404); res.end('Not found'); return; }
  res.setHeader('Content-Type', mime[path.extname(target)] || 'application/octet-stream');
  fs.createReadStream(target).pipe(res);
});
const ownerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const accounts = { 'owner@example.test': ownerId, 'other@example.test': otherId };
const remote = new Map();
const requests = [];
let browser;
async function attachMock(context) {
  await context.route('https://cwiechastoocixpnobuy.supabase.co/**', async route => {
    const req = route.request();
    const u = new URL(req.url());
    const body = req.postDataJSON?.() || {};
    const token = req.headers().authorization || '';
    requests.push({ path:u.pathname, search:u.search, body, token });
    const ok = (json, status = 200) => route.fulfill({ status, contentType:'application/json', body:JSON.stringify(json) });
    if (u.pathname === '/auth/v1/signup') return ok({ user:{ id:accounts[body.email] || ownerId, email:body.email }, session:null });
    if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'password') {
      const id = accounts[body.email];
      if (!id || body.password !== 'strong-test-password-123') return ok({ message:'Invalid login credentials' }, 400);
      return ok({ access_token:`test-access-${id}`, refresh_token:`test-refresh-${id}`, expires_in:3600, user:{ id, email:body.email } });
    }
    if (u.pathname === '/auth/v1/logout') return ok({}, 204);
    if (u.pathname === '/rest/v1/cards') {
      const id = token.replace('Bearer test-access-', '');
      if (!Object.values(accounts).includes(id)) return ok({ message:'Unauthenticated' }, 401);
      const rows = remote.get(id) || [];
      if (req.method() === 'GET') return ok(rows);
      if (req.method() === 'POST') {
        if (!Array.isArray(body) || body.some(row => row.user_id !== id)) return ok({ message:'RLS: wrong user' }, 403);
        const merged = new Map(rows.map(row => [row.id, row]));
        body.forEach(row => merged.set(row.id, row));
        remote.set(id, [...merged.values()]);
        return ok(null, 204);
      }
      if (req.method() === 'DELETE') {
        const cardId = u.searchParams.get('id')?.replace(/^eq\./, '');
        remote.set(id, rows.filter(row => row.id !== cardId));
        return ok(null, 204);
      }
    }
    return ok({ message:`Unexpected mock API request: ${u.pathname}` }, 404);
  });
}
async function launchProfile(url) {
  const context = await browser.newContext({ viewport:{width:390,height:844}, isMobile:true, hasTouch:true, serviceWorkers:'block' });
  await attachMock(context);
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url, { waitUntil:'load' });
  await page.locator('#authPassword').waitFor({ state:'attached' });
  return { context, page, errors };
}
async function login(page, email) {
  await page.locator('#accountButton').click();
  await page.locator('#authEmail').fill(email);
  await page.locator('#authPassword').fill('strong-test-password-123');
  await page.locator('#sendCodeButton').click();
  await page.waitForFunction(() => Boolean(window.KartochkaCloud?.user?.()?.id));
  await page.waitForFunction(() => !document.querySelector('#syncStatus')?.classList.contains('syncing'));
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({headless:true});
  const url = `http://127.0.0.1:${server.address().port}/`;
  const a = await launchProfile(url);
  assert.equal(await a.page.locator('#codeForm').isVisible(), false);
  await a.page.locator('#accountButton').click();
  assert.equal(await a.page.locator('#authPassword').isVisible(), true);
  assert.equal(await a.page.locator('#sendCodeButton').innerText(), 'Войти');
  await a.page.locator('#passwordAuthMode').click();
  assert.equal(await a.page.locator('#sendCodeButton').innerText(), 'Зарегистрироваться');
  await a.page.locator('#authEmail').fill('owner@example.test');
  await a.page.locator('#authPassword').fill('strong-test-password-123');
  await a.page.locator('#sendCodeButton').click();
  await a.page.locator('#passwordAuthMessage').waitFor({state:'visible'});
  assert.match(await a.page.locator('#passwordAuthMessage').innerText(), /подтвердите адрес/i);
  assert.ok(requests.some(r => r.path === '/auth/v1/signup' && r.body.password === 'strong-test-password-123'));
  assert.ok(!requests.some(r => r.path === '/auth/v1/otp'));
  assert.equal(await a.page.evaluate(() => localStorage.getItem('kartochka.supabase-session.v1')), null);
  console.log('PASS signup via email/password, confirmation prompt and no OTP/password storage');
  await a.page.locator('#authPassword').fill('strong-test-password-123');
  await a.page.locator('#sendCodeButton').click();
  await a.page.waitForFunction(() => window.KartochkaCloud?.user?.()?.id === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const snapshot = await a.page.evaluate(() => JSON.stringify(localStorage));
  assert.ok(!snapshot.includes('strong-test-password-123'));
  console.log('PASS password login, session stored without password');
  await a.page.locator('#addCardHome').click();
  await a.page.locator('#openManual').click();
  await a.page.locator('#storeName').fill('Лента');
  await a.page.locator('#cardNumber').fill('CLOUD-FAKE-QR-001');
  await a.page.locator('#cardFormat').selectOption('qr_code');
  await a.page.locator('#cardForm button[type=submit]').click();
  await a.page.waitForFunction(() => JSON.parse(localStorage.getItem('kartochka.cards.v1') || '[]').length === 1);
  await a.page.waitForFunction(() => document.querySelector('#syncStatus')?.classList.contains('syncing') === false && window.KartochkaCloud.user()?.id, {timeout:30000});
  await a.page.waitForTimeout(1200);
  assert.equal((remote.get(ownerId) || []).length, 1);
  console.log('PASS one test card uploaded under owner account');
  const b = await launchProfile(url);
  await login(b.page, 'owner@example.test');
  await b.page.waitForFunction(() => JSON.parse(localStorage.getItem('kartochka.cards.v1') || '[]').length === 1);
  assert.equal(await b.page.locator('#cardCountTop').innerText(), '1');
  console.log('PASS same-account second browser receives test card');
  const c = await launchProfile(url);
  await login(c.page, 'other@example.test');
  assert.equal(await c.page.locator('#cardCountTop').innerText(), '0');
  assert.equal((remote.get(otherId) || []).length, 0);
  assert.deepEqual([...new Set(requests.filter(r => r.path === '/rest/v1/cards').map(r => r.token.replace('Bearer test-access-', '')))].sort(), [ownerId,otherId]);
  assert.deepEqual([...a.errors,...b.errors,...c.errors], []);
  console.log('PASS separate account cannot see owner card in isolated profiles; no JS errors');
  await Promise.all([a.context.close(), b.context.close(), c.context.close()]);
})().catch(error => { console.error('FAIL', error); process.exitCode = 1; })
  .finally(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });