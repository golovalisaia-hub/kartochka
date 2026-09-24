import { inspectWebAppUrl } from '../_shared/telegram.ts';
import { onboardingAction, onboardingPage, BOT_NAME, BOT_DESCRIPTION, BOT_SHORT_DESCRIPTION, BOT_COMMANDS } from '../_shared/bot-onboarding.ts';
const U=Deno.env.get('SUPABASE_URL')||'',K=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'',E=new TextEncoder();
const C=r=>{const o=r.headers.get('origin')||'',u=Deno.env.get('TELEGRAM_WEB_APP_URL')||'';let a='*';try{const x=new URL(u).origin;a=o===x||/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(o)?o:x}catch(_){if(o)a=o}return{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':a,'Access-Control-Allow-Headers':'authorization, apikey, content-type, x-client-info','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin'}};
const J=(b,s=200,h={})=>new Response(JSON.stringify(b),{status:s,headers:{...h,'Content-Type':'application/json; charset=utf-8'}});
const H=async(k,v)=>{const x=await crypto.subtle.importKey('raw',typeof k==='string'?E.encode(k):k,{name:'HMAC',hash:'SHA-256'},false,['sign']);return new Uint8Array(await crypto.subtle.sign('HMAC',x,E.encode(v)))};
const hex=x=>Array.from(x,b=>b.toString(16).padStart(2,'0')).join('');
async function verify(s){const t=Deno.env.get('TELEGRAM_BOT_TOKEN')||'';if(typeof s!=='string'||s.length<20||s.length>8192||!t)throw Error('Invalid Telegram initData');const m=new Map();for(const p of s.split('&')){const i=p.indexOf('=');if(i<1)throw Error('Malformed Telegram initData');const k=decodeURIComponent(p.slice(0,i).replace(/\+/g,' ')),v=decodeURIComponent(p.slice(i+1).replace(/\+/g,' '));if(m.has(k))throw Error('Duplicate Telegram initData field');m.set(k,v)}const got=(m.get('hash')||'').toLowerCase();if(!/^[a-f0-9]{64}$/.test(got))throw Error('Invalid Telegram signature');m.delete('hash');const d=Number(m.get('auth_date')),n=Math.floor(Date.now()/1000);if(!Number.isSafeInteger(d)||d>n+30||n-d>600)throw Error('Telegram authorization has expired');const q=[...m].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\n'),want=hex(await H(await H('WebAppData',t),q));if(want!==got)throw Error('Invalid Telegram signature');const u=JSON.parse(m.get('user')||'null');if(!u||!Number.isSafeInteger(Number(u.id))||Number(u.id)<=0)throw Error('Invalid Telegram user');return{...u,id:Number(u.id)}}
async function admin(path,opt={}){const r=await fetch(U+path,{...opt,headers:{apikey:K,Authorization:'Bearer '+K,'Content-Type':'application/json',...(opt.headers||{})}}),b=await r.json().catch(()=>({}));if(!r.ok)throw Error(b.message||b.msg||'Supabase admin request failed');return b}
async function login(init){const u=await verify(init),q=await admin('/rest/v1/telegram_accounts?select=user_id&telegram_user_id=eq.'+u.id),known=q[0]?.user_id,email='telegram-'+u.id+'@telegram.kartochka.invalid',metadata={auth_source:'telegram',telegram_id:u.id,telegram_username:u.username||null,telegram_first_name:u.first_name||null},l=await admin('/auth/v1/admin/generate_link',{method:'POST',body:JSON.stringify({type:'magiclink',email,data:metadata})}),id=l.id||l.user?.id,tokenHash=l.hashed_token||l.properties?.hashed_token;if(!id||!tokenHash)throw Error('Unable to create Telegram session');if(known&&known!==id)throw Error('Telegram account mismatch');if(!known)await admin('/rest/v1/telegram_accounts',{method:'POST',headers:{Prefer:'resolution=ignore-duplicates,return=minimal'},body:JSON.stringify({telegram_user_id:u.id,user_id:id,telegram_username:u.username||null,telegram_first_name:u.first_name||null})});await admin('/auth/v1/admin/users/'+id,{method:'PUT',body:JSON.stringify({user_metadata:metadata})});return{token_hash:tokenHash,type:l.verification_type||l.properties?.verification_type||'magiclink'}}
async function bot(m,p){const r=await fetch('https://api.telegram.org/bot'+(Deno.env.get('TELEGRAM_BOT_TOKEN')||'')+'/'+m,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)}),b=await r.json().catch(()=>({}));if(!r.ok||!b.ok){const e=Error('Telegram API request failed');e.description=String(b.description||'');e.telegram=true;throw e}return b.result}
// Never throws: used where a Telegram refusal is an expected outcome rather than a failure.
async function tryBot(m,p){try{return{ok:true,result:await bot(m,p)}}catch(e){return{ok:false,description:String(e?.description||e?.message||e)}}}
function secret(r){const a=Deno.env.get('TELEGRAM_WEBHOOK_SECRET')||'',b=r.headers.get('x-telegram-bot-api-secret-token')||'';if(!a||a.length!==b.length)return false;let x=0;for(let i=0;i<a.length;i++)x|=a.charCodeAt(i)^b.charCodeAt(i);return x===0}
// Telegram accepts any HTTPS URL, including a Vercel login wall. Validate the app before
// publishing URLs in the menu or onboarding; otherwise do not show a broken launch button.
// Checking the launch URL means fetching the site, so the answer is cached briefly. Without
// this, tapping through the menu would re-fetch the site on every single button press.
let launchCache=null;
const LAUNCH_TTL_MS=60000;
async function appLaunchOptions(){
  if(launchCache&&Date.now()-launchCache.at<LAUNCH_TTL_MS)return launchCache.value;
  const appUrl=Deno.env.get('TELEGRAM_WEB_APP_URL')||'';
  const health=await inspectWebAppUrl(appUrl);
  let username='';
  if(health.ok){try{username=String((await bot('getMe',{}))?.username||'')}catch(_){}}
  const quickUrl=/^[a-zA-Z0-9_]{5,32}$/.test(username)?`https://t.me/${username}?startapp=quick&mode=compact`:'';
  const value={appUrl,quickUrl,available:health.ok,supportUrl:Deno.env.get('TELEGRAM_SUPPORT_URL')||''};
  launchCache={at:Date.now(),value};
  return value;
}

/*
 * The owner's cover media for the welcome message.
 *
 * Nothing is generated or substituted here — no stand-in artwork is ever invented. Candidates
 * are tried in order and the first one Telegram accepts is remembered:
 *
 *   sendAnimation  1. TELEGRAM_WELCOME_ANIMATION_FILE_ID — GIF/MP4 already uploaded to this bot
 *                  2. TELEGRAM_WELCOME_ANIMATION_URL     — public HTTPS .gif or .mp4
 *                  3. <app>/assets/branding/welcome.gif|.mp4, or welcome.mp4|.gif at the root
 *   sendPhoto      4. TELEGRAM_WELCOME_PHOTO_FILE_ID
 *                  5. TELEGRAM_WELCOME_PHOTO_URL
 *                  6. <app>/assets/branding/welcome.png, or welcome.png at the root
 *
 * With none of them available the welcome is sent as plain text. Telegram renders an
 * animation at its own aspect ratio, so the file is passed through untouched and never
 * re-encoded or cropped here.
 */
let coverChoice;                // undefined = not looked yet, {method,media} = works, null = none
let coverCheckedAt=0;
const COVER_RETRY_MS=300000;    // re-look periodically so media added later is picked up
function coverCandidates(appUrl){
  const out=[];
  const push=(method,media)=>{if(media)out.push({method,media})};
  push('sendAnimation',Deno.env.get('TELEGRAM_WELCOME_ANIMATION_FILE_ID')||'');
  const animationUrl=Deno.env.get('TELEGRAM_WELCOME_ANIMATION_URL')||'';
  if(/^https:\/\//i.test(animationUrl))push('sendAnimation',animationUrl);
  push('sendPhoto',Deno.env.get('TELEGRAM_WELCOME_PHOTO_FILE_ID')||'');
  const photoUrl=Deno.env.get('TELEGRAM_WELCOME_PHOTO_URL')||'';
  if(/^https:\/\//i.test(photoUrl))push('sendPhoto',photoUrl);
  if(/^https:\/\//i.test(appUrl)){
    for(const [method,name] of [
      ['sendAnimation','assets/branding/welcome.mp4'],['sendAnimation','assets/branding/welcome.gif'],
      ['sendAnimation','welcome.mp4'],['sendAnimation','welcome.gif'],
      ['sendPhoto','assets/branding/welcome.png'],['sendPhoto','welcome.png']
    ]){
      try{push(method,new URL(name,appUrl).href)}catch(_){}
    }
  }
  return out;
}
async function sendWelcomeCover(chatId,appUrl,caption,replyMarkup){
  // A known-bad result is remembered only for a while: the owner may add the file at any
  // time, and a warm instance must not keep sending the text welcome forever afterwards.
  if(coverChoice===null&&Date.now()-coverCheckedAt<COVER_RETRY_MS)return null;
  const candidates=coverChoice?[coverChoice]:coverCandidates(appUrl);
  for(const candidate of candidates){
    const key=candidate.method==='sendAnimation'?'animation':'photo';
    const sent=await tryBot(candidate.method,{chat_id:chatId,[key]:candidate.media,caption,reply_markup:replyMarkup});
    if(sent.ok){coverChoice=candidate;return sent.result}
  }
  coverChoice=null;
  coverCheckedAt=Date.now();
  return null;
}

/*
 * The bot's own profile photo (the round avatar).
 *
 * The Bot API historically has no method for a bot to change its own avatar — that is
 * BotFather's Edit Botpic. Rather than guess from documentation we cannot reach, this probes
 * the live API: an unknown method answers "method not found", while an existing one complains
 * about the missing argument. The probe sends no photo, so it can never change the avatar by
 * accident. `{"action":"brand"}` reports the verdict and, where the method does exist and a
 * source is configured, actually uploads the picture.
 */
const AVATAR_METHODS=['setMyProfilePhoto','setMyPhoto'];
/*
 * Existence must be proven, never assumed from the absence of a "method not found". A network
 * blip also fails to match that pattern, and treating it as proof would both misreport the
 * API and go on to attempt an upload. So each outcome is classified explicitly and anything
 * unrecognised stays `unknown`, which never authorises an upload.
 */
async function probeAvatarMethod(){
  let lastDetail='';
  for(const method of AVATAR_METHODS){
    const probe=await tryBot(method,{});
    if(probe.ok)return{method,exists:'yes',detail:'method accepted an empty call'};
    const detail=probe.description||'';
    lastDetail=detail;
    // Telegram names the method it does not know.
    if(/method not found|unsupported|not supported|unknown method/i.test(detail))continue;
    // An existing method complains about the argument we deliberately did not send.
    if(/required|invalid|photo|file/i.test(detail))return{method,exists:'yes',detail};
    // Anything else (transport failure, unfamiliar wording) is not evidence either way.
    return{method:null,exists:'unknown',detail};
  }
  return{method:null,exists:'no',detail:lastDetail||'Bot API exposes no method for a bot to set its own avatar'};
}
function avatarSource(appUrl){
  const explicit=Deno.env.get('TELEGRAM_AVATAR_URL')||'';
  if(/^https:\/\//i.test(explicit))return explicit;
  if(/^https:\/\//i.test(appUrl)){
    try{return new URL('assets/branding/avatar-telegram.jpg',appUrl).href}catch(_){}
  }
  return '';
}
async function brand(){
  const launch=await appLaunchOptions();
  const probe=await probeAvatarMethod();
  const source=avatarSource(launch.appUrl);
  let applied=null;
  // Only a proven method may be called with a real photo.
  if(probe.exists==='yes'&&probe.method&&source){
    const sent=await tryBot(probe.method,{photo:source});
    applied={ok:sent.ok,detail:sent.ok?'':sent.description};
  }
  return{
    avatar:{
      api_method:probe.method,
      api_can_set:probe.exists==='yes',
      api_probe:probe.exists,
      api_detail:probe.detail,
      source_configured:Boolean(source),
      source_reachable:source?(await tryFetchHead(source)):false,
      applied,
      botfather:'/mybots → @KartochkaWalletBot → Edit Bot → Edit Botpic → отправить квадратный PNG/JPG'
    },
    description:{published_by:'setMyDescription + setMyShortDescription через {"action":"setup"}'},
    cover:{
      chosen:coverChoice?{method:coverChoice.method,media:coverChoice.media}:null,
      checked:coverChoice!==undefined
    }
  };
}
async function tryFetchHead(url){
  try{const r=await fetch(url,{method:'GET',headers:{accept:'image/*'}});return r.ok}catch(_){return false}
}

// Deep link straight to the wallet: no welcome, no tour, just a way in.
async function sendQuickLaunch(chatId){
  const launch=await appLaunchOptions();
  const keyboard=[];
  if(launch.available&&/^https:\/\//i.test(launch.appUrl))keyboard.push([{text:'💳 Открыть приложение',web_app:{url:launch.appUrl}}]);
  if(launch.available&&launch.quickUrl)keyboard.push([{text:'⚡ Недавние карты',url:launch.quickUrl}]);
  return bot('sendMessage',{
    chat_id:chatId,
    text:launch.available
      ? '💳 «Карточка» готова — откройте кошелёк кнопкой ниже.'
      : '⚠️ Тестовое приложение пока недоступно по публичному адресу. Откройте /menu, чтобы посмотреть остальные разделы.',
    reply_markup:{inline_keyboard:keyboard.length?keyboard:[[{text:'⌂ Главное меню',callback_data:'kartochka:features'}]]}
  });
}

const CAPTION_LIMIT=1024;
async function showIntro(chatId,page,{messageId=null,hasPhoto=false,initial=false}={}){
  const launch=await appLaunchOptions();
  const data=onboardingPage(page,launch);
  if(messageId!==null){
    // A photo caption is capped at 1024 characters; a longer page has to become its own
    // message instead of being silently truncated.
    if(!(hasPhoto&&data.text.length>CAPTION_LIMIT)){
      const edited=await tryBot(hasPhoto?'editMessageCaption':'editMessageText',{
        chat_id:chatId,message_id:messageId,
        ...(hasPhoto?{caption:data.text}:{text:data.text}),reply_markup:data.reply_markup
      });
      if(edited.ok)return edited.result;
      // Tapping the same button twice is not an error — the screen is already correct.
      if(/message is not modified/i.test(edited.description))return null;
    }
    // Message too old, deleted, or otherwise uneditable: fall back to a fresh message so the
    // user always gets a working screen instead of a dead button.
  }
  if(initial){
    const sent=await sendWelcomeCover(chatId,launch.appUrl,data.text,data.reply_markup);
    if(sent)return sent;
  }
  return bot('sendMessage',{chat_id:chatId,text:data.text,reply_markup:data.reply_markup});
}

// Read-only diagnostics never return token values.
async function setup(r){if(!secret(r))return J({error:'Unauthorized'},401);const w=Deno.env.get('TELEGRAM_WEB_APP_URL')||'';if(!/^https:\/\//i.test(w))throw Error('Telegram web app URL is missing');const health=await inspectWebAppUrl(w);if(!health.ok){const e=Error('WEB_APP_URL_UNAVAILABLE');e.reason=health.reason;e.hint=health.hint;throw e}const url=U.replace(/\/+$/,'')+'/functions/v1/telegram';await bot('setWebhook',{url,secret_token:Deno.env.get('TELEGRAM_WEBHOOK_SECRET'),allowed_updates:['message','callback_query','pre_checkout_query'],drop_pending_updates:false});await bot('setMyCommands',{commands:BOT_COMMANDS});
  await bot('setMyName',{name:BOT_NAME});
  // Refuse silently is not an option: a failed description would leave the pre-Start card stale.
  await bot('setMyDescription',{description:BOT_DESCRIPTION});
  await bot('setMyShortDescription',{short_description:BOT_SHORT_DESCRIPTION});await bot('setChatMenuButton',{menu_button:{type:'web_app',text:'Открыть Карточку',web_app:{url:w}}});const x=await bot('getWebhookInfo',{});return{ok:true,webhook:{configured:x?.url===url,pending_update_count:Number(x?.pending_update_count||0),last_error_date:x?.last_error_date||null}}}
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
    if(b.action==='brand'){
      if(!secret(r))return J({error:'Unauthorized'},401,h);
      return J(await brand(),200,h);
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
          await tryBot('answerCallbackQuery',{callback_query_id:query.id,text:'Откройте личный чат с ботом и отправьте /start.'});
        }else{
          // Acknowledge first: Telegram shows a spinner on the button until this arrives.
          await tryBot('answerCallbackQuery',{callback_query_id:query.id});
          await showIntro(query.message.chat.id,page,{
            messageId:query.message.message_id,
            hasPhoto:Boolean(query.message.photo?.length||query.message.animation||query.message.video)
          });
        }
      }else if(u.message?.chat?.id&&u.message.chat.type==='private'){
        const chatId=u.message.chat.id;
        const text=String(u.message.text||'');
        const start=text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/i);
        if(start){
          // A deep link that means "just open the wallet" must not start the presentation.
          if(String(start[1]||'').toLowerCase()==='quick')await sendQuickLaunch(chatId);
          else await showIntro(chatId,'home',{initial:true});
        }
        else if(/^\/menu(?:@\w+)?\s*$/i.test(text))await showIntro(chatId,'features');
        else if(/^\/help(?:@\w+)?\s*$/i.test(text))await showIntro(chatId,'features');
        else if(/^\/quick(?:@\w+)?\s*$/i.test(text))await showIntro(chatId,'quick');
        else if(/^\/plans(?:@\w+)?\s*$/i.test(text))await showIntro(chatId,'premium');
        else if(/^\/support(?:@\w+)?\s*$/i.test(text))await showIntro(chatId,'home');
        else if(/^\//.test(text))await showIntro(chatId,'features');
        else if(text)await bot('sendMessage',{chat_id:chatId,text:'Не понял команду. Откройте главное меню кнопкой ниже или отправьте /menu.',reply_markup:{inline_keyboard:[[{text:'⌂ Главное меню',callback_data:'kartochka:features'}]]}});
      }
      return J({ok:true},200,h);
    }
    return J({error:'Not found'},404,h);
  }catch(e){
    const m=String(e?.message||e);
    console.error('[telegram] request failed',{message:m,stack:e instanceof Error?e.stack:undefined});
    if(m==='WEB_APP_URL_UNAVAILABLE')return J({error:'Telegram Mini App URL is not serving the app',reason:e.reason,hint:e.hint,configured:false},409,h);
    const s=/expired|invalid|malformed|duplicate/i.test(m)?401:500;
    return J({error:s===401?m:'Telegram function failed'},s,h);
  }
});
