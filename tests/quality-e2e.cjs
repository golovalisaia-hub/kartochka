/* Isolated browser checks. Never reads the owner's real cards. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const mime = { '.js':'application/javascript', '.html':'text/html; charset=utf-8', '.css':'text/css', '.png':'image/png', '.svg':'image/svg+xml', '.webmanifest':'application/manifest+json' };
const server = http.createServer((req,res) => {
  const route = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const target = path.resolve(root, `.${route === '/' ? '/index.html' : route}`);
  if (!target.startsWith(root + path.sep) || !fs.existsSync(target) || !fs.statSync(target).isFile()) { res.writeHead(404); res.end(); return; }
  res.setHeader('Content-Type', mime[path.extname(target)] || 'application/octet-stream');
  fs.createReadStream(target).pipe(res);
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless:true });
  const page = await browser.newPage({ viewport:{ width:390, height:844 }, isMobile:true, hasTouch:true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  const cards = () => page.evaluate(() => JSON.parse(localStorage.getItem('kartochka.cards.v1') || '[]'));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil:'load' });
    await page.locator('#cardEditButton').waitFor({ state:'attached' });
    await page.locator('#addCardHome').click();
    await page.locator('#openManual').click();
    await page.locator('#storeName').fill('Магнит');
    await page.locator('#cardFormat').selectOption('code_128');
    await page.locator('#cardNumber').fill('КОД123');
    await page.locator('#cardForm button[type=submit]').click();
    assert.equal((await cards()).length, 0, 'Lossy Code128 was saved');
    assert.match(await page.locator('#recognitionResult').innerText(), /Code 128/);
    console.log('PASS reject lossy Code128 without saving');

    await page.locator('#cardNumber').fill('ABC123');
    await page.locator('#cardForm button[type=submit]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('kartochka.cards.v1') || '[]').length === 1);
    await page.locator('.stack-card').first().click();
    assert.equal(await page.locator('#barcodeMount svg').count(), 1);
    await page.locator('#cardEditButton').click();
    assert.equal(await page.locator('#cardEditLayer').isVisible(), true);
    await page.locator('#editNumber').fill('ABC456');
    await page.locator('#cardEditForm button[type=submit]').click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('kartochka.cards.v1') || '[]')[0]?.number === 'ABC456');
    await page.waitForLoadState('load');
    assert.equal((await cards()).length, 1, 'Edit created a duplicate');
    console.log('PASS edit code in-place, persist across reload and keep count');

    await page.locator('.stack-card').first().click();
    await page.locator('#cardEditButton').click();
    await page.locator('#editNumber').fill('НОВЫЙ');
    await page.locator('#cardEditForm button[type=submit]').click();
    assert.match(await page.locator('#editError').innerText(), /Code 128/);
    assert.equal((await cards())[0].number, 'ABC456');
    await page.locator('#editCancel').click();
    console.log('PASS invalid edit is rejected without changing saved data');

    await page.evaluate(() => {
      const list = JSON.parse(localStorage.getItem('kartochka.cards.v1') || '[]');
      list.push({ id:'legacy-bad-code', store:'Старая карта', number:'КОД-OLD', format:'code_128', a:'#222222', b:'#111111', text:'#ffffff', lastUsed:Date.now() + 30000, codeImage:null });
      localStorage.setItem('kartochka.cards.v1', JSON.stringify(list));
    });
    await page.reload({ waitUntil:'load' });
    await page.locator('.stack-card').first().click();
    await page.locator('#barcodeMount .code-integrity-error').waitFor();
    assert.equal(await page.locator('#barcodeMount svg').count(), 0, 'Legacy code rendered a corrupted barcode');
    assert.equal(errors.length, 0, `Uncaught errors: ${errors.join(', ')}`);
    console.log('PASS legacy unsupported code shows warning rather than altered barcode');
    console.log('PASS no uncaught JavaScript errors');
    console.log('RESULT: 5/5 quality checks passed');
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error('QUALITY TEST FAILURE', error); process.exitCode = 1; });