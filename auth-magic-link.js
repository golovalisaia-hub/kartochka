/* Accept Supabase implicit-flow magic-link callbacks and convert them into the session format used by cloud.js. */
(() => {
  'use strict';

  const SESSION_KEY = 'kartochka.supabase-session.v1';
  const config = window.KARTOCHKA_CONFIG || {};
  const baseUrl = String(config.supabaseUrl || '').replace(/\/+$/, '');
  const anonKey = String(config.supabaseAnonKey || '').trim();

  function parseAuthParams() {
    const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
    const query = new URLSearchParams(location.search);
    const get = key => hash.get(key) || query.get(key) || '';
    return {
      accessToken: get('access_token'),
      refreshToken: get('refresh_token'),
      tokenType: get('token_type') || 'bearer',
      expiresIn: Number(get('expires_in') || 0),
      error: get('error_description') || get('error') || ''
    };
  }

  function cleanAuthUrl() {
    if (!location.hash && !/[?&](access_token|refresh_token|error|error_description)=/.test(location.search)) return;
    history.replaceState({}, document.title, location.pathname + location.search
      .replace(/([?&])(access_token|refresh_token|token_type|expires_in|expires_at|error|error_description)=[^&]*/g, '$1')
      .replace(/[?&]+$/, '')
      .replace('?&', '?'));
  }

  async function consumeMagicLink() {
    const auth = parseAuthParams();
    if (auth.error) {
      cleanAuthUrl();
      try { sessionStorage.setItem('kartochka.auth-message.v1', 'Ссылка для входа недействительна или уже истекла. Запросите новое письмо.'); } catch (_) {}
      return;
    }
    if (!auth.accessToken || !baseUrl || !anonKey) return;

    try {
      const response = await fetch(`${baseUrl}/auth/v1/user`, {
        headers: {
          apikey: anonKey,
          Authorization: `Bearer ${auth.accessToken}`
        }
      });
      if (!response.ok) throw new Error(`user ${response.status}`);
      const user = await response.json();
      const session = {
        access_token: auth.accessToken,
        refresh_token: auth.refreshToken,
        token_type: auth.tokenType,
        expires_in: auth.expiresIn || 3600,
        expires_at: Math.floor(Date.now() / 1000) + (auth.expiresIn || 3600),
        user
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      try { sessionStorage.setItem('kartochka.auth-message.v1', 'Вход выполнен по ссылке из письма.'); } catch (_) {}
      cleanAuthUrl();
      location.reload();
    } catch (_) {
      cleanAuthUrl();
      try { sessionStorage.setItem('kartochka.auth-message.v1', 'Не удалось завершить вход по ссылке. Запросите новое письмо и попробуйте снова.'); } catch (_) {}
    }
  }

  consumeMagicLink();
})();
