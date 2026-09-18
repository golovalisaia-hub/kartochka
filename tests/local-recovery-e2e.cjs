/* Recovery tests use an isolated local origin and synthetic card data only. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');
const root = path.resolve(__dirname, '..');
const mime = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
const server = http.createServer((req,res)=>{
  const pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname);
  const file = path.resolve(root, `.${pathname==='/'?'/index.html':pathname}`);
  if(!file.startsWith(root+path.sep)||!fs.existsSync(file)||!fs.statSync(file).isFile()){res.writeHead(404);res.end('Not found');return;}
  res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
let browser;
(async()=>{
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true});
  const context=await browser.newContext({serviceWorkers:'block',viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const url=`http://127.0.0.1:${server.address().port}/`;
  await page.goto(url,{waitUntil:'load'});
  await page.locator('#addCardHome').click();
  await page.locator('#openManual').click();
  await page.locator('#storeName').fill('Тестовая карта');
  await page.locator('#cardNumber').fill('RECOVERY-001');
  await page.locator('#cardForm button[type=submit]').click();
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('kartochka.cards.recovery.v1')||'[]').length===1);
  await page.waitForFunction(async()=>{
    const db=await new Promise((resolve,reject)=>{const request=indexedDB.open('kartochka-recovery-v1');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const value=await new Promise((resolve,reject)=>{const request=db.transaction('snapshots').objectStore('snapshots').get('active');request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    db.close();
    return JSON.parse(value||'[]').length===1;
  });
  console.log('PASS every card write creates localStorage and IndexedDB recovery copies');

  await page.evaluate(()=>localStorage.removeItem('kartochka.cards.v1'));
  await page.reload({waitUntil:'load'});
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('kartochka.cards.v1')||'[]')[0]?.number==='RECOVERY-001');
  assert.equal(await page.locator('#cardCountTop').innerText(),'1');
  console.log('PASS missing primary storage restores automatically from the local mirror');

  await page.evaluate(()=>{
    localStorage.removeItem('kartochka.cards.v1');
    localStorage.removeItem('kartochka.cards.recovery.v1');
  });
  await page.reload({waitUntil:'load'});
  await page.waitForFunction(()=>JSON.parse(localStorage.getItem('kartochka.cards.v1')||'[]')[0]?.number==='RECOVERY-001');
  assert.equal(JSON.parse(await page.evaluate(()=>localStorage.getItem('kartochka.cards.recovery.v1'))).length,1);
  console.log('PASS loss of both localStorage keys restores automatically from IndexedDB');

  await page.evaluate(async()=>{
    localStorage.setItem('kartochka.cards.v1','[]');
    localStorage.setItem('kartochka.cards.recovery.v1','[]');
    await window.KartochkaRecovery.save([]);
  });
  await page.reload({waitUntil:'load'});
  assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('kartochka.cards.v1'))),[]);
  assert.equal(await page.locator('#cardCountTop').innerText(),'0');
  console.log('PASS an intentional empty wallet is not resurrected from an old snapshot');
  assert.deepEqual(errors,[]);
  console.log('PASS no uncaught JavaScript errors');
})().catch(error=>{console.error('LOCAL RECOVERY TEST FAILURE',error);process.exitCode=1;}).finally(async()=>{await browser?.close();await new Promise(resolve=>server.close(resolve));});
