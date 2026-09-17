const fs=require('fs'),http=require('http'),path=require('path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const owner='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const server=http.createServer((req,res)=>{
  const name=path.resolve(root,'.'+(new URL(req.url,'http://localhost').pathname==='/'?'/index.html':new URL(req.url,'http://localhost').pathname));
  if(!name.startsWith(root+path.sep)||!fs.existsSync(name)){res.writeHead(404);return res.end();}
  res.setHeader('Content-Type',name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html');fs.createReadStream(name).pipe(res);
});
(async()=>{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch();
 try{
 const ctx=await browser.newContext({serviceWorkers:'block'});
 await ctx.route('https://cwiechastoocixpnobuy.supabase.co/**', route=>{
   const req=route.request(),endpoint=new URL(req.url()).pathname;
   console.log('REQUEST',req.method(),endpoint);
   const body=endpoint==='/auth/v1/user'?JSON.stringify({id:owner,email:'owner@example.test'}):endpoint.startsWith('/rest/v1/cards')?'[]':endpoint.includes('apply_card_change')?'{"revision":1,"deleted":false}':'{}';
   return route.fulfill({status:200,contentType:'application/json',body});
 });
 const page=await ctx.newPage();page.on('pageerror',e=>console.log('PAGEERROR',e.message));
 const url='http://127.0.0.1:'+server.address().port+'/';
 await page.goto(url,{waitUntil:'load'});
 console.log('BOOT',await page.evaluate(()=>({setup:!!document.querySelector('#resendLink'),cloud:!!window.KartochkaCloud,available:window.KartochkaCloud?.configured?.(),send:document.querySelector('#sendCodeButton')?.textContent})));
 await page.locator('#accountButton').click();await page.locator('#authEmail').fill('owner@example.test');
 await page.locator('#sendCodeButton').click();await page.waitForTimeout(350);
 console.log('EMAIL',await page.evaluate(()=>({emailHidden:document.querySelector('#emailForm').hidden,codeHidden:document.querySelector('#codeForm').hidden,error:document.querySelector('#authError').textContent})));
 await page.evaluate(()=>localStorage.setItem('kartochka.cards.v1',JSON.stringify([{id:'cccccccc-cccc-4ccc-8ccc-cccccccccccc',store:'Тестовый магазин',number:'FAKE-001',a:'#245bd0',b:'#122d78',text:'#fff',lastUsed:1700000000000,format:'qr_code',codeImage:null}])));
 await page.goto(url+'#access_token=owner-token&refresh_token=mock-refresh&expires_in=3600&token_type=bearer&type=magiclink',{waitUntil:'load'});
 await page.waitForTimeout(2300);
 console.log('CALLBACK',await page.evaluate(()=>({hasHash:Boolean(location.hash),sessionUser:JSON.parse(localStorage.getItem('kartochka.supabase-session.v1')||'null')?.user?.id||null,cloudUser:window.KartochkaCloud?.user?.()?.id||null,owner:localStorage.getItem('kartochka.cloud-user.v1'),cards:JSON.parse(localStorage.getItem('kartochka.cards.v1')||'[]').length,signed:document.querySelector('#accountButton')?.classList.contains('signed-in'),authError:document.querySelector('#authError')?.textContent,backup:!!sessionStorage.getItem('kartochka.magic-link-backup.v1')})));
 await ctx.close();}finally{await browser.close();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;server.close()});