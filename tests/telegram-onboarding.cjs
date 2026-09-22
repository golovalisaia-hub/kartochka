const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const file = path.join(root, 'supabase/functions/_shared/bot-onboarding.ts');

(async () => {
  const { onboardingPage, onboardingAction } = await import(pathToFileURL(file).href);
  const links = {
    available: true,
    appUrl: 'https://wallet.example/',
    quickUrl: 'https://t.me/KartochkaWalletBot?startapp=quick&mode=compact',
    supportUrl: 'https://t.me/KartochkaSupport'
  };
  const home = onboardingPage('home', links);
  assert.match(home.text, /Карточка/);
  assert.match(home.text, /вымышленные карты/);
  assert.equal(home.reply_markup.inline_keyboard[0][0].callback_data, 'kartochka:features');
  assert.equal(onboardingAction('kartochka:features'), 'features');
  assert.equal(onboardingAction('kartochka:unknown'), null);
  assert.equal(onboardingAction('other:features'), null);

  const features = onboardingPage('features', links);
  const buttons = features.reply_markup.inline_keyboard.flat();
  assert.equal(buttons.find(button => button.web_app)?.web_app.url, links.appUrl);
  assert.equal(buttons.find(button => button.text.includes('Быстрый'))?.url, links.quickUrl);
  for (const section of ['premium', 'action', 'backtap', 'plans', 'support', 'home']) {
    assert(buttons.some(button => button.callback_data === `kartochka:${section}`), section);
  }
  assert.equal(buttons.some(button => /оплатить|купить/i.test(button.text)), false);
  assert.match(onboardingPage('plans', links).text, /разов/);
  assert.match(onboardingPage('plans', links).text, /Оплата сейчас недоступна/);
  assert.match(onboardingPage('action', links).text, /кнопка действия|Кнопка действия/i);
  assert.match(onboardingPage('backtap', links).text, /Двойное касание/);
  assert.equal(onboardingPage('support', links).reply_markup.inline_keyboard[0][0].url, links.supportUrl);
  assert.match(onboardingPage('support', { ...links, supportUrl: '' }).text, /пока не подключён/);
  const unavailable = onboardingPage('features', { ...links, available: false });
  assert.equal(unavailable.reply_markup.inline_keyboard.flat().some(button => button.url || button.web_app), false);
  assert.match(unavailable.text, /недоступно/);
  assert.equal(onboardingPage('action', { ...links, available: false }).reply_markup.inline_keyboard.flat().some(button => button.url), false);
  for (const section of ['home', 'features', 'premium', 'action', 'backtap', 'plans', 'support']) {
    assert(onboardingPage(section, links).text.length <= 1024, `${section} photo caption exceeds Telegram limit`);
  }
  console.log('PASS onboarding pages, buttons, tariff truthfulness, safe link fallback and captions');

  let server = null;
  const calls = [];
  const env = {
    SUPABASE_URL: 'https://test-project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'mock-only-role-key',
    TELEGRAM_BOT_TOKEN: 'mock-only-bot-token',
    TELEGRAM_WEBHOOK_SECRET: 'mock-webhook-secret',
    TELEGRAM_WEB_APP_URL: 'https://wallet.example/',
    TELEGRAM_SUPPORT_URL: 'https://t.me/KartochkaSupport'
  };
  const oldDeno = globalThis.Deno;
  const oldFetch = globalThis.fetch;
  globalThis.Deno = { env: { get: key => env[key] }, serve: fn => { server = fn; } };
  globalThis.fetch = async (url, options = {}) => {
    if (url === env.TELEGRAM_WEB_APP_URL) {
      return new Response('<html><head><title>Карточка</title></head><body><script src="telegram-mini-app.js"></script></body></html>', { status: 200 });
    }
    if (String(url).includes('api.telegram.org/bot')) {
      const method = String(url).split('/').at(-1);
      const payload = JSON.parse(options.body || '{}');
      calls.push({ method, payload });
      return Response.json({ ok: true, result: method === 'getMe' ? { username: 'KartochkaWalletBot' } : method === 'getWebhookInfo' ? { url: `${env.SUPABASE_URL}/functions/v1/telegram` } : true });
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    await import(pathToFileURL(path.join(root, 'supabase/functions/telegram/index.ts')).href);
    assert.equal(typeof server, 'function');
    const dispatch = async (body, secret = env.TELEGRAM_WEBHOOK_SECRET) => server(new Request('https://test-project.supabase.co/functions/v1/telegram', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(body)
    }));
    assert.equal((await dispatch({ message: { chat: { id: 42, type: 'private' }, text: '/start' } }, 'incorrect')).status, 401);
    assert.equal(calls.length, 0, 'bad webhook secret must not reach Telegram API');
    assert.equal((await dispatch({ message: { chat: { id: 42, type: 'private' }, text: '/start' } })).status, 200);
    const welcome = calls.find(item => item.method === 'sendMessage');
    assert.equal(welcome.payload.reply_markup.inline_keyboard[0][0].callback_data, 'kartochka:features');
    calls.length = 0;
    assert.equal((await dispatch({ callback_query: { id: 'q1', data: 'kartochka:features', message: { message_id: 10, chat: { id: 42, type: 'private' } } } })).status, 200);
    assert(calls.some(item => item.method === 'answerCallbackQuery'), 'Telegram callback must be acknowledged');
    const edited = calls.find(item => item.method === 'editMessageText');
    assert.match(edited.payload.text, /Что умеет/);
    assert(edited.payload.reply_markup.inline_keyboard.flat().some(button => button.web_app));
    calls.length = 0;
    assert.equal((await dispatch({ message: { chat: { id: 42, type: 'private' }, text: '/support' } })).status, 200);
    assert(calls.some(item => item.method === 'sendMessage' && item.payload.text.includes('Поддержка')));
    calls.length = 0;
    assert.equal((await dispatch({ action: 'setup' })).status, 200);
    assert(calls.find(item => item.method === 'setWebhook').payload.allowed_updates.includes('callback_query'));
    assert(calls.find(item => item.method === 'setMyCommands').payload.commands.some(command => command.command === 'support'));
    console.log('PASS bot /start, callbacks, support, webhook secret and callback subscription');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDeno === undefined) delete globalThis.Deno;
    else globalThis.Deno = oldDeno;
  }
})().catch(error => {
  console.error('TELEGRAM ONBOARDING TEST FAILURE', error);
  process.exitCode = 1;
});
