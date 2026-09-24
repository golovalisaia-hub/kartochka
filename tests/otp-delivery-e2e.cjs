/* Browser test for passwordless email UX. API responses are mocked: no real emails or user accounts. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const mime = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json' };
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({ serviceWorkers:'block' });
    let reject = false;
    let sent = 0;
    await ctx.route('https://qtyqdlkmfojbebgxcqxl.supabase.co/**', async route => {
      const req = route.request();
      const target = new URL(req.url());
      if (target.pathname === '/auth/v1/otp') {
        sent += 1;
        assert.equal(req.postDataJSON().create_user, true);
        return route.fulfill({ status:reject ? 403 : 200, contentType:'application/json', body:reject ? JSON.stringify({message:'Email address not authorized'}) : '{}' });
      }
      return route.fulfill({ status:404, contentType:'application/json', body:'{}' });
    });
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const url = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(url, { waitUntil:'load' });
    await page.locator('#resendCode').waitFor({state:'attached'});
    await page.locator('#accountButton').click();
    assert.match(await page.locator('#sendCodeButton').innerText(), /Получить код/);
    await page.locator('#authEmail').fill('test@example.test');
    await page.locator('#sendCodeButton').click();
    await page.locator('#codeForm').waitFor({state:'visible'});
    assert.match(await page.locator('#codeForm .auth-copy').first().innerText(), /Введите код из письма/);
    assert.match(await page.locator('#otpDeliveryHelp').innerText(), /доставка письма ещё не подтверждена/);
    assert.equal(await page.locator('#authCode').isEnabled(), true);
    assert.equal(await page.locator('#resendCode').isDisabled(), true);
    assert.match(await page.locator('#resendCode').innerText(), /Повторить через/);
    assert.equal(sent, 1);
    assert.equal(await page.locator('#authPassword').count(), 0);
    console.log('PASS OTP input remains enabled; delivery not falsely confirmed; resend throttled');

    reject = true;
    await page.reload({ waitUntil:'load' });
    await page.locator('#resendCode').waitFor({state:'attached'});
    await page.locator('#accountButton').click();
    await page.locator('#authEmail').fill('test@example.test');
    await page.locator('#sendCodeButton').click();
    await page.locator('#authError').waitFor({state:'visible'});
    assert.match(await page.locator('#authError').innerText(), /Supabase пока разрешает отправку только на почту участника проекта/);
    assert.equal(await page.locator('#codeForm').isVisible(), false);
    assert.equal(sent, 2);
    assert.deepEqual(pageErrors, []);
    console.log('PASS unauthorized email displays useful error; no false success and no page errors');
    await ctx.close();
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
