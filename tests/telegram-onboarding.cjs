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
  assert.match(home.text, /КАРТОЧКА/);
  // Технические оговорки закрытого теста в обычном приветствии не место.
  assert.doesNotMatch(home.text, /закрыт\w+ тест|оплата отключена/i);
  // The welcome screen leads straight into the app rather than into another menu step.
  assert.equal(home.reply_markup.inline_keyboard[0][0].web_app.url, `${links.appUrl}?startapp=add`);
  assert.equal(onboardingAction('kartochka:features'), 'features');
  assert.equal(onboardingAction('kartochka:unknown'), null);
  assert.equal(onboardingAction('other:features'), null);

  // The welcome screen carries the action grid: one column, one column, then two pairs.
  const main = onboardingPage('home', links);
  const rows = main.reply_markup.inline_keyboard;
  assert.deepEqual(rows.map(row => row.length), [1, 1, 2, 2, 1], 'button grid layout');
  assert.match(rows[0][0].text, /Добавить карту/);
  assert.match(rows[1][0].text, /Открыть приложение/);
  assert.match(rows[2][0].text, /Кнопка действия/);
  assert.match(rows[2][1].text, /Двойной тап/);
  assert.match(rows[3][0].text, /Premium — скоро/);
  // «Недавние карты» ведут прямо в компактный кошелёк, без промежуточного экрана.
  assert.match(rows[3][1].text, /Недавние карты/);
  assert.equal(rows[3][1].url, links.quickUrl);

  // Поддержка снята из интерфейса полностью.
  const everyScreen = ['home', 'features', 'quick', 'backtap', 'action', 'android', 'premium']
    .flatMap(page => onboardingPage(page, links).reply_markup.inline_keyboard.flat());
  assert.equal(everyScreen.some(button => /поддержк/i.test(button.text)), false,
    'кнопка поддержки не должна остаться ни на одном экране');
  assert.equal(everyScreen.some(button => button.callback_data === 'kartochka:support'), false);

  // Но старые сообщения у пользователей продолжают работать.
  assert.equal(onboardingAction('kartochka:support'), 'support', 'старый callback обязан распознаваться');
  const legacy = onboardingPage('support', links);
  assert.equal(legacy.text, home.text, 'старая кнопка поддержки ведёт на главный экран');

  // "Добавить карту" opens the same Mini App on its add-card route; "Открыть приложение"
  // opens the wallet itself. Both are Web App buttons, not plain links.
  assert.equal(rows[1][0].web_app.url, links.appUrl);
  const addUrl = new URL(rows[0][0].web_app.url);
  assert.equal(addUrl.origin + addUrl.pathname, links.appUrl);
  assert.equal(addUrl.searchParams.get('startapp'), 'add');

  // `features` is the same screen, so buttons in older messages still land somewhere real.
  const features = onboardingPage('features', links);
  assert.equal(features.text, main.text);
  const buttons = rows.flat();
  for (const section of ['action', 'backtap', 'premium']) {
    assert(buttons.some(button => button.callback_data === `kartochka:${section}`), section);
  }
  // Every capability listed must exist in the app today.
  for (const promise of [/скидочные карты/i, /Добавление по фото/i, /Поиск/i, /Недавние/i, /Быстрый запуск/i]) {
    assert.match(main.text, promise);
  }
  assert.doesNotMatch(main.text, /SGX|Planner/i, 'no reference material may leak into our copy');

  // Quick access is its own screen with the four documented ways in, plus a way back.
  const quick = onboardingPage('quick', links);
  const quickButtons = quick.reply_markup.inline_keyboard.flat();
  assert.match(quick.text, /быстрее/i);
  for (const section of ['backtap', 'action', 'android']) {
    assert(quickButtons.some(button => button.callback_data === `kartochka:${section}`), section);
  }
  assert.equal(quickButtons.find(button => button.url)?.url, links.quickUrl, 'Недавние карты must use the quick link');
  assert(quickButtons.some(button => button.callback_data === 'kartochka:home'), 'quick screen needs a way back');

  // Every information screen offers a way back to the main screen, and the gesture guides
  // each carry a working link to the compact wallet.
  for (const section of ['backtap', 'action', 'android', 'premium', 'plans', 'quick']) {
    const leaf = onboardingPage(section, links).reply_markup.inline_keyboard.flat();
    assert(leaf.some(button => button.callback_data === 'kartochka:home'), `${section} must reach the main menu`);
  }
  for (const section of ['backtap', 'action', 'android']) {
    const leaf = onboardingPage(section, links).reply_markup.inline_keyboard.flat();
    assert.equal(leaf.find(button => button.url)?.url, links.quickUrl, `${section} needs the compact wallet link`);
  }
  assert.match(onboardingPage('android', links).text, /Android|Pixel|Samsung/);
  // No screen may claim a Mini App can hijack a hardware button.
  for (const section of ['backtap', 'action', 'android']) {
    assert.doesNotMatch(onboardingPage(section, links).text, /перехват\w*\s+(кнопк|систем)/i);
  }

  // Premium copy must stay truthful: no invented price, no monthly subscription, no payment.
  const premium = onboardingPage('premium', links);
  assert.match(premium.text, /Premium — скоро/);
  assert.match(premium.text, /бесплатно/);
  // Форма покупки ещё не выбрана: ни «однократная», ни «подписка», ни цена, ни дата.
  assert.doesNotMatch(premium.text, /однократн|разов(ая|ую)\s+покупк/i);
  assert.doesNotMatch(premium.text, /\d+\s*(₽|руб|rub|\$)/i);
  // Premium may be contrasted with a monthly subscription, but never presented as one:
  // every mention of "ежемесячн…" must be negated.
  assert.doesNotMatch(premium.text, /ежемесячн/i, 'форма оплаты ещё не определена');
  assert.match(premium.text, /Оплата пока не подключена/);
  assert.match(premium.text, /от правил конкретного магазина/, 'bonuses must not be promised');
  assert.match(premium.text, /Владелец включает общий доступ сам/, 'sharing must be described as opt-in');
  assert.equal(premium.reply_markup.inline_keyboard.flat().some(button => /оплатить|купить|stars/i.test(button.text)), false);
  // Buttons already sitting in users' chats keep working.
  assert.equal(onboardingAction('kartochka:plans'), 'plans');
  assert.equal(onboardingPage('plans', links).text, premium.text);

  // Nothing offers a launch button while the app URL is not serving the app.
  const unavailable = onboardingPage('home', { ...links, available: false });
  assert.equal(unavailable.reply_markup.inline_keyboard.flat().some(button => button.url || button.web_app), false);
  assert.match(unavailable.text, /недоступно/);
  for (const section of ['action', 'backtap', 'android', 'quick']) {
    assert.equal(onboardingPage(section, { ...links, available: false })
      .reply_markup.inline_keyboard.flat().some(button => button.url), false, section);
  }

  // ---- требования платёжного провайдера ------------------------------------
  const info = onboardingPage('info', { ...links, reviewMode: true });
  const infoButtons = info.reply_markup.inline_keyboard.flat();
  // Четыре пункта обязаны быть ОТДЕЛЬНЫМИ кнопками: объединять документы нельзя.
  assert.match(infoButtons[0].text, /Тариф и оплата/);
  assert.match(infoButtons[1].text, /Пользовательское соглашение/);
  assert.match(infoButtons[2].text, /Политика конфиденциальности/);
  assert.match(infoButtons[3].text, /Поддержка/);
  assert.match(infoButtons[4].text, /Назад/);
  assert.equal(infoButtons.length, 5, 'ровно четыре пункта и возврат');
  assert.equal(infoButtons.filter(b => /документ/i.test(b.text)).length, 0,
    'документы не должны быть объединены в одну кнопку «Документы»');
  // Документы открываются отдельными постоянными страницами.
  assert.match(infoButtons[1].url, /terms\.html$/);
  assert.match(infoButtons[2].url, /privacy\.html$/);

  // Кодовое слово видно в режиме проверки и полностью исчезает вне его.
  assert.match(info.text, /Код проверки: pay/);
  assert.doesNotMatch(onboardingPage('info', { ...links, reviewMode: false }).text, /pay/i);
  // По умолчанию слово не появляется там, где его не просили.
  assert.doesNotMatch(onboardingPage('home', links).text, /Код проверки/);

  // Раздел доступен с главного экрана и не закрыт оплатой.
  assert.ok(main.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'kartochka:info'),
    'кнопка «Информация» обязана быть на главном экране');

  // Тариф: модель оплаты названа точно и не выдумана.
  const tariff = onboardingPage('tariff', links);
  assert.match(tariff.text, /Тариф и оплата/);
  assert.match(tariff.text, /без автоматического продления/);
  assert.doesNotMatch(tariff.text, /подписк/i, 'без автопродления это не подписка');
  // Цена назначена владельцем и берётся из единственного источника, а не вписана в текст.
  const { PLAN: TARIFF_PLAN, priceLabel: tariffPriceLabel } =
    await import(pathToFileURL(path.join(root, 'pricing.js')).href);
  assert.match(tariff.text, new RegExp(`Стоимость: ${tariffPriceLabel()}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'экран обязан показывать сумму из pricing.js');
  assert.match(tariff.text, new RegExp(`${TARIFF_PLAN.amount}\\s*₽`), 'сумма не показана');
  // Пока приём платежей выключен, экран обязан честно об этом сказать: цена есть, оплаты нет.
  assert.match(tariff.text, /Приём платежей пока не подключён/,
    'назначенная цена не должна выдавать выключенную оплату за работающую');
  assert.match(tariff.text, /деньги не списываются/);
  // Комиссии платёжного провайдера пользователю не показываются.
  assert.doesNotMatch(tariff.text, /9\s*%|8\s*%|5\s*%|эквайринг|СБП|крипт/i);
  // Платный доступ описан точно, без запрещённых формулировок.
  assert.match(tariff.text, /добровольно разрешили/);
  assert.match(tariff.text, /не становитесь владельцем/);
  assert.match(tariff.text, /не гарантируется/);
  assert.doesNotMatch(tariff.text, /прода(жа|ём)|аренд|обход/i);

  // Поддержка ведёт к созданию обращения, а не в группу.
  const help = onboardingPage('help', links);
  assert.match(help.text, /одним сообщением/);
  assert.ok(help.reply_markup.inline_keyboard.flat().some(b => b.callback_data === 'kartochka:ticket'));
  assert.equal(help.reply_markup.inline_keyboard.flat().some(b => /t\.me\/.*chat|group|группа/i.test(b.url || '')), false,
    'группа не считается выполнением требования');
  // Из режима обращения должен быть явный выход.
  assert.match(onboardingPage('ticket', links).text, /Отменить|выйти/i);
  assert.ok(onboardingPage('ticket', links).reply_markup.inline_keyboard.flat()
    .some(b => /Отменить/.test(b.text)));

  for (const section of ['home', 'features', 'quick', 'premium', 'action', 'backtap', 'android', 'plans', 'info', 'tariff', 'help', 'ticket']) {
    const built = onboardingPage(section, links);
    assert(built.text.length <= 1024, `${section} photo caption exceeds Telegram limit`);
    assert(built.reply_markup.inline_keyboard.every(row => row.length <= 2), `${section} crams a row with buttons`);
    assert(built.reply_markup.inline_keyboard.flat().some(button => button.callback_data), `${section} has no way out`);
  }
  console.log('PASS onboarding screens, four-section menu, quick-access tree, truthful plans and safe links');

  // ---- bot integration: the update handler against a mocked Telegram API ----
  let server = null;
  const calls = [];
  let coverWorks = false;      // whether Telegram accepts the welcome cover media
  const KNOWN_METHODS = new Set([
    'getMe', 'getWebhookInfo', 'setWebhook', 'setMyCommands', 'setMyDescription',
    'setMyShortDescription', 'setMyName', 'setChatMenuButton', 'sendMessage', 'sendPhoto', 'sendAnimation',
    'editMessageText', 'editMessageCaption', 'answerCallbackQuery', 'answerPreCheckoutQuery',
    'getChatMenuButton'
  ]);
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
  let ticketState = [];        // support_ticket_state
  const tickets = [];          // support_tickets
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
    if (target.startsWith(`${env.SUPABASE_URL}/rest/v1/support_ticket_state`)) {
      const method = (options.method || 'GET').toUpperCase();
      if (method === 'POST') { ticketState = [JSON.parse(options.body)]; return Response.json({}); }
      if (method === 'DELETE') { ticketState = []; return Response.json({}); }
      return Response.json(ticketState.map(row => ({ expires_at: row.expires_at })));
    }
    if (target.startsWith(`${env.SUPABASE_URL}/rest/v1/support_tickets`)) {
      tickets.push(JSON.parse(options.body));
      return Response.json({});
    }
    if (target.includes('api.telegram.org/bot')) {
      const method = target.split('/').at(-1);
      const payload = JSON.parse(options.body || '{}');
      calls.push({ method, payload });
      if (method === 'getMe') return Response.json({ ok: true, result: { username: 'KartochkaWalletBot' } });
      if (method === 'getWebhookInfo') return Response.json({ ok: true, result: { url: `${env.SUPABASE_URL}/functions/v1/telegram` } });
      // Telegram refuses media it cannot fetch, exactly as it would for a missing file.
      if ((method === 'sendPhoto' || method === 'sendAnimation') && !coverWorks) {
        return Response.json({ ok: false, description: 'Bad Request: wrong file identifier' }, { status: 400 });
      }
      if ((method === 'editMessageText' || method === 'editMessageCaption') && !editResult.ok) {
        return Response.json({ ok: false, description: editResult.description }, { status: 400 });
      }
      // Telegram answers an unknown method with "method not found". Today no Bot API method
      // lets a bot change its own avatar, so the probe must see exactly that.
      if (!KNOWN_METHODS.has(method)) {
        return Response.json({ ok: false, description: 'Not Found: method not found' }, { status: 404 });
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

    // Runs while the module has not yet looked for cover media, so the whole ladder is visible.
    await check('the welcome tries animation, then photo, then plain text', async () => {
      reset();
      assert.equal((await dispatch(message('/start'))).status, 200);
      const order = calls.map(item => item.method).filter(method => /^send/.test(method));
      assert.equal(order[0], 'sendAnimation', 'an animation is preferred over a still picture');
      assert.ok(order.includes('sendPhoto'), 'a still picture is the second choice');
      assert.equal(order.at(-1), 'sendMessage', 'with no media the welcome still arrives');

      // The caption and the grid ride along with the media, not only with the text message.
      const animation = calls.find(item => item.method === 'sendAnimation');
      // MP4 предпочтён намеренно: тот же ролик в 960x540 весит в разы меньше GIF.
      assert.match(animation.payload.animation, /assets\/branding\/welcome\.mp4$/, 'MP4 must be preferred');
      assert.match(animation.payload.caption, /все скидочные карты в одном месте/);
      assert.ok(animation.payload.caption.length <= 1024, 'caption must fit under the animation');
      assert.deepEqual(animation.payload.reply_markup.inline_keyboard.map(row => row.length), [1, 1, 2, 2, 1]);
    });

    await check('the welcome grid carries working launch buttons', async () => {
      reset();
      assert.equal((await dispatch(message('/start'))).status, 200);
      const welcome = calls.find(item => item.method === 'sendMessage');
      assert.match(welcome.payload.text, /все скидочные карты в одном месте/);
      const rows = welcome.payload.reply_markup.inline_keyboard;
      assert.deepEqual(rows.map(row => row.length), [1, 1, 2, 2, 1]);
      assert.equal(new URL(rows[0][0].web_app.url).searchParams.get('startapp'), 'add');
      assert.equal(rows[1][0].web_app.url, env.TELEGRAM_WEB_APP_URL);
    });

    await check('a repeated /start does not hammer Telegram with media retries', async () => {
      reset();
      assert.equal((await dispatch(message('/start'))).status, 200);
      assert.equal((await dispatch(message('/start'))).status, 200);
      assert.equal(calls.filter(item => item.method === 'sendMessage').length, 2, 'one welcome per /start');
      assert.equal(calls.some(item => /^send(Animation|Photo)$/.test(item.method)), false,
        'media known to be missing must not be retried on every /start');
    });

    await check('the cover is used once Telegram accepts it', async () => {
      reset();
      coverWorks = true;
      // Past the negative-cache window the bot looks again, so media added later is picked up.
      const realNow = Date.now;
      Date.now = () => realNow() + 400000;
      try {
        assert.equal((await dispatch(message('/start'))).status, 200);
      } finally { Date.now = realNow; }
      const cover = calls.find(item => item.method === 'sendAnimation');
      assert.ok(cover, 'the animation must be retried after the window');
      assert.equal(calls.some(item => item.method === 'sendMessage'), false, 'no duplicate text welcome');
      coverWorks = false;
    });

    await check('a section edits the same message instead of sending a new one', async () => {
      reset();
      assert.equal((await dispatch(press('kartochka:premium'))).status, 200);
      assert.ok(calls.find(item => item.method === 'answerCallbackQuery'), 'the button must be acknowledged');
      const edited = calls.find(item => item.method === 'editMessageText');
      assert.match(edited.payload.text, /Premium — скоро/);
      assert.equal(calls.some(item => item.method === 'sendMessage'), false, 'no extra message per step');
      assert.ok(edited.payload.reply_markup.inline_keyboard.flat()
        .some(button => button.callback_data === 'kartochka:home'), 'every section returns home');
    });

    await check('a welcome animation is edited as a caption, not as text', async () => {
      for (const shape of [{ photo: [{ file_id: 'x' }] }, { animation: { file_id: 'a' } }]) {
        reset();
        assert.equal((await dispatch(press('kartochka:premium', shape))).status, 200);
        assert.ok(calls.find(item => item.method === 'editMessageCaption'), `caption edit for ${Object.keys(shape)[0]}`);
        assert.equal(calls.some(item => item.method === 'editMessageText'), false);
      }
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

    await check('/menu opens the main screen directly', async () => {
      reset();
      assert.equal((await dispatch(message('/menu'))).status, 200);
      const sent = calls.find(item => item.method === 'sendMessage');
      assert.match(sent.payload.text, /все скидочные карты в одном месте/);
      assert.deepEqual(sent.payload.reply_markup.inline_keyboard.map(row => row.length), [1, 1, 2, 2, 1]);
    });

    await check('a quick deep link opens the wallet without the presentation', async () => {
      reset();
      assert.equal((await dispatch(message('/start quick'))).status, 200);
      const sent = calls.find(item => item.method === 'sendMessage');
      assert.doesNotMatch(sent.payload.text, /Что умеет «Карточка»|Больше не нужно искать/, 'quick launch must skip the presentation');
      assert.ok(sent.payload.reply_markup.inline_keyboard.flat().some(button => button.web_app || button.url));
      assert.equal(calls.some(item => item.method === 'sendPhoto'), false, 'quick launch must not send the welcome picture');
    });

    await check('снятая /support не зависает, а открывает главный экран', async () => {
      reset();
      assert.equal((await dispatch(message('/support'))).status, 200);
      const sent = calls.find(item => item.method === 'sendMessage');
      assert.ok(sent, 'старая команда обязана получить ответ');
      assert.match(sent.payload.text, /КАРТОЧКА/, 'ведёт на главный экран');
      assert.equal(/поддержк/i.test(sent.payload.text), false, 'раздела поддержки больше нет');
      reset();
      assert.equal((await dispatch(message('/plans'))).status, 200);
      assert.ok(calls.find(item => item.method === 'sendMessage' && /Premium — скоро/.test(item.payload.text)));
    });

    await check('старый callback поддержки подтверждается и ведёт в меню', async () => {
      reset();
      assert.equal((await dispatch(press('kartochka:support'))).status, 200);
      assert.ok(calls.find(item => item.method === 'answerCallbackQuery'), 'индикатор обязан сняться');
      const edited = calls.find(item => item.method === 'editMessageText');
      assert.ok(edited, 'экран обязан смениться');
      assert.match(edited.payload.text, /КАРТОЧКА/);
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
      for (const command of ['start', 'menu', 'quick']) {
        assert.ok(commands.includes(command), `/${command} must be registered`);
      }
      // Поддержка снята с публикации: в списке команд её быть не должно.
      assert.equal(commands.includes('support'), false, '/support больше не публикуется');
      // The card Telegram shows before Start is published through the documented methods.
      assert.equal(calls.find(item => item.method === 'setMyName').payload.name, 'Карточка');
      const description = calls.find(item => item.method === 'setMyDescription').payload.description;
      assert.match(description, /цифровой кошелёк для скидочных карт/i);
      assert.ok(description.length <= 512, 'setMyDescription caps at 512 characters');
      const short = calls.find(item => item.method === 'setMyShortDescription').payload.short_description;
      assert.match(short, /Все скидочные карты в одном месте/i);
      assert.ok(short.length <= 120, 'setMyShortDescription caps at 120 characters');
      assert.doesNotMatch(description + short, /SGX|Planner/i);
    });

    await check('the avatar probe never uploads anything by accident', async () => {
      reset();
      const response = await dispatch({ action: 'brand' });
      assert.equal(response.status, 200);
      const body = await response.json();
      // This Bot API mock answers "method not found", which is the real answer today.
      assert.equal(body.avatar.api_can_set, false);
      assert.match(body.avatar.botfather, /Edit Botpic/);
      // The probe must never carry a photo: it may not change the avatar as a side effect.
      for (const call of calls.filter(item => /^setMy(ProfilePhoto|Photo)$/.test(item.method))) {
        assert.equal(Object.keys(call.payload).length, 0, `${call.method} probe must send no photo`);
      }
      assert.equal(body.avatar.applied, null, 'nothing is uploaded while the API cannot do it');
      assert.equal(body.avatar.api_probe, 'no', 'a 404 is definite evidence the method is absent');
    });

    await check('a transport failure is reported as unknown, never as "can set"', async () => {
      reset();
      const realFetch = globalThis.fetch;
      globalThis.fetch = async (url, options) => {
        if (String(url).includes('/setMyProfilePhoto')) throw new Error('network down');
        return realFetch(url, options);
      };
      let body;
      try { body = await (await dispatch({ action: 'brand' })).json(); }
      finally { globalThis.fetch = realFetch; }
      assert.equal(body.avatar.api_probe, 'unknown', 'a blip must not be read as proof');
      assert.equal(body.avatar.api_can_set, false);
      assert.equal(body.avatar.applied, null, 'an unproven method must never be called with a photo');
      assert.equal(calls.some(item => item.payload && item.payload.photo && /^setMy/.test(item.method)), false);
    });

    await check('the brand report names the configured avatar source', async () => {
      reset();
      const body = await (await dispatch({ action: 'brand' })).json();
      assert.equal(body.avatar.source_configured, true, 'a repo path is a valid source');
      assert.equal(typeof body.avatar.source_reachable, 'boolean');
    });

    await check('brand and diagnose need the webhook secret', async () => {
      for (const action of ['brand', 'diagnose']) {
        assert.equal((await dispatch({ action }, 'incorrect')).status, 401, action);
      }
    });

    await check('обращение создаётся только после явного входа в режим', async () => {
      reset(); tickets.length = 0; ticketState = [];
      // Обычный текст без входа в режим обращением не становится.
      await dispatch(message('просто сообщение'));
      assert.equal(tickets.length, 0, 'случайный текст не должен становиться обращением');
      assert.ok(calls.find(item => item.method === 'sendMessage' && /Не понял команду/.test(item.payload.text)));

      // Вход в режим и отправка обращения.
      reset();
      await dispatch(press('kartochka:ticket'));
      assert.equal(ticketState.length, 1, 'режим ожидания обязан включиться');
      await dispatch(message('не открывается карта Пятёрочки'));
      assert.equal(tickets.length, 1, 'обращение обязано создаться');
      assert.equal(tickets[0].message, 'не открывается карта Пятёрочки');
      assert.equal(tickets[0].status, 'open');
      assert.ok(tickets[0].ticket_no, 'обращению обязан присваиваться номер');
      const confirmation = calls.filter(item => item.method === 'sendMessage').pop();
      assert.match(confirmation.payload.text, /Обращение №/);
      assert.match(confirmation.payload.text, new RegExp(tickets[0].ticket_no));
      assert.equal(ticketState.length, 0, 'режим обязан сбрасываться после отправки');
    });

    await check('отмена выводит из режима, и следующий текст не станет обращением', async () => {
      reset(); tickets.length = 0; ticketState = [];
      await dispatch(press('kartochka:ticket'));
      assert.equal(ticketState.length, 1);
      // «Отменить» ведёт на экран поддержки — это и есть выход из режима.
      await dispatch(press('kartochka:help'));
      assert.equal(ticketState.length, 0, 'отмена обязана сбросить режим');
      await dispatch(message('случайное сообщение после отмены'));
      assert.equal(tickets.length, 0, 'после отмены текст не должен становиться обращением');
    });

    await check('команда во время режима не превращается в обращение', async () => {
      reset(); tickets.length = 0; ticketState = [];
      await dispatch(press('kartochka:ticket'));
      await dispatch(message('/menu'));
      assert.equal(tickets.length, 0, 'команда не должна становиться обращением');
      assert.equal(ticketState.length, 0, 'команда обязана выводить из режима');
    });

    await check('/info открывает документы и поддержку без оплаты', async () => {
      reset();
      assert.equal((await dispatch(message('/info'))).status, 200);
      const sent = calls.find(item => item.method === 'sendMessage');
      assert.match(sent.payload.text, /Информация/);
      assert.match(sent.payload.text, /Код проверки: pay/);
      const buttons = sent.payload.reply_markup.inline_keyboard.flat();
      assert.ok(buttons.some(b => /terms\.html$/.test(b.url || '')));
      assert.ok(buttons.some(b => /privacy\.html$/.test(b.url || '')));
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
