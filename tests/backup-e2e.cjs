/* All backup tests use an isolated local origin, never the user's wallet. */
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
  const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,acceptDownloads:true});
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'load'});
  await page.locator('#backupPanel').waitFor();
  const stored=()=>page.evaluate(()=>JSON.parse(localStorage.getItem('kartochka.cards.v1')||'[]'));
  await page.locator('#addCardHome').click();
  await page.locator('#openManual').click();
  await page.locator('#storeName').fill('Лента');
  await page.locator('#cardNumber').fill('5901234123457');
  await page.locator('#cardForm button[type=submit]').click();
  assert.equal((await stored()).length,1);
  await page.locator('.nav-item[data-view=design]').click();
  assert.match(await page.locator('#backupCount').innerText(),/1 карт/);
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#backupExport').click()]);
  const backup=JSON.parse(fs.readFileSync(await download.path(),'utf8'));
  assert.equal(backup.type,'kartochka-backup');
  assert.equal(backup.version,1);
  assert.equal(backup.cards.length,1);
  assert.equal(backup.cards[0].number,'5901234123457');
  console.log('PASS Download real JSON backup including exact barcode');
  const input=page.locator('#backupInput');
  const file=(name,data)=>({name,mimeType:'application/json',buffer:Buffer.from(data)});
  await input.setInputFiles(file('duplicate.json',JSON.stringify(backup)));
  assert.match(await page.locator('#backupStatus').innerText(),/Новых карт нет/);
  assert.equal((await stored()).length,1);
  console.log('PASS Existing cards are not duplicated');
  await input.setInputFiles(file('broken.json','{broken'));
  assert.match(await page.locator('#backupStatus').innerText(),/Восстановление не выполнено/);
  assert.equal((await stored()).length,1);
  console.log('PASS Invalid JSON cannot change saved cards');
  const malformed={type:'kartochka-backup',version:1,cards:[{store:'Опасная',number:'abc',format:'code_128',codeImage:'javascript:alert(1)'}]};
  await input.setInputFiles(file('unsafe.json',JSON.stringify(malformed)));
  assert.match(await page.locator('#backupStatus').innerText(),/неподдерживаемое изображение/);
  assert.equal((await stored()).length,1);
  console.log('PASS Unsupported image payload is rejected before writing');
  await page.evaluate(()=>localStorage.removeItem('kartochka.cards.v1'));
  await page.reload({waitUntil:'load'});
  await page.locator('#backupPanel').waitFor();
  await page.locator('.nav-item[data-view=design]').click();
  page.once('dialog',dialog=>dialog.accept());
  await Promise.all([
    page.waitForEvent('load'),
    page.locator('#backupInput').setInputFiles(file('restore.json',JSON.stringify(backup)))
  ]);
  assert.equal((await stored()).length,1);
  assert.equal((await stored())[0].store,'Лента');
  assert.equal((await stored())[0].number,'5901234123457');
  await page.locator('.stack-card').first().click();
  assert.equal(await page.locator('#barcodeMount svg').count(),1);
  console.log('PASS User-approved restore survives reload and opens barcode');
  assert.deepEqual(errors,[]);
  console.log('PASS No uncaught JavaScript errors');
})().catch(e=>{console.error('BACKUP TEST FAILURE',e);process.exitCode=1;}).finally(async()=>{await browser?.close();await new Promise(resolve=>server.close(resolve));});