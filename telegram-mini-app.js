/*
 * Telegram Mini App integration.
 *
 * Deliberate behaviour, verified against https://core.telegram.org/bots/webapps:
 *  - The SDK is injected exactly once, from the documented URL, and never awaited forever.
 *  - ready() is called by the app only after the first screen has been prepared, so Telegram
 *    never reveals a blank or half-rendered wallet.
 *  - expand() is NEVER called automatically. Telegram opens Main Mini Apps at full height by
 *    default and `mode=compact` is a launch-link parameter, not something a Mini App can set
 *    from JavaScript. Quick mode therefore leaves the height exactly as Telegram gave it, and
 *    expansion only happens after a deliberate user action. Telegram offers no documented,
 *    reliable way back to compact height, so we never promise one.
 *  - initDataUnsafe is used for display only. Every authentication decision uses the raw
 *    initData string, which is verified by HMAC on the server.
 */
(() => {
  'use strict';

  const SDK_URL = 'https://telegram.org/js/telegram-web-app.js?63';
  const SDK_TIMEOUT_MS = 6000;
  const SDK_POLL_MS = 50;
  const KNOWN_MODES = new Set(['quick', 'normal']);

  let webApp = null;
  let initData = '';
  let telegramUser = null;
  let startParam = '';
  let failure = null;
  let backHandler = null;
  let backBound = false;
  const viewportListeners = new Set();

  function sanitizeStartParam(value) {
    const text = String(value || '').trim().toLowerCase();
    // start_param is attacker-controlled: it only ever selects a screen, never a permission.
    return /^[a-z0-9_-]{1,64}$/.test(text) ? text : '';
  }

  function readStartParamFromLocation() {
    const sources = [];
    try { sources.push(new URLSearchParams(window.location.search)); } catch (_) {}
    try { sources.push(new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''))); } catch (_) {}
    for (const params of sources) {
      const value = params.get('tgWebAppStartParam') || params.get('startapp');
      if (value) return sanitizeStartParam(value);
    }
    return '';
  }

  /*
   * Synchronous, cheap "are we inside Telegram at all?" test.
   *
   * Telegram hands a Mini App its launch parameters in the URL fragment and exposes a webview
   * proxy object, both available before the SDK finishes loading. An ordinary web page has
   * neither, so it must not pay for the SDK wait — and must not be held back from rendering.
   */
  function launchedFromTelegram() {
    if (window.Telegram?.WebApp?.initData) return true;
    if (window.TelegramWebviewProxy || window.TelegramWebviewProxyProto) return true;
    try {
      const marks = /tgWebAppData=|tgWebAppPlatform=|tgWebAppVersion=/;
      if (marks.test(String(window.location.hash || ''))) return true;
      if (marks.test(String(window.location.search || ''))) return true;
    } catch (_) {}
    return false;
  }

  function loadTelegramSdk() {
    if (window.Telegram?.WebApp) return;
    if (document.querySelector('script[data-telegram-sdk]')) return;
    const script = document.createElement('script');
    script.async = true;
    script.dataset.telegramSdk = '1';
    script.src = SDK_URL;
    script.addEventListener('error', () => { failure = 'sdk-unavailable'; }, { once: true });
    (document.head || document.documentElement).append(script);
  }

  function captureWebApp() {
    const candidate = window.Telegram?.WebApp;
    if (!candidate || typeof candidate.initData !== 'string' || !candidate.initData) return false;
    webApp = candidate;
    initData = candidate.initData;
    telegramUser = candidate.initDataUnsafe?.user || null;
    startParam = sanitizeStartParam(candidate.initDataUnsafe?.start_param) || readStartParamFromLocation();
    return true;
  }

  async function detect() {
    // Outside Telegram the launch parameters are absent; the site must keep working as a
    // normal web page instead of blocking on an SDK that will never deliver initData.
    if (!launchedFromTelegram()) {
      failure = 'not-telegram';
      startParam = readStartParamFromLocation();
      return false;
    }
    loadTelegramSdk();
    const deadline = Date.now() + SDK_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (captureWebApp()) break;
      await new Promise(resolve => setTimeout(resolve, SDK_POLL_MS));
    }
    if (!webApp) {
      if (!failure) failure = window.Telegram?.WebApp ? 'no-init-data' : 'sdk-timeout';
      startParam = readStartParamFromLocation();
      return false;
    }
    document.documentElement.classList.add('telegram-mini-app');
    document.documentElement.dataset.telegramMode = mode();
    try {
      webApp.setHeaderColor?.('#09090a');
      webApp.setBackgroundColor?.('#09090a');
      webApp.enableClosingConfirmation?.();
    } catch (_) {}
    bindViewport();
    return true;
  }

  function bindViewport() {
    const notify = () => {
      const size = viewport();
      applyViewportVariables(size);
      for (const listener of viewportListeners) {
        try { listener(size); } catch (_) {}
      }
    };
    try {
      webApp.onEvent?.('viewportChanged', notify);
      webApp.onEvent?.('safeAreaChanged', notify);
      webApp.onEvent?.('contentSafeAreaChanged', notify);
    } catch (_) {}
    notify();
  }

  function inset(source) {
    return {
      top: Number(source?.top || 0),
      bottom: Number(source?.bottom || 0),
      left: Number(source?.left || 0),
      right: Number(source?.right || 0)
    };
  }

  function applyViewportVariables(size) {
    const style = document.documentElement.style;
    // The stable height ignores the drag gesture, so critical controls never jump mid-drag.
    if (size.stableHeight > 0) {
      style.setProperty('--tg-stable-height', `${size.stableHeight}px`);
      // Only once a real measurement arrives may CSS stop trusting 100svh.
      document.documentElement.dataset.tgMeasured = '1';
    }
    if (size.height > 0) style.setProperty('--tg-viewport-height', `${size.height}px`);
    const safe = size.safeArea;
    const content = size.contentSafeArea;
    style.setProperty('--tg-safe-top', `${Math.max(safe.top, content.top)}px`);
    style.setProperty('--tg-safe-bottom', `${Math.max(safe.bottom, content.bottom)}px`);
    document.documentElement.dataset.telegramExpanded = size.expanded ? '1' : '0';
  }

  function viewport() {
    return {
      height: Number(webApp?.viewportHeight || 0),
      stableHeight: Number(webApp?.viewportStableHeight || 0),
      expanded: Boolean(webApp?.isExpanded),
      safeArea: inset(webApp?.safeAreaInset),
      contentSafeArea: inset(webApp?.contentSafeAreaInset)
    };
  }

  const ready = detect();

  function mode() {
    if (startParam === 'quick') return 'quick';
    // Any unknown or missing launch parameter falls back to the ordinary wallet.
    return 'normal';
  }

  function signalReady() {
    // Called by the app once the first screen is painted, never before.
    if (!webApp) return false;
    try { webApp.ready(); } catch (_) { return false; }
    return true;
  }

  function expand(reason = 'user-action') {
    // Only ever called after a deliberate user action. Telegram documents no way to return
    // to compact height afterwards, so callers must not promise one.
    if (!webApp || webApp.isExpanded) return false;
    if (reason === 'startup') return false;
    try { webApp.expand(); } catch (_) { return false; }
    return true;
  }

  function onViewportChange(listener) {
    if (typeof listener !== 'function') return () => {};
    viewportListeners.add(listener);
    if (webApp) listener(viewport());
    return () => viewportListeners.delete(listener);
  }

  const backButton = {
    show(handler) {
      if (!webApp?.BackButton) return false;
      backHandler = typeof handler === 'function' ? handler : null;
      if (!backBound) {
        // Registered exactly once; repeated screens only swap the stored handler.
        try { webApp.BackButton.onClick(() => backHandler?.()); } catch (_) { return false; }
        backBound = true;
      }
      try { webApp.BackButton.show(); } catch (_) { return false; }
      return true;
    },
    hide() {
      backHandler = null;
      if (!webApp?.BackButton) return false;
      try { webApp.BackButton.hide(); } catch (_) { return false; }
      return true;
    }
  };

  async function authenticate() {
    if (!(await ready)) return null;
    if (!window.KartochkaCloud?.loginWithTelegram) {
      throw new Error('Telegram-вход временно недоступен.');
    }
    // The raw initData string travels to the server, which re-computes the HMAC.
    return window.KartochkaCloud.loginWithTelegram(initData);
  }

  function displayName() {
    if (telegramUser?.username) return `@${telegramUser.username}`;
    return telegramUser?.first_name || 'Telegram';
  }

  window.KartochkaTelegram = {
    ready,
    likely: launchedFromTelegram,
    active: () => Boolean(webApp && initData),
    mode,
    startParam: () => startParam,
    knownMode: value => KNOWN_MODES.has(sanitizeStartParam(value)),
    signalReady,
    expand,
    isExpanded: () => Boolean(webApp?.isExpanded),
    viewport,
    onViewportChange,
    backButton,
    authenticate,
    displayName,
    user: () => telegramUser,
    failure: () => failure,
    sdkUrl: SDK_URL,
    paymentMode: 'disabled'
  };
})();
