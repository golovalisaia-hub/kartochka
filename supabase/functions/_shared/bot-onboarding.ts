// Pure copy and keyboard builder for the Telegram bot's introductory flow.
// The bot profile imagery belongs to the owner; no assets are replaced here.
const prefix = 'kartochka:';

export function onboardingAction(data) {
  if (typeof data !== 'string' || !data.startsWith(prefix)) return null;
  const page = data.slice(prefix.length);
  return ['home', 'features', 'premium', 'action', 'backtap', 'plans', 'support'].includes(page) ? page : null;
}

function callback(text, page) {
  return { text, callback_data: prefix + page };
}

export function onboardingPage(page, { appUrl = '', quickUrl = '', supportUrl = '', available = false } = {}) {
  const appButton = available && /^https:\/\//i.test(appUrl)
    ? [{ text: '💳 Открыть приложение', web_app: { url: appUrl } }]
    : [];
  const quickButton = available && /^https:\/\/t\.me\/[a-zA-Z0-9_]+\?startapp=quick&mode=compact$/.test(quickUrl)
    ? [{ text: '⚡ Быстрый кошелёк', url: quickUrl }]
    : [];
  const safeSupport = /^https:\/\/(t\.me|telegram\.me)\/[a-zA-Z0-9_]+(?:\?.*)?$/.test(supportUrl);
  const back = page === 'home' ? [] : [[callback('← Назад к возможностям', 'features'), callback('⌂ В начало', 'home')]];

  switch (page) {
    case 'home':
      return {
        text: '💳 Карточка — скидочные карты под рукой.\n\nСобирайте карты магазинов в одном кошельке, быстро открывайте штрихкоды и находите нужную карту без долгого поиска.\n\nСейчас идёт закрытый тест: используйте только вымышленные карты, реальные платежи выключены.\n\nНажмите «Начать», чтобы узнать, как всё работает.',
        reply_markup: { inline_keyboard: [[callback('🚀 Начать', 'features')]] }
      };
    case 'features':
      return {
        text: '✨ Что умеет «Карточка»?\n\n• Хранит ваши скидочные карты в личном кошельке.\n• Показывает QR-код или штрихкод для кассы.\n• Позволяет быстро открыть недавно просмотренные карты.\n• Помогает настроить запуск жестом телефона.\n\nОбщий каталог и Premium пока в разработке; реальная покупка и публикация чужих карт отключены.' + (available ? '' : '\n\n⚠️ Тестовое приложение пока недоступно по публичному адресу.'),
        reply_markup: { inline_keyboard: [
          ...(appButton.length ? [appButton] : []),
          ...(quickButton.length ? [quickButton] : []),
          [callback('📱 Кнопка действия', 'action'), callback('👆 Двойное касание', 'backtap')],
          [callback('⭐ Premium', 'premium'), callback('💰 Тарифы', 'plans')],
          [callback('🛟 Поддержка', 'support')],
          [callback('⌂ На главную', 'home')]
        ] }
      };
    case 'premium':
      return {
        text: '⭐ Premium — будущие возможности\n\nПланируется однократная покупка без ежемесячного списания. Общий каталог будет доступен только для карт, обмен которыми разрешён правилами соответствующей программы.\n\nВ закрытом тесте покупки и доступ к реальным чужим картам выключены. Стоимость и дата запуска ещё не подтверждены.',
        reply_markup: { inline_keyboard: [...back] }
      };
    case 'plans':
      return {
        text: '💰 Тарифы\n\nЛичный кошелёк — добавление и просмотр собственных скидочных карт.\n\nPremium — планируемый разовый доступ к разрешённым дополнительным функциям. Это не ежемесячная подписка.\n\nОплата сейчас недоступна: закрытый тест не принимает реальные платежи. Не оплачивайте доступ по сторонним ссылкам.',
        reply_markup: { inline_keyboard: [...back] }
      };
    case 'action':
      return {
        text: '📱 Кнопка действия на iPhone\n\nНа совместимой модели создайте команду в приложении «Команды», которая открывает ссылку быстрого кошелька. Затем назначьте эту команду через настройки кнопки действия.\n\nОбычное двойное нажатие боковой кнопки iPhone переназначить на Telegram нельзя. Переход в Mini App может потребовать подтверждения iOS.' + (quickButton.length ? '\n\nСсылка быстрого запуска — кнопка ниже.' : '\n\nСсылка появится, когда тестовый сайт станет публично доступен.'),
        reply_markup: { inline_keyboard: [...(quickButton.length ? [quickButton] : []), ...back] }
      };
    case 'backtap':
      return {
        text: '👆 Двойное касание сзади iPhone\n\n1. В «Командах» создайте команду «Открыть URL» со ссылкой на быстрый кошелёк.\n2. Откройте Настройки → Универсальный доступ → Касание → Касание задней панели.\n3. Выберите «Двойное касание» и назначьте созданную команду.\n\nНа Android похожие жесты зависят от модели. Не все устройства позволяют открыть именно ссылку Mini App. iOS также может запросить подтверждение.' + (quickButton.length ? '\n\nСсылка быстрого запуска — кнопка ниже.' : '\n\nСсылка появится после публикации приложения.'),
        reply_markup: { inline_keyboard: [...(quickButton.length ? [quickButton] : []), ...back] }
      };
    case 'support':
      return {
        text: safeSupport
          ? '🛟 Поддержка «Карточки»\n\nНажмите кнопку ниже, чтобы обратиться в поддержку. Не отправляйте пароли, токены и полные номера карт.'
          : '🛟 Поддержка «Карточки»\n\nКонтакт поддержки пока не подключён. Мы не будем обещать ответ на сообщения, которые сейчас некуда доставить. Не отправляйте пароли, токены и номера карт.',
        reply_markup: { inline_keyboard: [...(safeSupport ? [[{ text: 'Написать в поддержку', url: supportUrl }]] : []), ...back] }
      };
    default:
      return onboardingPage('home', { appUrl, quickUrl, supportUrl, available });
  }
}
