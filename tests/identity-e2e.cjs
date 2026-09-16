/* Isolated regression: never edit the wrong QR when one store has two cards. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const types = { '.html':'text/html; charset=utf-8', '.js':'application/javascript', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json' };
const server = http.createServer((req, res) => {
  const route = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const target = path.resolve(root, `.${route === '/' ? '/index.html' : route}`);
  if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', types[path.extname(target)] || 'application/octet-stream');
  fs.createReadStream(target).pipe(res);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless:true });
  const page = await browser.newPage({ viewport:{width:390,height:844}, isMobile:true,hasTouch:true });
  page.setDefaultTimeout(10000);
  const cards = () => page.evaluate(() => JSON.parse(localStorage.getItem('kartochka.cards.v1') || '[]'));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil:'load' });
    await page.locator('#cardEditButton').waitFor({ state:'attached' });
    for (const [index, number] of ['TEST-QR-1111','TEST-QR-2222'].entries()) {
      await page.locator('#addCardHome').click();
      await page.locator('#openManual').click();
      await page.locator('#storeName').fill('Магнит');
      await page.locator('#cardNumber').fill(number);
      await page.locator('#cardFormat').selectOption('qr_code');
      await page.locator('#cardForm button[type=submit]').click();
      await page.waitForFunction(expected => JSON.parse(localStorage.getItem('kartochka.cards.v1') || '[]').length === expected, index + 1);
    }
    const before = await cards();
    await page.locator('.nav-item[data-view=all]').click();
    await page.locator('#cardsGrid .grid-card').last().click();
    await page.locator('#cardEditButton').click();
    assert.equal(await page.locator('#editNumber').inputValue(), 'TEST-QR-1111', 'Opened the wrong QR card');
    await page.locator('#editNumber').fill('TEST-QR-3333');
    await page.locator('#cardEditForm button[type=submit]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('kartochka.cards.v1') || '[]').some(item => item.number === 'TEST-QR-3333'));
    await page.waitForLoadState('load');
    const after = await cards();
    assert.equal(after.length, 2);
    assert.equal(after.find(item => item.id === before[0].id).number, 'TEST-QR-3333');
    assert.equal(after.find(item => item.id === before[1].id).number, 'TEST-QR-2222');
    console.log('PASS editing older of two QR cards for same store changes only selected card');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error('IDENTITY TEST FAILURE', error); process.exitCode = 1; });