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
    const ctx = await browser.newContext({ serviceWorkers: 'block' });
    await ctx.route('https://qtyqdlkmfojbebgxcqxl.supabase.co/**', async route => {
      const u = new URL(route.request().url());
      if (u.pathname === '/auth/v1/user') {
        assert.match(route.request().headers().authorization || '', /^Bearer test-access-token$/);
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id:'user-magic-1', email:'test@example.test' }) });
      }
      if (u.pathname === '/rest/v1/cards') {
        if (route.request().method() === 'GET') return route.fulfill({ status:200, contentType:'application/json', body:'[]' });
        return route.fulfill({ status:201, contentType:'application/json', body:'[]' });
      }
      return route.fulfill({ status: 200, contentType:'application/json', body:'{}' });
    });

    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));
    const base = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(base + '#access_token=test-access-token&refresh_token=test-refresh-token&token_type=bearer&expires_in=3600&type=magiclink', { waitUntil:'load' });
    await page.waitForFunction(() => {
      try {
        const s = JSON.parse(localStorage.getItem('kartochka.supabase-session.v1') || 'null');
        return s?.user?.id === 'user-magic-1' && s?.access_token === 'test-access-token';
      } catch { return false; }
    }, null, { timeout: 15000 });
    await page.waitForFunction(() => !location.hash, null, { timeout: 15000 });
    const session = await page.evaluate(() => JSON.parse(localStorage.getItem('kartochka.supabase-session.v1')));
    assert.equal(session.user.email, 'test@example.test');
    assert.equal(session.refresh_token, 'test-refresh-token');
    assert.equal(await page.locator('#authPassword').count(), 0);
    assert.deepEqual(pageErrors, []);
    console.log('PASS magic link stores a cloud session, removes tokens from URL and keeps passwordless auth');
  } finally {
    await browser.close();
    server.close();
  }
})().catch(err => { console.error(err); process.exitCode = 1; });
