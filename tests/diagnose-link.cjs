const fs=require('fs'),http=require('http'),path=require('path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const server=http.createServer((req,res)=>{
  const name=path.resolve(root,'.'+(new URL(req.url,'http://localhost').pathname==='/'?'/index.html':new URL(req.url,'http://localhost').pathname));
  if(!name.startsWith(root+path.sep)||!fs.existsSync(name)){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html');fs.createReadStream(name).pipe(res);
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();
 try{
 const ctx=await browser.newContext({serviceWorkers:'block'});
 await ctx.route('https://cwiechastoocixpnobuy.supabase.co/**', route=>{console.log('REQUEST',route.request().method(),new URL(route.request().url()).pathname);return route.fulfill({status:200,contentType:'application/json',body:'{}'});});
 const page=await ctx.newPage();page.on('pageerror',e=>console.log('PAGEERROR',e.message));
 await page.goto('http://127.0.0.1:'+server.address().port+'/',{waitUntil:'load'});
 console.log('BOOT',await page.evaluate(()=>({setup:!!document.querySelector('#resendLink'),cloud:!!window.KartochkaCloud,available:window.KartochkaCloud?.configured?.(),send:document.querySelector('#sendCodeButton')?.textContent})));
 await page.locator('#accountButton').click();await page.locator('#authEmail').fill('owner@example.test');
 console.log('BEFORE',await page.evaluate(()=>({valid:document.querySelector('#emailForm').checkValidity(),overlay:document.querySelector('#authOverlay').hidden})));
 await page.locator('#sendCodeButton').click();await page.waitForTimeout(1000);
 console.log('AFTER',await page.evaluate(()=>({emailHidden:document.querySelector('#emailForm').hidden,codeHidden:document.querySelector('#codeForm').hidden,error:document.querySelector('#authError').textContent,button:document.querySelector('#sendCodeButton').textContent,cloud:window.KartochkaCloud?.configured?.()})));
 await ctx.close();}finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;server.close()});