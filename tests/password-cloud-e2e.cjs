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
function session(id, email, refresh = `test-refresh-${id}`) {
  return { access_token:`test-access-${id}`, refresh_token:refresh, expires_in:3600, expires_at:Math.floor(Date.now()/1000)+3600, user:{ id, email } };
}
async function attachMock(context) {
  await context.route('https://cwiechastoocixpnobuy.supabase.co/**', async route => {
    const req = route.request();
    const u = new URL(req.url());
    const body = req.postDataJSON?.() || {};
    const token = req.headers().authorization || '';
    requests.push({ path:u.pathname, search:u.search, body, token });
    const ok = (json, status = 200) => route.fulfill({ status, contentType:'application/json', body:json == null ? '' : JSON.stringify(json) });
    if (u.pathname === '/auth/v1/otp') return ok({});
    if (u.pathname === '/auth/v1/verify') {
      const id = accounts[body.email];
      if (!id || body.token !== '123456' || body.type !== 'email') return ok({ message:'Token has expired or is invalid' }, 400);
      return ok(session(id, body.email));
    }
    if (u.pathname === '/auth/v1/token' && u.searchParams.get('grant_type') === 'refresh_token') {
      if (body.refresh_token === 'expired-invalid') return ok({ message:'Invalid Refresh Token' }, 401);
      const id = String(body.refresh_token || '').replace('test-refresh-', '');
      const email = Object.entries(accounts).find(([, value]) => value === id)?.[0];
      if (!email) return ok({ message:'Invalid Refresh Token' }, 401);
      return ok(session(id, email));
    }
    if (u.pathname === '/auth/v1/logout') return ok(null, 204);
    if (u.pathname === '/rest/v1/rpc/apply_card_change') {
      const id = token.replace('Bearer test-access-', '');
      if (!Object.values(accounts).includes(id)) return ok({ message:'Unauthenticated' }, 401);
      const current = remote.get(id) || [];
      const existing = current.find(row => row.id === body.p_card_id);
      const actualRevision = existing ? Number(existing.revision || 1) : 0;
      if (Number(body.p_expected_revision) !== actualRevision || (existing?.deleted_at && !body.p_delete)) {
        return ok({ code:'P0001', message:'SYNC_CONFLICT' }, 409);
      }
      if (body.p_delete) {
        if (!existing || existing.deleted_at) return ok({ code:'P0001', message:'SYNC_CONFLICT' }, 409);
        Object.assign(existing, { store:'Удалена', number:'0', code_image:null,
          deleted_at:new Date().toISOString(), revision:actualRevision + 1 });
      } else {
        const replacement = { ...(existing || {}), ...body.p_card,
          id:body.p_card_id, user_id:id, deleted_at:null, revision:actualRevision + 1 };
        remote.set(id, [...current.filter(row => row.id !== body.p_card_id), replacement]);
      }
      return ok({ revision:actualRevision + 1, deleted:Boolean(body.p_delete) });
    }
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
  return { context, page, errors };
}
async function login(page, email) {
  await page.locator('#accountButton').click();
  await page.locator('#authEmail').fill(email);
  await page.locator('#sendCodeButton').click();
  await page.locator('#codeForm').waitFor({ state:'visible' });
  await page.locator('#authCode').fill('123456');
  await page.locator('#verifyCodeButton').click();
  await page.waitForFunction(() => Boolean(window.KartochkaCloud?.user?.()?.id));
  await page.waitForFunction(() => !document.querySelector('#syncStatus')?.classList.contains('syncing'));
  await page.locator('[data-close="auth"]').click();
  await page.locator('#authOverlay').waitFor({ state:'hidden' });
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({headless:true});
  const url = `http://127.0.0.1:${server.address().port}/`;
  const a = await launchProfile(url);

  await a.page.locator('#accountButton').click();
  assert.equal(await a.page.locator('#emailForm').isVisible(), true);
  assert.equal(await a.page.locator('#codeForm').isVisible(), false);
  assert.equal(await a.page.locator('#authEmail').isVisible(), true);
  assert.equal(await a.page.locator('#authPassword').count(), 0);
  await a.page.locator('#authEmail').fill('owner@example.test');
  await a.page.locator('#sendCodeButton').click();
  await a.page.locator('#codeForm').waitFor({ state:'visible' });
  assert.ok(requests.some(r => r.path === '/auth/v1/otp' && r.body.email === 'owner@example.test' && r.body.create_user === true));
  await a.page.locator('#authCode').fill('123456');
  await a.page.locator('#verifyCodeButton').click();
  await a.page.waitForFunction(() => window.KartochkaCloud?.user?.()?.id === 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  assert.ok(requests.some(r => r.path === '/auth/v1/verify' && r.body.token === '123456' && r.body.type === 'email'));
  await a.page.locator('[data-close="auth"]').click();
  await a.page.locator('#authOverlay').waitFor({ state:'hidden' });
  console.log('PASS email -> one-time code -> signed-in session, no password field');

  await a.page.locator('#addCardHome').click();
  await a.page.locator('#openManual').click();
  await a.page.locator('#storeName').fill('Лента');
  await a.page.locator('#cardNumber').fill('CLOUD-FAKE-QR-001');
  await a.page.locator('#cardFormat').selectOption('qr_code');
  await a.page.locator('#cardForm button[type=submit]').click();
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
  console.log('PASS separate account cannot see owner card');

  // Temporary offline refresh must keep the current session and wallet intact.
  await a.page.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('kartochka.supabase-session.v1'));
    s.expires_at = Math.floor(Date.now()/1000)-30;
    localStorage.setItem('kartochka.supabase-session.v1', JSON.stringify(s));
  });
  await a.context.setOffline(true);
  const offlineResult = await a.page.evaluate(async () => {
    const before = localStorage.getItem('kartochka.cards.v1');
    const s = await window.KartochkaCloud.validSession();
    return { user:s?.user?.id || null, before, after:localStorage.getItem('kartochka.cards.v1') };
  });
  assert.equal(offlineResult.user, ownerId);
  assert.equal(offlineResult.after, offlineResult.before);
  await a.context.setOffline(false);
  console.log('PASS temporary offline session refresh does not erase cards');

  // A definitively invalid refresh token archives unsynced local cards before signing out.
  await a.page.evaluate(id => {
    const cards = JSON.parse(localStorage.getItem('kartochka.cards.v1') || '[]');
    cards.push({ id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc', store:'Магнит', number:'UNSYNCED-LOCAL-002', a:'#f00', b:'#900', text:'#fff', lastUsed:Date.now()+1000, format:'qr_code', codeImage:null });
    localStorage.setItem('kartochka.cards.v1', JSON.stringify(cards));
    const s = JSON.parse(localStorage.getItem('kartochka.supabase-session.v1'));
    s.expires_at = Math.floor(Date.now()/1000)-30;
    s.refresh_token = 'expired-invalid';
    localStorage.setItem('kartochka.supabase-session.v1', JSON.stringify(s));
    localStorage.setItem('kartochka.cloud-user.v1', id);
  }, ownerId);
  const invalid = await a.page.evaluate(async id => {
    const s = await window.KartochkaCloud.validSession();
    return {
      session:s,
      active:JSON.parse(localStorage.getItem('kartochka.cards.v1') || '[]'),
      cache:JSON.parse(localStorage.getItem(`kartochka.user-cache.v1.${id}`) || '[]')
    };
  }, ownerId);
  assert.equal(invalid.session, null);
  assert.equal(invalid.active.length, 0);
  assert.equal(invalid.cache.some(card => card.number === 'UNSYNCED-LOCAL-002'), true);
  console.log('PASS invalid session archives unsynced cards instead of deleting them');

  assert.deepEqual([...a.errors,...b.errors,...c.errors], []);
  await Promise.all([a.context.close(), b.context.close(), c.context.close()]);
})().catch(error => { console.error('FAIL', error); process.exitCode = 1; })
  .finally(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });