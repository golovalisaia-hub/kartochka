// Copy and keyboards for the Telegram bot's introduction. Pure functions: no network, no
// state, no secrets — so every screen and every button can be asserted in a unit test.
//
// The owner's imagery is never replaced here. A welcome picture is attached by the caller.
//
// Telegram caps a photo caption at 1024 characters. Every page below is written to fit, so
// any screen can be shown as a caption under the welcome picture without being truncated.
import { PLAN, priceIsPublished, priceLabel, accessModelLabel } from '../../../pricing.js';

const prefix = 'kartochka:';

/*
 * Единственный источник правды для оформления бота.
 *
 * Эти же значения использует и Edge Function, и скрипт tools/telegram-apply.sh, чтобы
 * настройка из терминала не разошлась с тем, что публикует {"action":"setup"}.
 * Лимиты Telegram: имя 64, короткое описание 120, описание 512 символов.
 */
export const BOT_NAME = 'Карточка';
export const BOT_SHORT_DESCRIPTION =
  'Все скидочные карты в одном месте. Открывай нужную карту прямо в Telegram.';
export const BOT_DESCRIPTION =
  'Карточка — твой цифровой кошелёк для скидочных карт.\n\n'
  + 'Добавляй карты магазинов по фотографии или вручную, быстро находи нужную и показывай штрихкод на кассе.\n\n'
  + 'Настрой быстрый доступ и открывай последние карты за секунды.';
export const BOT_COMMANDS = [
  { command: 'start', description: 'Знакомство с Карточкой' },
  { command: 'menu', description: 'Главное меню' },
  { command: 'quick', description: 'Быстрый доступ' },
  // Документы и поддержка должны находиться с первой попытки, в том числе из меню команд.
  { command: 'info', description: 'Тариф, документы и поддержка' }
];

// `plans` is kept as an alias of `premium`: messages already sitting in users' chats carry
// the old callback_data, and those buttons must keep working rather than silently failing.
const PAGES = ['home', 'features', 'quick', 'backtap', 'action', 'android', 'premium', 'plans',
               'support', 'info', 'tariff', 'help', 'ticket'];
// Страницы, которых больше нет в интерфейсе. Их callback_data приходит из сообщений,
// отправленных до изменения: нажатие обязано открыть главный экран, а не повиснуть.
const RETIRED_PAGES = new Set(['support', 'plans']);

export function onboardingAction(data) {
  if (typeof data !== 'string' || !data.startsWith(prefix)) return null;
  const page = data.slice(prefix.length);
  return PAGES.includes(page) ? page : null;
}

function callback(text, page) {
  return { text, callback_data: prefix + page };
}

const QUICK_LINK = /^https:\/\/t\.me\/[a-zA-Z0-9_]{5,32}\?startapp=quick&mode=compact$/;
const SUPPORT_LINK = /^https:\/\/(t\.me|telegram\.me)\/[a-zA-Z0-9_]{5,32}(?:\?.*)?$/;

// The Mini App reads `startapp` from its own URL, so a Web App button can ask for a screen.
// It selects a screen only — authentication is unchanged and happens inside the app.
function legalUrl(appUrl, file) {
  try { return new URL(file, appUrl).href; } catch (_) { return ''; }
}

function withRoute(appUrl, route) {
  try {
    const url = new URL(appUrl);
    url.searchParams.set('startapp', route);
    return url.href;
  } catch (_) { return appUrl; }
}

export function onboardingPage(page, {
  appUrl = '', quickUrl = '', supportUrl = '', available = false, reviewMode = false
} = {}) {
  // A launch button is only ever offered once the URL has been proven to serve the app.
  // A button that opens somebody's login page is worse than no button at all.
  const usable = available && /^https:\/\//i.test(appUrl);
  const appButton = usable
    ? [{ text: '💳 Открыть приложение', web_app: { url: appUrl } }]
    : [];
  const addButton = usable
    ? [{ text: '➕ Добавить карту', web_app: { url: withRoute(appUrl, 'add') } }]
    : [];
  const quickButton = available && QUICK_LINK.test(quickUrl)
    ? [{ text: '⚡ Недавние карты', url: quickUrl }]
    : [];
  const hasSupport = SUPPORT_LINK.test(supportUrl);
  const unavailable = '\n\n⚠️ Тестовое приложение пока недоступно по публичному адресу — кнопка запуска появится после публикации.';

  // Снятые разделы ведут на главный экран.
  if (RETIRED_PAGES.has(page) && page === 'support') page = 'home';
  const toMenu = callback('⌂ Главное меню', 'home');
  const toInfo = callback('⬅️ Назад', 'info');
  const terms = legalUrl(appUrl, 'terms.html');
  const privacy = legalUrl(appUrl, 'privacy.html');
  const toQuick = callback('← Быстрый доступ', 'quick');

  switch (page) {
    // The screen Telegram shows right after Start: caption under the cover animation plus
    // the action grid. `features` is the same screen, kept so that buttons already sitting
    // in users' chats keep working.
    case 'home':
    case 'features':
      return {
        text: 'КАРТОЧКА — все скидочные карты в одном месте.\n\n'
          + 'Добавляй карты любимых магазинов и открывай нужную за секунды прямо в Telegram.\n\n'
          + '💳 Карты\n'
          + '📷 Добавление по фото\n'
          + '🔎 Поиск\n'
          + '⚡ Недавние\n'
          + '📱 Быстрый запуск\n\n'
          + 'Добавь карту один раз — и она всегда под рукой.'
          + (available ? '' : unavailable),
        reply_markup: {
          inline_keyboard: [
            ...(addButton.length ? [addButton] : []),
            ...(appButton.length ? [appButton] : []),
            [callback('⚡ Кнопка действия', 'action'), callback('👆 Двойной тап', 'backtap')],
            [
              callback('⭐ Premium — скоро', 'premium'),
              // Недавние карты открываются сразу, без промежуточного экрана.
              ...(quickButton.length ? [{ text: '⚡ Недавние карты', url: quickUrl }] : [callback('⚡ Недавние карты', 'quick')])
            ],
            // Документы и поддержка доступны всегда, с первого экрана и без оплаты.
            [callback('ℹ️ Информация', 'info')]
          ]
        }
      };

    case 'quick':
      return {
        text: '⚡ Открывайте карты быстрее\n\n'
          + 'Кошелёк можно открыть одной ссылкой, а ссылку — назначить на жест телефона. '
          + 'После этого до штрихкода останется одно нажатие.\n\n'
          + 'Выберите, как вы хотите запускать «Карточку».'
          + (quickButton.length ? '' : '\n\n⚠️ Ссылка быстрого запуска появится после публикации приложения.'),
        reply_markup: {
          inline_keyboard: [
            [callback('👆 Двойное касание iPhone', 'backtap')],
            [callback('📱 Кнопка действия iPhone', 'action')],
            [callback('🤖 Android', 'android')],
            ...(quickButton.length ? [quickButton] : []),
            [toMenu]
          ]
        }
      };

    case 'backtap':
      return {
        text: '👆 Двойное касание задней панели iPhone\n\n'
          + '1. Откройте «Команды» → «+» → «Добавить действие».\n'
          + '2. Выберите «Открыть URL» и вставьте ссылку быстрого запуска.\n'
          + '3. Назовите команду «Карточка» и сохраните.\n'
          + '4. Настройки → Универсальный доступ → Касание → Касание задней панели → Двойное касание → «Карточка».\n\n'
          + 'Названия пунктов отличаются в разных версиях iOS. iOS может показать подтверждение открытия ссылки — это отдельный шаг, обойти его нельзя.',
        reply_markup: { inline_keyboard: [...(quickButton.length ? [quickButton] : []), [callback('🤖 Android', 'android'), toMenu]] }
      };

    case 'action':
      return {
        text: '📱 Кнопка «Действие» на iPhone\n\n'
          + '1. Создайте ту же команду «Карточка» с действием «Открыть URL».\n'
          + '2. Настройки → Кнопка «Действие».\n'
          + '3. Пролистайте до «Быстрая команда», нажмите «Выбрать» и укажите «Карточка».\n\n'
          + 'Кнопка «Действие» есть не на всех моделях. Двойное нажатие обычной боковой кнопки переназначить нельзя.',
        reply_markup: { inline_keyboard: [...(quickButton.length ? [quickButton] : []), [callback('🤖 Android', 'android'), toMenu]] }
      };

    case 'android':
      return {
        text: '🤖 Быстрый запуск на Android\n\n'
          + '• Надёжный способ: откройте ссылку в браузере и выберите «Добавить на главный экран» — получится ярлык в одно нажатие.\n'
          + '• Pixel: Настройки → Система → Жесты → Quick Tap.\n'
          + '• Samsung: Настройки → Дополнительные функции → Боковая кнопка → Двойное нажатие.\n\n'
          + 'Системные жесты Android часто умеют запускать только приложение, а не конкретную ссылку. Если жест открывает просто Telegram — используйте ярлык на главном экране.',
        reply_markup: { inline_keyboard: [...(quickButton.length ? [quickButton] : []), [toQuick, toMenu]] }
      };

    /*
     * Раздел «Информация». Четыре требования банка вынесены отдельными кнопками:
     * тариф, соглашение, политика и поддержка. Объединять документы в одну кнопку нельзя —
     * проверяющий должен видеть каждый пункт сразу.
     *
     * Раздел доступен всем и никогда не закрывается оплатой: новому пользователю,
     * пользователю без доступа и до совершения платежа.
     */
    case 'info': {
      const rows = [
        [callback('💳 Тариф и оплата', 'tariff')],
        terms ? [{ text: '📄 Пользовательское соглашение', url: terms }] : [],
        privacy ? [{ text: '🔒 Политика конфиденциальности', url: privacy }] : [],
        [callback('🆘 Поддержка', 'help')],
        [callback('⬅️ Назад', 'home')]
      ].filter(row => row.length);
      return {
        text: 'ℹ️ Информация\n\n'
          + 'Здесь находятся сведения о сервисе, оплате, юридические документы и связь с поддержкой.'
          + (terms && privacy ? '' : '\n\n⚠️ Документы станут доступны после публикации приложения.')
          + (reviewMode ? '\n\nКод проверки: pay' : ''),
        reply_markup: { inline_keyboard: rows }
      };
    }

    case 'tariff':
      return {
        text: '💳 Тариф и оплата\n\n'
          + `Тариф: ${PLAN.name}\n`
          + `Стоимость: ${priceLabel()}\n`
          + `Условие: ${accessModelLabel()}\n\n`
          + 'Что входит в платный доступ:\n'
          + 'Возможность использовать доступные в сервисе карты лояльности, владельцы которых '
          + 'добровольно разрешили их использование другими пользователями.\n\n'
          + 'Важно:\n'
          + '• вы не становитесь владельцем такой карты;\n'
          + '• владелец разрешает использование сам и может отозвать разрешение;\n'
          + '• наличие карты конкретного магазина не гарантируется;\n'
          + '• правила программы лояльности магазина соблюдает сам пользователь.\n\n'
          + 'Бесплатно и без оплаты: свои карты, добавление по фото и вручную, поиск, '
          + 'штрихкоды, недавние карты и синхронизация.\n\n'
          + (priceIsPublished()
              ? 'Стоимость указана до оплаты и не меняется на странице платёжной системы.'
              : 'Приём платежей пока не подключён: платный доступ не продаётся и деньги не списываются.'),
        reply_markup: { inline_keyboard: [[toInfo]] }
      };

    case 'help':
      return {
        text: '🆘 Поддержка\n\n'
          + 'Опишите проблему одним сообщением — мы создадим обращение с номером.\n\n'
          + 'Не отправляйте пароли, коды из писем и полные номера карт: для помощи они не нужны.',
        reply_markup: {
          inline_keyboard: [
            [callback('✍️ Написать обращение', 'ticket')],
            [toInfo]
          ]
        }
      };

    case 'ticket':
      return {
        text: '✍️ Новое обращение\n\n'
          + 'Отправьте следующим сообщением описание проблемы. Мы присвоим обращению номер.\n\n'
          + 'Чтобы выйти, нажмите «Отменить» — следующее сообщение тогда не станет обращением.',
        reply_markup: { inline_keyboard: [[callback('❌ Отменить', 'help')]] }
      };

    case 'premium':
    case 'plans':
      return {
        text: '⭐ Premium — скоро\n\n'
          + 'Premium и доступ к картам сообщества готовятся. Основной кошелёк продолжает работать бесплатно: '
          + 'свои карты, добавление, поиск, штрихкоды и недавние карты остаются без оплаты.\n\n'
          + 'Карты сообщества — это карты, которыми участники поделились добровольно. '
          + 'Владелец включает общий доступ сам и может отключить его в любой момент. '
          + 'Начисления зависят от правил конкретного магазина, поэтому обещать их нельзя.\n\n'
          + 'Оплата пока не подключена. Не оплачивайте доступ по сторонним ссылкам.',
        reply_markup: { inline_keyboard: [[toMenu]] }
      };


    default:
      return onboardingPage('home', { appUrl, quickUrl, supportUrl, available, reviewMode });
  }
}
