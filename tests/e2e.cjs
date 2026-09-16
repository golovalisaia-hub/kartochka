/* Browser checks run on an isolated localhost origin; never touch real user cards. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const QRCode = require('qrcode');
const root = path.resolve(__dirname, '..');
const types = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json', '.txt':'text/plain' };
const server = http.createServer((req,res)=>{
  const requested = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const file = path.resolve(root, `.${requested === '/' ? '/index.html' : requested}`);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404);res.end('Not found');return; }
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
const results = [];
let page, browser;
async function check(name, task) {
  try { await task(); results.push({ name, ok:true }); console.log(`PASS ${name}`); }
  catch(error) { results.push({ name, ok:false, error:error.message }); console.error(`FAIL ${name}: ${error.message}`); }
}
const stored = () => page.evaluate(()=>JSON.parse(localStorage.getItem('kartochka.cards.v1') || '[]'));
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser = await chromium.launch({ headless:true });
  const context = await browser.newContext({ viewport:{width:390,height:844},deviceScaleFactor:3,isMobile:true,hasTouch:true });
  page = await context.newPage();
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.setDefaultTimeout(9000);
  const origin = `http://127.0.0.1:${server.address().port}`;
  await page.goto(origin, {waitUntil:'load'});
  await check('Initial UI: empty wallet and no redundant top plus',async()=>{
    assert.equal(await page.locator('#quickAdd').isVisible(),false);
    assert.equal((await stored()).length,0);
    assert.equal(await page.locator('#addCardHome').isVisible(),true);
    assert.equal(await page.locator('#walletEmpty').isVisible(),true);
  });
  await check('Empty-wallet plus opens add methods',async()=>{
    await page.locator('#walletEmpty').click();
    assert.equal(await page.locator('#addOverlay').isVisible(),true);
  });
  await check('Russian store directory: priorities, search and selection',async()=>{
    await page.locator('#openManual').click();
    assert.equal(await page.locator('#manualOverlay').isVisible(),true);
    assert.deepEqual(await page.locator('#storeDirectoryResults .directory-choice').allTextContents(),['Лента','Магнит','Пятёрочка','Перекрёсток']);
    await page.locator('#storeDirectoryToggle').click();
    await page.locator('#storeDirectorySearch').fill('вкус');
    assert.ok((await page.locator('#storeDirectoryResults').innerText()).includes('ВкусВилл'));
    await page.locator('#storeDirectorySearch').fill('лента');
    await page.locator('#storeDirectoryResults .directory-choice').first().click();
    assert.equal(await page.locator('#storeName').inputValue(),'Лента');
  });
  await check('Add manual valid EAN-13, open barcode',async()=>{
    await page.locator('#cardNumber').fill('5901234123457');
    await page.locator('#cardFormat').selectOption('auto');
    await page.locator('#cardForm button[type=submit]').click();
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem('kartochka.cards.v1')||'[]').length===1);
    assert.equal((await stored())[0].format,'ean_13');
    await page.locator('.stack-card').first().click();
    assert.equal(await page.locator('#cardOverlay').isVisible(),true);
    assert.equal(await page.locator('#barcodeMount svg').count(),1);
    assert.equal(await page.locator('#barcodeMount .barcode-error').count(),0);
  });
  await check('Delete cancel preserves; confirm removes; reload stays deleted',async()=>{
    await page.locator('#deleteCard').click();
    await page.locator('#cancelDelete').click();
    assert.equal((await stored()).length,1);
    await page.locator('#deleteCard').click();
    await page.locator('#confirmDelete').click();
    assert.equal((await stored()).length,0);
    await page.reload({waitUntil:'load'});
    assert.equal((await stored()).length,0);
    assert.equal(await page.locator('#walletEmpty').isVisible(),true);
  });
  await check('Manual QR renders a real code and persists after reload',async()=>{
    await page.locator('#addCardHome').click();await page.locator('#openManual').click();
    await page.locator('#storeName').fill('Перекрёсток');
    await page.locator('#cardNumber').fill('KARTOCHKA-TEST-QR-001');
    await page.locator('#cardFormat').selectOption('qr_code');
    await page.locator('#cardForm button[type=submit]').click();
    assert.equal((await stored())[0].format,'qr_code');
    await page.reload({waitUntil:'load'});
    await page.locator('.stack-card').first().click();
    assert.equal(await page.locator('#barcodeMount .barcode-error').count(),0,'QR rendering failed');
    assert.equal(await page.locator('#barcodeMount svg').count(),1);
    await page.locator('#closeCard').click();
  });
  await check('Photo import decodes real QR and identifies filename brand',async()=>{
    const image=await QRCode.toBuffer('KARTOCHKA-PHOTO-QR-123',{width:700,margin:5});
    await page.locator('#addCardHome').click();
    await page.locator('#galleryInput').setInputFiles({name:'Магнит.png',mimeType:'image/png',buffer:image});
    await page.waitForFunction(()=>document.querySelector('#manualOverlay')?.hidden===false,{timeout:30000});
    assert.equal(await page.locator('#cardNumber').inputValue(),'KARTOCHKA-PHOTO-QR-123');
    assert.equal(await page.locator('#cardFormat').inputValue(),'qr_code');
    assert.equal(await page.locator('#storeName').inputValue(),'Магнит');
    await page.locator('#cardForm button[type=submit]').click();
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem('kartochka.cards.v1')||'[]').length===2);
    assert.equal((await stored())[1].format,'qr_code');
  });
  await check('Search and mobile viewport',async()=>{
    await page.locator('.nav-item[data-view=all]').click();
    await page.locator('#cardSearch').fill('Магнит');
    assert.equal(await page.locator('#cardsGrid .grid-card').count(),1);
    const width=await page.evaluate(()=>document.documentElement.scrollWidth);
    assert.ok(width<=390,`Horizontal overflow: ${width}`);
  });
  await check('No uncaught page JavaScript errors',async()=>{assert.deepEqual(errors,[]);});
  console.log(`RESULT: ${results.filter(x=>x.ok).length}/${results.length} passed`);
  if(results.some(x=>!x.ok))process.exitCode=1;
})().catch(error=>{console.error('FATAL',error);process.exitCode=1;}).finally(async()=>{await browser?.close();await new Promise(resolve=>server.close(resolve));});