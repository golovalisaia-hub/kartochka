/* Browser regression for temporary Magic Link mode. All accounts and cards are fake. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const origin = 'https://cwiechastoocixpnobuy.supabase.co';
const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const card = { id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc', store:'Тестовый магазин',
  number:'FAKE-CARD-001', a:'#245bd0', b:'#122d78', text:'#fff',
  lastUsed:1700000000000, format:'qr_code', codeImage:null };
const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json' };
const server = http.createServer((request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404); response.end('Not found'); return;
  }
  response.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(response);
});
const fragment = token => `#access_token=${token}&refresh_token=mock-refresh&expires_in=3600&token_type=bearer&type=magiclink`;
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless:true });
  const url = `http://127.0.0.1:${server.address().port}/`;
  let messages = 0;
  let uploads = 0;
  try {
    const context = await browser.newContext({ serviceWorkers:'block', viewport:{width:390,height:844} });
    await context.route(`${origin}/**`, route => {
      const request = route.request();
      const u = new URL(request.url());
      const respond = (value, status = 200) => route.fulfill({ status, contentType:'application/json', body:JSON.stringify(value) });
      if (u.pathname === '/auth/v1/otp') { messages++; return respond({}); }
      if (u.pathname === '/auth/v1/user') {
        const token = request.headers().authorization;
        if (token === 'Bearer owner-token') return respond({ id:owner, email:'owner@example.test' });
        if (token === 'Bearer other-token') return respond({ id:other, email:'other@example.test' });
        return respond({ message:'Invalid token' }, 401);
      }
      if (u.pathname === '/rest/v1/cards') return respond([]);
      if (u.pathname === '/rest/v1/rpc/apply_card_change') { uploads++; return respond({ revision:1, deleted:false }); }
      return respond({}, 204);
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url, { waitUntil:'load' });
    await page.locator('#resendLink').waitFor({state:'attached'});
    await page.locator('#accountButton').click();
    assert.match(await page.locator('#emailForm .auth-copy').innerText(), /ссылку/i);
    assert.equal(await page.locator('#sendCodeButton').innerText(), 'Получить ссылку');
    await page.locator('#authEmail').fill('owner@example.test');
    await page.locator('#sendCodeButton').click();
    await page.locator('#codeForm').waitFor({state:'visible'});
    assert.match(await page.locator('#codeForm .auth-copy').first().innerText(), /Откройте письмо/i);
    assert.equal(await page.locator('#authCode').isVisible(), false);
    assert.equal(await page.locator('#verifyCodeButton').isVisible(), false);
    assert.equal(await page.locator('#resendLink').isDisabled(), true);
    assert.equal(messages, 1);
    console.log('PASS link-only wording, accepted request is not claimed delivered, and resend is throttled');

    await page.evaluate(data => localStorage.setItem('kartochka.cards.v1', JSON.stringify([data])), card);
    await page.goto(url + fragment('owner-token'), {waitUntil:'load'});
    await page.waitForFunction(id => {
      const current = JSON.parse(localStorage.getItem('kartochka.supabase-session.v1') || 'null');
      return current?.user?.id === id && document.querySelector('#accountButton')?.classList.contains('signed-in');
    }, owner);
    assert.equal(await page.evaluate(() => location.hash), '');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('kartochka.cards.v1') || '[]').length), 1);
    await page.waitForFunction(() => document.querySelector('#cardCountTop')?.textContent === '1');
    assert.ok(uploads >= 1);
    console.log('PASS authentic link verified via /auth/v1/user; wallet persists across callback and reload');
    assert.deepEqual(errors, []);
    await context.close();

    const mismatchContext = await browser.newContext({serviceWorkers:'block'});
    await mismatchContext.route(`${origin}/**`, route => {
      const endpoint = new URL(route.request().url());
      if (endpoint.pathname === '/auth/v1/user') return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({id:other,email:'other@example.test'})});
      if (endpoint.pathname === '/rest/v1/cards' || endpoint.pathname.includes('apply_card_change')) {
        uploads++; return route.fulfill({status:200,contentType:'application/json',body:'[]'});
      }
      return route.fulfill({status:204,body:''});
    });
    const foreign = await mismatchContext.newPage();
    await foreign.goto(url, {waitUntil:'load'});
    await foreign.evaluate(({card,owner}) => {
      localStorage.setItem('kartochka.cards.v1', JSON.stringify([card]));
      localStorage.setItem('kartochka.cloud-user.v1', owner);
    }, {card,owner});
    const before = uploads;
    await foreign.goto(url + fragment('other-token'), {waitUntil:'load'});
    await foreign.locator('#authError').waitFor({state:'visible'});
    assert.match(await foreign.locator('#authError').innerText(), /другого аккаунта/);
    assert.equal(await foreign.evaluate(() => JSON.parse(localStorage.getItem('kartochka.cards.v1') || '[]').length), 1);
    assert.equal(await foreign.evaluate(() => localStorage.getItem('kartochka.cloud-user.v1')), owner);
    assert.equal(await foreign.evaluate(() => JSON.parse(localStorage.getItem('kartochka.supabase-session.v1') || 'null')?.user?.id || null), null);
    assert.equal(before, uploads);
    assert.equal(await foreign.evaluate(() => location.hash), '');
    console.log('PASS link to another account cannot mix, overwrite or upload existing wallet');
    await mismatchContext.close();

    const broken = await browser.newContext({serviceWorkers:'block'});
    const brokenPage = await broken.newPage();
    await brokenPage.goto(url, {waitUntil:'load'});
    await brokenPage.evaluate(data => localStorage.setItem('kartochka.cards.v1', JSON.stringify([data])),card);
    await brokenPage.goto(url + '#error=access_denied&error_description=invalid', {waitUntil:'load'});
    await brokenPage.locator('#authError').waitFor({state:'visible'});
    assert.equal(await brokenPage.evaluate(() => location.hash), '');
    assert.equal(await brokenPage.evaluate(() => JSON.parse(localStorage.getItem('kartochka.cards.v1') || '[]').length), 1);
    console.log('PASS failed link strips fragment and leaves existing cards untouched');
    await broken.close();
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode=1; server.close(); });