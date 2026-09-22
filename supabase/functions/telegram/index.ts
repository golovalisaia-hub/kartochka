import { inspectWebAppUrl } from '../_shared/telegram.ts';
import { onboardingAction, onboardingPage } from '../_shared/bot-onboarding.ts';
const U=Deno.env.get('SUPABASE_URL')||'',K=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'',E=new TextEncoder();
const C=r=>{const o=r.headers.get('origin')||'',u=Deno.env.get('TELEGRAM_WEB_APP_URL')||'';let a='*';try{const x=new URL(u).origin;a=o===x||/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o)?o:x}catch(_){if(o)a=o}return{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':a,'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin'}};
const J=(b,s=200,h={})=>new Response(JSON.stringify(b),{status:s,headers:{...h,'Content-Type':'application/json; charset=utf-8'}});
const H=async(k,v)=>{const x=await crypto.subtle.importKey('raw',typeof k==='string'?E.encode(k):k,{name:'HMAC',hash:'SHA-256'},false,['sign']);return new Uint8Array(await crypto.subtle.sign('HMAC',x,E.encode(v)))};
const hex=x=>Array.from(x,b=>b.toString(16).padStart(2,'0')).join('');
async function verify(s){const t=Deno.env.get('TELEGRAM_BOT_TOKEN')||'';if(typeof s!=='string'||s.length<20||s.length>8192||!t)throw Error('Invalid Telegram initData');const m=new Map();for(const p of s.split('&')){const i=p.indexOf('=');if(i<1)throw Error('Malformed Telegram initData');const k=decodeURIComponent(p.slice(0,i).replace(/\+/g,' ')),v=decodeURIComponent(p.slice(i+1).replace(/\+/g,' '));if(m.has(k))throw Error('Duplicate Telegram initData field');m.set(k,v)}const got=(m.get('hash')||'').toLowerCase();if(!/^[a-f0-9]{64}$/.test(got))throw Error('Invalid Telegram signature');m.delete('hash');const d=Number(m.get('auth_date')),n=Math.floor(Date.now()/1000);if(!Number.isSafeInteger(d)||d>n+30||n-d>600)throw Error('Telegram authorization has expired');const q=[...m].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n'),want=hex(await H(await H('WebAppData',t),q));if(want!==got)throw Error('Invalid Telegram signature');const u=JSON.parse(m.get('user')||'null');if(!u||!Number.isSafeInteger(Number(u.id))||Number(u.id)<=0)throw Error('Invalid Telegram user');return{...u,id:Number(u.id)}}
async function admin(path,opt={}){const r=await fetch(U+path,{...opt,headers:{apikey:K,Authorization:'Bearer '+K,'Content-Type':'application/json',...(opt.headers||{})}}),b=await r.json().catch(()=>({}));if(!r.ok)throw Error(b.message||b.msg||'Supabase admin request failed');return b}
async function login(init){const u=await verify(init),q=await admin('/rest/v1/telegram_accounts?select=user_id&telegram_user_id=eq.'+u.id),email='telegram-'+u.id+'@telegram.kartochka.invalid';let id=q[0]?.user_id;if(!id){const x=await admin('/auth/v1/admin/users',{method:'POST',body:JSON.stringify({email,password:crypto.randomUUID()+'-'+crypto.randomUUID(),email_confirm:true,user_metadata:{auth_source:'telegram',telegram_id:u.id,telegram_username:u.username||null,telegram_first_name:u.first_name||null}})});id=x.user?.id;if(!id)throw Error('Unable to create Telegram account');await admin('/rest/v1/telegram_accounts',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=minimal'},body:JSON.stringify({telegram_user_id:u.id,user_id:id,telegram_username:u.username||null,telegram_first_name:u.first_name||null})})}await admin('/auth/v1/admin/users/'+id,{method:'PUT',body:JSON.stringify({user_metadata:{auth_source:'telegram',telegram_id:u.id,telegram_username:u.username||null,telegram_first_name:u.first_name||null}})});const l=await admin('/auth/v1/admin/generate_link',{method:'POST',body:JSON.stringify({type:'magiclink',email})});if(!l.properties?.hashed_token)throw Error('Unable to create Telegram session');return{token_hash:l.properties.hashed_token,type:'magiclink'}}
async function bot(m,p){const r=await fetch('https://api.telegram.org/bot'+(Deno.env.get('TELEGRAM_BOT_TOKEN')||'')+'/'+m,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)}),b=await r.json().catch(()=>({}));if(!r.ok||!b.ok)throw Error('Telegram API request failed');return b.result}
function secret(r){const a=Deno.env.get('TELEGRAM_WEBHOOK_SECRET')||'',b=r.headers.get('x-telegram-bot-api-secret-token')||'';if(!a||a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0}
// Telegram accepts any HTTPS URL, including a Vercel login wall. Validate the app before
// publishing URLs in the menu or onboarding; otherwise do not show a broken launch button.
async function appLaunchOptions(){
  const appUrl=Deno.env.get('TELEGRAM_WEB_APP_URL')||'';
  const health=await inspectWebAppUrl(appUrl);
  let username='';
  if(health.ok){try{username=String((await bot('getMe',{}))?.username||'')}catch(_){}}
  const quickUrl=/^[a-zA-Z0-9_]{5,32}$/.test(username)?`https://t.me/${username}?startapp=quick&mode=compact`:'';
  return{appUrl,quickUrl,available:health.ok,supportUrl:Deno.env.get('TELEGRAM_SUPPORT_URL')||''};
}
async function showIntro(chatId,page,{messageId=null,hasPhoto=false,initial=false}={}){
  const data=onboardingPage(page,await appLaunchOptions());
  if(messageId!==null){
    return bot(hasPhoto?'editMessageCaption':'editMessageText',{
      chat_id:chatId,message_id:messageId,...(hasPhoto?{caption:data.text}:{text:data.text}),reply_markup:data.reply_markup
    });
  }
  const photo=initial?Deno.env.get('TELEGRAM_WELCOME_PHOTO_FILE_ID')||'':'';
  if(photo){
    try{return await bot('sendPhoto',{chat_id:chatId,photo,caption:data.text,reply_markup:data.reply_markup})}catch(_){/* Owner photo may not have been uploaded to this bot yet. */}
  }
  return bot('sendMessage',{chat_id:chatId,text:data.text,reply_markup:data.reply_markup});
}
// Read-only diagnostics never return token values.
async function setup(r){if(!secret(r))return J({error:'Unauthorized'},401);const w=Deno.env.get('TELEGRAM_WEB_APP_URL')||'';if(!/^https:\/\//i.test(w))throw Error('Telegram web app URL is missing');const health=await inspectWebAppUrl(w);if(!health.ok){const e=Error('WEB_APP_URL_UNAVAILABLE');e.reason=health.reason;e.hint=health.hint;throw e}const url=U.replace(/\/+$/,'')+'/functions/v1/telegram';await bot('setWebhook',{url,secret_token:Deno.env.get('TELEGRAM_WEBHOOK_SECRET'),allowed_updates:['message','callback_query','pre_checkout_query'],drop_pending_updates:false});await bot('setMyCommands',{commands:[{command:'start',description:'Начать знакомство с Карточкой'},{command:'help',description:'Возможности Карточки'},{command:'plans',description:'Тарифы'},{command:'support',description:'Поддержка'}]});await bot('setChatMenuButton',{menu_button:{type:'web_app',text:'Открыть Карточку',web_app:{url:w}}});const x=await bot('getWebhookInfo',{});return{ok:true,webhook:{configured:x?.url===url,pending_update_count:Number(x?.pending_update_count||0),last_error_date:x?.last_error_date||null}}}
async function diagnose(){const w=Deno.env.get('TELEGRAM_WEB_APP_URL')||'';const health=await inspectWebAppUrl(w);let hook=null;try{hook=await bot('getWebhookInfo',{})}catch(_){}let menu=null;try{menu=await bot('getChatMenuButton',{})}catch(_){}return{web_app_url:{present:Boolean(w),https:/^https:\/\//i.test(w),host:(()=>{try{return new URL(w).host}catch(_){return null}})(),serving_app:health.ok,reason:health.reason,hint:health.hint},secrets:{TELEGRAM_BOT_TOKEN:Boolean(Deno.env.get('TELEGRAM_BOT_TOKEN')),TELEGRAM_WEBHOOK_SECRET:Boolean(Deno.env.get('TELEGRAM_WEBHOOK_SECRET')),TELEGRAM_WEB_APP_URL:Boolean(w)},webhook:{url_matches:hook?.url===U.replace(/\/+$/,'')+'/functions/v1/telegram',pending_update_count:Number(hook?.pending_update_count||0),last_error_message:hook?.last_error_message||null},menu_button:{type:menu?.type||null,opens_app:menu?.type==='web_app'},payments:'disabled'}}

Deno.serve(async r=>{
  const h=C(r);
  if(r.method==='OPTIONS')return new Response(null,{status:204,headers:h});
  try{
    const b=await r.json().catch(()=>({}));
    if(b.action==='login')return J(await login(b.initData),200,h);
    if(b.action==='setup')return J(await setup(r),200,h);
    if(b.action==='diagnose'){
      if(!secret(r))return J({error:'Unauthorized'},401,h);
      return J(await diagnose(),200,h);
    }
    if(b.action==='invoice')return J({error:'Real payments are disabled during the closed Telegram test',payment_mode:'disabled'},403,h);
    if(b.update||b.message||b.callback_query||b.pre_checkout_query){
      if(!secret(r))return J({error:'Unauthorized'},401,h);
      const u=b.update||b;
      if(u.pre_checkout_query?.id){
        await bot('answerPreCheckoutQuery',{pre_checkout_query_id:u.pre_checkout_query.id,ok:false,error_message:'Платежи отключены на время закрытого тестирования.'});
      }else if(u.message?.successful_payment){
        await bot('sendMessage',{chat_id:u.message.chat.id,text:'Платёж не активирован: закрытый тест не принимает реальные платежи.'});
      }else if(u.callback_query?.id){
        const query=u.callback_query;
        const page=onboardingAction(query.data);
        if(!page||query.message?.chat?.type!=='private'||!query.message?.message_id){
          await bot('answerCallbackQuery',{callback_query_id:query.id,text:'Откройте личный чат с ботом и отправьте /start.'});
        }else{
          await bot('answerCallbackQuery',{callback_query_id:query.id});
          await showIntro(query.message.chat.id,page,{messageId:query.message.message_id,hasPhoto:Boolean(query.message.photo?.length)});
        }
      }else if(u.message?.chat?.id&&u.message.chat.type==='private'){
        const text=String(u.message.text||'');
        if(/^\/start(?:@\w+)?(?:\s|$)/i.test(text))await showIntro(u.message.chat.id,'home',{initial:true});
        else if(/^\/help(?:@\w+)?\s*$/i.test(text))await showIntro(u.message.chat.id,'features');
        else if(/^\/plans(?:@\w+)?\s*$/i.test(text))await showIntro(u.message.chat.id,'plans');
        else if(/^\/support(?:@\w+)?\s*$/i.test(text))await showIntro(u.message.chat.id,'support');
      }
      return J({ok:true},200,h);
    }
    return J({error:'Not found'},404,h);
  }catch(e){
    const m=String(e?.message||e);
    if(m==='WEB_APP_URL_UNAVAILABLE')return J({error:'Telegram Mini App URL is not serving the app',reason:e.reason,hint:e.hint,configured:false},409,h);
    const s=/expired|invalid|malformed|duplicate/i.test(m)?401:500;
    return J({error:s===401?m:'Telegram function failed'},s,h);
  }
});
