/* Isolated browser checks; no access to the owner's cards or Supabase. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const QRCode = require('qrcode');
const root = path.resolve(__dirname, '..');
const mime = { '.html':'text/html; charset=utf-8', '.js':'application/javascript', '.css':'text/css', '.png':'image/png', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json' };
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  const target = path.resolve(root, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
  if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) {
    response.writeHead(404); response.end('Not found'); return;
  }
  response.setHeader('Content-Type', mime[path.extname(target)] || 'application/octet-stream');
  fs.createReadStream(target).pipe(response);
});
let browser;
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless:true });
  const context = await browser.newContext({ viewport:{ width:390, height:844 }, isMobile:true, hasTouch:true });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.goto(`http://127.0.0.1:${server.address().port}`, { waitUntil:'load' });

  const catalog = await page.evaluate(() => {
    const stores = window.KartochkaDirectory.stores;
    return { count:stores.length, missing:stores.filter(name => window.KartochkaScanner.findBrand(`Скидочная карта ${name}`) !== name) };
  });
  assert.equal(catalog.count, 53, 'Store catalog changed: update the test');
  assert.deepEqual(catalog.missing, [], `Unrecognized stores: ${catalog.missing.join(', ')}`);
  console.log('PASS: all 53 directory stores are recognized');

  const aliases = await page.evaluate(() => ['Магнит.png', 'fixprice.jpg', 'MVIDEO.jpeg', 'Спортмастер.jpeg', 'metro cash.png', 'moy.magnit.ru'].map(name => window.KartochkaScanner.findBrand(name)));
  assert.deepEqual(aliases, ['Магнит','Fix Price','М.Видео','Спортмастер','METRO','Магнит']);
  assert.equal(await page.evaluate(() => window.KartochkaScanner.findBrand('photo_123.jpg')), null);
  console.log('PASS: filename/transliteration aliases, unknown store stays unknown');

  async function upload(value, filename) {
    const buffer = await QRCode.toBuffer(value, { width:700, margin:5 });
    await page.locator('#addCardHome').click();
    await page.locator('#galleryInput').setInputFiles({ name:filename, mimeType:'image/png', buffer });
    await page.locator('#manualOverlay').waitFor({ state:'visible', timeout:30000 });
    await page.waitForFunction(expected => document.querySelector('#cardNumber').value === expected, value, { timeout:30000 });
    assert.equal(await page.locator('#cardFormat').inputValue(), 'qr_code');
  }

  await upload('BRAND-QR-FIXPRICE-01', 'fixprice.png');
  assert.equal(await page.locator('#storeName').inputValue(), 'Fix Price');
  await page.locator('#cardForm button[type=submit]').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('kartochka.cards.v1') || '[]').length === 1);
  assert.equal(await page.evaluate(() => window.KartochkaScanner.knownBrand('BRAND-QR-FIXPRICE-01')), 'Fix Price');
  console.log('PASS: photo import, QR symbology, saved brand memory');

  await page.evaluate(() => { window.TextDetector = class { async detect() { return [{ rawValue:'DNS магазин' }]; } }; });
  await upload('BRAND-QR-DNS-02', 'IMG_123.png');
  assert.equal(await page.locator('#storeName').inputValue(), 'DNS');
  await page.locator('[data-close="manual"]').first().click();
  console.log('PASS: store found in photo OCR with an anonymous filename');

  await page.evaluate(() => { window.TextDetector = class { async detect() { return [{ rawValue:'Нет названия магазина' }]; } }; });
  await upload('BRAND-QR-UNKNOWN-03', 'IMG_456.png');
  assert.equal(await page.locator('#storeName').inputValue(), '');
  assert.match(await page.locator('#recognitionResult').innerText(), /Выберите магазин/);
  console.log('PASS: unknown brand requires confirmation instead of guessing');
  assert.deepEqual(errors, [], `JavaScript errors: ${errors.join('; ')}`);
  console.log('PASS: no uncaught JavaScript errors');
})().catch(error => { console.error('FAIL', error); process.exitCode = 1; })
  .finally(async () => { await browser?.close(); await new Promise(resolve => server.close(resolve)); });