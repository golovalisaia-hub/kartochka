/*
 * Юридические страницы и единый источник цены.
 *
 * Банк открывает документы по прямой ссылке, без авторизации и без приложения, поэтому
 * страницы проверяются как самостоятельные: дата редакции, отсутствие шаблонных заглушек и
 * персональных данных, и соответствие текста фактической механике сервиса.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const TODAY = '24 сентября 2026';

(async () => {
  const failures = [];
  const check = async (name, body) => {
    try { await body(); console.log(`  ok  ${name}`); }
    catch (error) { failures.push(name); console.error(`  FAIL ${name}\n       ${error.message}`); }
  };

  // В HTML предложения разрываются переносами строк, поэтому для сверки формулировок
  // пробелы схлопываются: иначе проверка ловила бы вёрстку, а не смысл.
  const flatten = html => html.replace(/\s+/g, ' ');
  const terms = read('terms.html');
  const privacy = read('privacy.html');
  const termsText = flatten(terms);
  const privacyText = flatten(privacy);

  await check('у обоих документов видимая актуальная дата редакции', () => {
    for (const [name, html] of [['terms.html', terms], ['privacy.html', privacy]]) {
      assert.match(html, new RegExp(`Редакция от ${TODAY}`), `${name}: нет актуальной даты`);
      // Дата шаблона провайдера не должна остаться.
      assert.doesNotMatch(html, /01 августа 2026|08-01/, `${name}: осталась дата шаблона`);
    }
  });

  await check('в документах нет персональных данных и юридических реквизитов', () => {
    // Провайдер отдельно потребовал убрать их из публичной части.
    const forbidden = /\bИНН\b|\bОГРН\w*\b|\bООО\b|\bИП\s+[А-Я]|паспорт|\+7\s?\(?\d{3}/;
    for (const [name, html] of [['terms.html', terms], ['privacy.html', privacy]]) {
      assert.doesNotMatch(html, forbidden, `${name}: найдены реквизиты или личные данные`);
    }
  });

  await check('нет шаблонных заглушек и чужих названий', () => {
    const placeholders = /ваш сайт|ваш бот|название проекта|\{\{|\[вставьте|lorem|telegra\.ph/i;
    for (const [name, html] of [['terms.html', terms], ['privacy.html', privacy]]) {
      assert.doesNotMatch(html, placeholders, `${name}: остались заглушки шаблона`);
      assert.match(html, /Карточка/, `${name}: не названо имя сервиса`);
    }
  });

  await check('соглашение описывает реальный продукт, а не шаблонные «обучающие материалы»', () => {
    // Формулировки из шаблона провайдера к «Карточке» отношения не имеют.
    assert.doesNotMatch(termsText, /обучающ|вебинар|консультац|аналитическ(ий|ие) обзор/i);
    assert.match(termsText, /дисконтных карт|карт лояльности/);
    assert.match(termsText, /добровольно разрешили/);
    assert.match(termsText, /не становится владельцем/);
    assert.match(termsText, /отозвать разрешение|отзыв/i);
    assert.match(termsText, /не<\/strong>? ?гарантируется|не гарантируется/);
    assert.match(termsText, /правила программы лояльности/i);
    // Заявлять партнёрство с сетями нельзя.
    assert.match(termsText, /не является участником программ лояльности|не заявляет о партнёрстве/);
    assert.doesNotMatch(termsText, /партнёр(ом|ство) (Пятёрочки|Ленты|Магнита)/i);
  });

  await check('возврат не урезает права пользователя по закону', () => {
    assert.match(termsText, /применимым законодательством/);
    assert.doesNotMatch(termsText, /возврат (не производится|невозможен) (во всех|в любых)/i);
  });

  await check('политика описывает только те данные, которые сервис реально обрабатывает', () => {
    // Приложение действительно позволяет добавить карту фотографией — умалчивать нельзя.
    assert.match(privacyText, /Изображения карт/);
    assert.match(privacyText, /на устройстве<\/strong>? ?Пользователя|на устройстве Пользователя/, 'распознавание кода идёт на клиенте');
    assert.match(privacyText, /Telegram/);
    assert.match(privacyText, /номер карты|содержимое штрихкода/);
    assert.match(privacyText, /обращени/i);
    // Про платёжные реквизиты нельзя утверждать, что мы их храним.
    assert.match(privacyText, /на серверы Сервиса не передаются и не хранятся/);
    // Телефон Telegram сервис не запрашивает — так и написано.
    assert.match(privacyText, /Номер телефона Telegram Сервис не запрашивает/);
  });

  await check('политика честно описывает, что видят другие пользователи', () => {
    assert.match(privacyText, /не узнаёт, кто именно воспользовался/);
    assert.match(privacyText, /ни имени, ни username/);
    assert.match(privacyText, /не передаются ни при каких условиях/);
  });

  await check('копия тарифа для бота не разошлась с корневой', async () => {
    // Бот не может импортировать файл из корня: Supabase бандлит только каталог функций.
    // Поэтому копия внутри каталога сверяется здесь — иначе цена разойдётся незаметно.
    const rootPricing = await import(pathToFileURL(path.join(root, 'pricing.js')).href);
    const botPricing = await import(pathToFileURL(path.join(root, 'supabase/functions/_shared/pricing.ts')).href);
    assert.equal(botPricing.ACCESS_MODEL, rootPricing.ACCESS_MODEL, 'модель доступа разошлась');
    assert.equal(botPricing.PAYMENTS_ENABLED, rootPricing.PAYMENTS_ENABLED, 'флаг приёма платежей разошёлся');
    assert.deepEqual(botPricing.PLAN, rootPricing.PLAN, 'параметры тарифа разошлись');
    assert.equal(botPricing.priceLabel(), rootPricing.priceLabel(), 'строка стоимости разошлась');
    assert.equal(botPricing.accessModelLabel(), rootPricing.accessModelLabel(), 'описание модели разошлось');
  });

  await check('цена берётся из единственного источника и не выдумана', async () => {
    const pricing = await import(pathToFileURL(path.join(root, 'pricing.js')).href);
    // Сумма назначена владельцем: она должна быть положительным числом, а не строкой из текста.
    assert.equal(pricing.priceIsPublished(), true, 'цена не опубликована');
    assert.ok(Number.isInteger(pricing.PLAN.amount) && pricing.PLAN.amount > 0,
      'цена обязана быть положительным целым числом рублей');
    assert.equal(pricing.PLAN.currency, 'RUB');
    assert.match(pricing.priceLabel(), new RegExp(`^${pricing.PLAN.amount} ₽ `),
      'строка стоимости обязана начинаться с назначенной суммы');
    assert.notEqual(pricing.priceLabel(), 'Стоимость уточняется');
    // Цена и доступность оплаты — разные факты: пока приём платежей выключен, сумма его не включает.
    assert.equal(pricing.PAYMENTS_ENABLED, false,
      'приём платежей включается только вместе с настоящей оплатой');
    // Модель установлена по коду: автопродления в проекте нет.
    assert.equal(pricing.PLAN.autoRenew, false);
    assert.match(pricing.accessModelLabel(), /без автоматического продления/);
    // Сумма не должна быть продублирована где-то ещё в интерфейсе.
    const uiFiles = ['index.html', 'terms.html', 'privacy.html'];
    for (const file of uiFiles) {
      assert.doesNotMatch(read(file), /\d+\s*₽/, `${file}: жёстко вписанная цена`);
    }
  });

  // Страницы должны открываться сами по себе, без приложения и без авторизации.
  const server = http.createServer((request, response) => {
    const route = decodeURIComponent(new URL(request.url, 'http://l').pathname);
    const target = path.resolve(root, `.${route}`);
    if (!target.startsWith(root + path.sep) || !fs.existsSync(target)) { response.writeHead(404); response.end(); return; }
    const type = target.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8';
    response.setHeader('Content-Type', type);
    fs.createReadStream(target).pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true });

  try {
    for (const [file, heading] of [['terms.html', 'Пользовательское соглашение'], ['privacy.html', 'Политика конфиденциальности']]) {
      await check(`${file} открывается и читается на телефоне`, async () => {
        const page = await browser.newPage({ viewport: { width: 360, height: 740 }, isMobile: true });
        const errors = [];
        page.on('pageerror', error => errors.push(String(error)));
        const response = await page.goto(`${base}/${file}`, { waitUntil: 'load' });
        assert.equal(response.status(), 200);
        assert.equal(await page.locator('h1').innerText(), heading);
        assert.match(await page.locator('.updated').innerText(), new RegExp(TODAY));
        // Ни горизонтальной прокрутки, ни ошибок страницы.
        const overflow = await page.evaluate(() =>
          document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.equal(overflow, 0, 'горизонтальная прокрутка на телефоне');
        assert.deepEqual(errors, []);
        await page.close();
      });
    }
  } finally {
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }

  if (failures.length) throw new Error(`${failures.length} проверок провалено: ${failures.join(', ')}`);
  console.log('PASS юридические страницы: дата, отсутствие реквизитов, реальная механика и единая цена');
})().catch(error => {
  console.error('LEGAL PAGES FAILURE', error);
  process.exitCode = 1;
});
