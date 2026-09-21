(() => {
  'use strict';

  let webApp = null;
  let initData = '';
  let telegramUser = null;

  function loadTelegramSdk() {
    if (window.Telegram?.WebApp || document.querySelector('script[data-telegram-sdk]')) return;
    const install = () => {
      if (window.Telegram?.WebApp || document.querySelector('script[data-telegram-sdk]')) return;
      const script = document.createElement('script');
      script.async = true;
      script.dataset.telegramSdk = '1';
      script.src = 'https://telegram.org/js/telegram-web-app.js?59';
      document.head.append(script);
    };
    if (document.readyState === 'complete') install();
    else window.addEventListener('load', install, { once: true });
  }

  function findTelegram() {
    const candidate = window.Telegram?.WebApp;
    if (!candidate?.initData) return false;
    webApp = candidate;
    initData = candidate.initData;
    telegramUser = candidate.initDataUnsafe?.user || null;
    return true;
  }

  async function detect() {
    loadTelegramSdk();
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (findTelegram()) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!webApp) return false;
    document.documentElement.classList.add('telegram-mini-app');
    try {
      webApp.ready();
      webApp.expand();
      webApp.setHeaderColor?.('#09090a');
      webApp.setBackgroundColor?.('#09090a');
    } catch (_) {}
    return true;
  }

  const ready = detect();

  async function authenticate() {
    if (!(await ready)) return null;
    if (!window.KartochkaCloud?.loginWithTelegram) {
      throw new Error('Telegram-вход временно недоступен.');
    }
    return window.KartochkaCloud.loginWithTelegram(initData);
  }

  function displayName() {
    if (telegramUser?.username) return `@${telegramUser.username}`;
    return telegramUser?.first_name || 'Telegram';
  }

  window.KartochkaTelegram = {
    ready,
    active: () => Boolean(webApp && initData),
    authenticate,
    displayName,
    user: () => telegramUser,
    paymentMode: 'disabled'
  };
})();
