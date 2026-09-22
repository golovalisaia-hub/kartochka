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

  // The main menu is the four sections the product asks for — no more, no fewer.
  const features = onboardingPage('features', links);
  const buttons = features.reply_markup.inline_keyboard.flat();
  assert.equal(buttons.find(button => button.web_app)?.web_app.url, links.appUrl);
  assert.equal(buttons.length, 4, 'main menu must offer exactly four sections');
  assert.match(buttons[0].text, /Открыть приложение/);
  assert.match(buttons[1].text, /Быстрый доступ/);
  assert.match(buttons[2].text, /Premium и тарифы/);
  assert.match(buttons[3].text, /Поддержка/);
  for (const section of ['quick', 'premium', 'support']) {
    assert(buttons.some(button => button.callback_data === `kartochka:${section}`), section);
  }
  // Every capability listed must exist in the app today.
  for (const promise of [/кошельк/i, /камер/i, /поиск|Находит/i, /штрихкод/i, /недавн/i, /жест/i]) {
    assert.match(features.text, promise);
  }

  // Quick access is its own screen with the four documented ways in, plus a way back.
  const quick = onboardingPage('quick', links);
  const quickButtons = quick.reply_markup.inline_keyboard.flat();
  assert.match(quick.text, /быстрее/i);
  for (const section of ['backtap', 'action', 'android']) {
    assert(quickButtons.some(button => button.callback_data === `kartochka:${section}`), section);
  }
  assert.equal(quickButtons.find(button => button.url)?.url, links.quickUrl, 'Недавние карты must use the quick link');
  assert(quickButtons.some(button => button.callback_data === 'kartochka:features'), 'quick screen needs a way back');

  // Every leaf screen can reach both its parent and the main menu.
  for (const section of ['backtap', 'action', 'android']) {
    const leaf = onboardingPage(section, links).reply_markup.inline_keyboard.flat();
    assert(leaf.some(button => button.callback_data === 'kartochka:quick'), `${section} must return to quick access`);
    assert(leaf.some(button => button.callback_data === 'kartochka:features'), `${section} must reach the main menu`);
  }
  assert.match(onboardingPage('android', links).text, /Android|Pixel|Samsung/);
  // No screen may claim a Mini App can hijack a hardware button.
  for (const section of ['backtap', 'action', 'android']) {
    assert.doesNotMatch(onboardingPage(section, links).text, /перехват\w*\s+(кнопк|систем)/i);
  }

  // Premium copy must stay truthful: no invented price, no monthly subscription, no payment.
  const premium = onboardingPage('premium', links);
  assert.match(premium.text, /Стоимость уточняется|уточняется/);
  assert.match(premium.text, /однократн|разов/);
  // Premium may be contrasted with a monthly subscription, but never presented as one:
  // every mention of "ежемесячн…" must be negated.
  for (const match of premium.text.matchAll(/(.{0,6})ежемесячн/gi)) {
    assert.match(match[1], /(^|[\s,])не\s*$/i, `Premium must not be called a monthly subscription: "${match[0]}"`);
  }
  assert.match(premium.text, /Оплата отключена/);
  assert.match(premium.text, /зависит от правил/, 'bonuses must not be promised');
  assert.match(premium.text, /останется бесплатным/, 'free features must not become paid');
  assert.equal(premium.reply_markup.inline_keyboard.flat().some(button => /оплатить|купить|stars/i.test(button.text)), false);
  // Buttons already sitting in users' chats keep working.
  assert.equal(onboardingAction('kartochka:plans'), 'plans');
  assert.equal(onboardingPage('plans', links).text, premium.text);

  assert.equal(onboardingPage('support', links).reply_markup.inline_keyboard[0][0].url, links.supportUrl);
  const noSupport = onboardingPage('support', { ...links, supportUrl: '' });
  assert.match(noSupport.text, /пока не подключён/);
  assert.match(noSupport.text, /TELEGRAM_SUPPORT_URL/, 'must name what has to be configured');
  assert.equal(noSupport.reply_markup.inline_keyboard.flat().some(button => button.url), false);
  // A support link must be a Telegram contact, never an arbitrary host.
  assert.equal(onboardingPage('support', { ...links, supportUrl: 'https://evil.example/chat' })
    .reply_markup.inline_keyboard.flat().some(button => button.url), false);

  // A returning user is offered the wallet immediately instead of the tour.
  const fresh = onboardingPage('home', links);
  assert.equal(fresh.reply_markup.inline_keyboard.flat().some(button => button.web_app), false);
  assert.match(fresh.reply_markup.inline_keyboard[0][0].text, /Начать/);
  const known = onboardingPage('home', { ...links, returning: true });
  assert.equal(known.reply_markup.inline_keyboard[0][0].web_app.url, links.appUrl);

  // Nothing offers a launch button while the app URL is not serving the app.
  const unavailable = onboardingPage('features', { ...links, available: false });
  assert.equal(unavailable.reply_markup.inline_keyboard.flat().some(button => button.url || button.web_app), false);
  assert.match(unavailable.text, /недоступно/);
  for (const section of ['action', 'backtap', 'android', 'quick']) {
    assert.equal(onboardingPage(section, { ...links, available: false })
      .reply_markup.inline_keyboard.flat().some(button => button.url), false, section);
  }

  for (const section of ['home', 'features', 'quick', 'premium', 'action', 'backtap', 'android', 'plans', 'support']) {
    const built = onboardingPage(section, links);
    assert(built.text.length <= 1024, `${section} photo caption exceeds Telegram limit`);
    assert(built.reply_markup.inline_keyboard.every(row => row.length <= 2), `${section} crams a row with buttons`);
    if (section !== 'home') {
      assert(built.reply_markup.inline_keyboard.flat().some(button => button.callback_data), `${section} has no way out`);
    }
  }
  console.log('PASS onboarding screens, four-section menu, quick-access tree, truthful plans and safe links');

  // ---- bot integration: the update handler against a mocked Telegram API ----
  let server = null;
  const calls = [];
  let photoWorks = false;      // whether Telegram accepts the welcome picture
  let editResult = { ok: true };
  const env = {
    SUPABASE_URL: 'https://test-project.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'mock-only-role-key',
    TELEGRAM_BOT_TOKEN: 'mock-only-bot-token',
    TELEGRAM_WEBHOOK_SECRET: 'mock-webhook-secret',
    TELEGRAM_WEB_APP_URL: 'https://wallet.example/',
    TELEGRAM_SUPPORT_URL: 'https://t.me/KartochkaSupport'
  };
  let knownAccounts = [];
  const oldDeno = globalThis.Deno;
  const oldFetch = globalThis.fetch;
  globalThis.Deno = { env: { get: key => env[key] }, serve: fn => { server = fn; } };
  globalThis.fetch = async (url, options = {}) => {
    const target = String(url);
    if (target === env.TELEGRAM_WEB_APP_URL) {
      return new Response('<html><head><title>Карточка</title></head><body><script src="telegram-mini-app.js"></script></body></html>', { status: 200 });
    }
    if (target.startsWith(`${env.SUPABASE_URL}/rest/v1/telegram_accounts`)) {
      return Response.json(knownAccounts);
    }
    if (target.includes('api.telegram.org/bot')) {
      const method = target.split('/').at(-1);
      const payload = JSON.parse(options.body || '{}');
      calls.push({ method, payload });
      if (method === 'getMe') return Response.json({ ok: true, result: { username: 'KartochkaWalletBot' } });
      if (method === 'getWebhookInfo') return Response.json({ ok: true, result: { url: `${env.SUPABASE_URL}/functions/v1/telegram` } });
      // Telegram refuses a photo it cannot fetch, exactly as it would for a missing file.
      if (method === 'sendPhoto' && !photoWorks) {
        return Response.json({ ok: false, description: 'Bad Request: wrong file identifier' }, { status: 400 });
      }
      if ((method === 'editMessageText' || method === 'editMessageCaption') && !editResult.ok) {
        return Response.json({ ok: false, description: editResult.description }, { status: 400 });
      }
      return Response.json({ ok: true, result: true });
    }
    throw new Error(`Unexpected request: ${target}`);
  };

  const failures = [];
  const check = async (name, body) => {
    try { await body(); console.log(`  ok  ${name}`); }
    catch (error) { failures.push(name); console.error(`  FAIL ${name}\n       ${error.message}`); }
  };

  try {
    await import(pathToFileURL(path.join(root, 'supabase/functions/telegram/index.ts')).href);
    assert.equal(typeof server, 'function');
    const dispatch = async (body, secret = env.TELEGRAM_WEBHOOK_SECRET) => server(new Request('https://test-project.supabase.co/functions/v1/telegram', {
      method: 'POST', headers: { 'Content-Type': 'application/json' , 'X-Telegram-Bot-Api-Secret-Token': secret }, body: JSON.stringify(body)
    }));
    const message = (text, from = 500) => ({ message: { chat: { id: 42, type: 'private' }, from: { id: from }, text } });
    const press = (data, extra = {}) => ({ callback_query: { id: 'q', data, from: { id: 500 }, message: { message_id: 10, chat: { id: 42, type: 'private' }, ...extra } } });
    const reset = () => { calls.length = 0; };

    await check('a wrong webhook secret never reaches the Telegram API', async () => {
      reset();
      assert.equal((await dispatch(message('/start'), 'incorrect')).status, 401);
      assert.equal(calls.length, 0);
    });

    await check('the owner picture is used when Telegram accepts it', async () => {
      reset();
      photoWorks = true;
      assert.equal((await dispatch(message('/start'))).status, 200);
      const photo = calls.find(item => item.method === 'sendPhoto');
      assert.ok(photo, 'a welcome picture must be attempted');
      assert.match(photo.payload.photo, /welcome\.png$/);
      assert.match(photo.payload.caption, /все скидочные карты/);
      assert.equal(calls.some(item => item.method === 'sendMessage'), false, 'no duplicate text welcome');
      photoWorks = false;
    });

    await check('/start greets a new user with the tour button', async () => {
      reset();
      knownAccounts = [];
      assert.equal((await dispatch(message('/start'))).status, 200);
      const welcome = calls.find(item => item.method === 'sendMessage');
      assert.match(welcome.payload.text, /все скидочные карты в одном месте/);
      const keys = welcome.payload.reply_markup.inline_keyboard.flat();
      assert.equal(keys.at(-1).callback_data, 'kartochka:features');
      assert.equal(keys.some(button => button.web_app), false, 'a new user is not pushed straight into the app');
    });

    await check('/start offers a returning user the wallet straight away', async () => {
      reset();
      knownAccounts = [{ telegram_user_id: 500 }];
      assert.equal((await dispatch(message('/start'))).status, 200);
      const welcome = calls.find(item => item.method === 'sendMessage');
      assert.equal(welcome.payload.reply_markup.inline_keyboard[0][0].web_app.url, env.TELEGRAM_WEB_APP_URL);
      knownAccounts = [];
    });

    await check('a missing picture falls back to text instead of failing', async () => {
      reset();
      assert.equal((await dispatch(message('/start'))).status, 200);
      assert.ok(calls.find(item => item.method === 'sendMessage'), 'the welcome must still arrive');
    });

    await check('«Начать» edits the same message into the main menu', async () => {
      reset();
      assert.equal((await dispatch(press('kartochka:features'))).status, 200);
      assert.ok(calls.find(item => item.method === 'answerCallbackQuery'), 'the button must be acknowledged');
      const edited = calls.find(item => item.method === 'editMessageText');
      assert.match(edited.payload.text, /Что умеет/);
      assert.equal(calls.some(item => item.method === 'sendMessage'), false, 'no extra message per step');
      const keys = edited.payload.reply_markup.inline_keyboard.flat();
      assert.equal(keys.length, 4);
      assert.ok(keys[0].web_app);
    });

    await check('a welcome photo is edited as a caption, not as text', async () => {
      reset();
      assert.equal((await dispatch(press('kartochka:features', { photo: [{ file_id: 'x' }] }))).status, 200);
      assert.ok(calls.find(item => item.method === 'editMessageCaption'), 'a photo message needs its caption edited');
      assert.equal(calls.some(item => item.method === 'editMessageText'), false);
    });

    await check('every menu button reaches a real screen', async () => {
      for (const page of ['quick', 'backtap', 'action', 'android', 'premium', 'plans', 'support', 'home']) {
        reset();
        assert.equal((await dispatch(press(`kartochka:${page}`))).status, 200, page);
        const edited = calls.find(item => item.method === 'editMessageText');
        assert.ok(edited, `${page} produced no screen`);
        assert.ok(edited.payload.text.length > 0, `${page} is empty`);
        assert.ok(edited.payload.reply_markup.inline_keyboard.flat().length > 0, `${page} has no buttons`);
      }
    });

    await check('pressing the same button twice is not an error', async () => {
      reset();
      editResult = { ok: false, description: 'Bad Request: message is not modified' };
      const response = await dispatch(press('kartochka:features'));
      editResult = { ok: true };
      assert.equal(response.status, 200, 'a repeated press must not fail the webhook');
      assert.ok(calls.find(item => item.method === 'answerCallbackQuery'), 'the spinner must still be cleared');
      assert.equal(calls.some(item => item.method === 'sendMessage'), false, 'a repeated press must not spam the chat');
    });

    await check('an uneditable old message falls back to a fresh one', async () => {
      reset();
      editResult = { ok: false, description: 'Bad Request: message to edit not found' };
      const response = await dispatch(press('kartochka:premium'));
      editResult = { ok: true };
      assert.equal(response.status, 200);
      assert.ok(calls.find(item => item.method === 'sendMessage'), 'the user must still get the screen');
    });

    await check('an unknown callback is answered instead of ignored', async () => {
      reset();
      assert.equal((await dispatch(press('kartochka:../admin'))).status, 200);
      assert.ok(calls.find(item => item.method === 'answerCallbackQuery'), 'unknown data must still clear the spinner');
      assert.equal(calls.some(item => item.method.startsWith('edit')), false, 'unknown data must change nothing');
    });

    await check('a callback from a group chat changes nothing', async () => {
      reset();
      assert.equal((await dispatch({ callback_query: { id: 'q', data: 'kartochka:premium', from: { id: 1 }, message: { message_id: 3, chat: { id: -100, type: 'supergroup' } } } })).status, 200);
      assert.equal(calls.some(item => item.method.startsWith('edit')), false);
    });

    await check('/menu opens the main menu directly', async () => {
      reset();
      assert.equal((await dispatch(message('/menu'))).status, 200);
      const sent = calls.find(item => item.method === 'sendMessage');
      assert.match(sent.payload.text, /Что умеет/);
      assert.equal(sent.payload.reply_markup.inline_keyboard.flat().length, 4);
    });

    await check('a quick deep link opens the wallet without the presentation', async () => {
      reset();
      assert.equal((await dispatch(message('/start quick'))).status, 200);
      const sent = calls.find(item => item.method === 'sendMessage');
      assert.doesNotMatch(sent.payload.text, /Что умеет|Начать/, 'quick launch must skip the tour');
      assert.ok(sent.payload.reply_markup.inline_keyboard.flat().some(button => button.web_app || button.url));
      assert.equal(calls.some(item => item.method === 'sendPhoto'), false, 'quick launch must not send the welcome picture');
    });

    await check('/support and /plans open their sections', async () => {
      reset();
      assert.equal((await dispatch(message('/support'))).status, 200);
      assert.ok(calls.find(item => item.method === 'sendMessage' && /Поддержка/.test(item.payload.text)));
      reset();
      assert.equal((await dispatch(message('/plans'))).status, 200);
      assert.ok(calls.find(item => item.method === 'sendMessage' && /Premium и тарифы/.test(item.payload.text)));
    });

    await check('ordinary chatter gets one helpful reply, not silence', async () => {
      reset();
      assert.equal((await dispatch(message('привет'))).status, 200);
      const sent = calls.filter(item => item.method === 'sendMessage');
      assert.equal(sent.length, 1, 'exactly one reply');
      assert.match(sent[0].payload.text, /меню/i);
    });

    await check('setup subscribes to callbacks and registers the commands', async () => {
      reset();
      assert.equal((await dispatch({ action: 'setup' })).status, 200);
      assert.ok(calls.find(item => item.method === 'setWebhook').payload.allowed_updates.includes('callback_query'));
      const commands = calls.find(item => item.method === 'setMyCommands').payload.commands.map(item => item.command);
      for (const command of ['start', 'menu', 'support', 'plans']) {
        assert.ok(commands.includes(command), `/${command} must be registered`);
      }
    });

    await check('payments stay switched off', async () => {
      reset();
      assert.equal((await dispatch({ action: 'invoice' })).status, 403);
      assert.equal((await dispatch({ pre_checkout_query: { id: 'p1' } })).status, 200);
      const answered = calls.find(item => item.method === 'answerPreCheckoutQuery');
      assert.equal(answered.payload.ok, false);
      assert.equal(calls.some(item => /createInvoiceLink|sendInvoice/i.test(item.method)), false);
    });

    if (failures.length) throw new Error(`${failures.length} bot checks failed: ${failures.join(', ')}`);
    console.log('PASS bot navigation, welcome picture, repeated presses, deep links and webhook safety');
  } finally {
    globalThis.fetch = oldFetch;
    if (oldDeno === undefined) delete globalThis.Deno;
    else globalThis.Deno = oldDeno;
  }
})().catch(error => {
  console.error('TELEGRAM ONBOARDING TEST FAILURE', error);
  process.exitCode = 1;
});
