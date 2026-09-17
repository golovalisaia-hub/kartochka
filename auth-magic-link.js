/* Temporary link-based login for Supabase's default mail templates.
 * Never trust fragment tokens until /auth/v1/user validates them.
 * No service-role key, real email address or loyalty-card data in this source.
 */
(() => {
  'use strict';
  const SESSION = 'kartochka.supabase-session.v1';
  const CARDS = 'kartochka.cards.v1';
  const OWNER = 'kartochka.cloud-user.v1';
  const BACKUP = 'kartochka.magic-link-backup.v1';
  const config = window.KARTOCHKA_CONFIG || {};
  const base = String(config.supabaseUrl || '').replace(/\/+$/, '');
  const key = String(config.supabaseAnonKey || '');
  let initialized = false;

  function snapshot() {
    if (window.__kartochkaMagicBackup) return window.__kartochkaMagicBackup;
    try { return JSON.parse(sessionStorage.getItem(BACKUP) || 'null'); }
    catch (_) { return null; }
  }
  function cardCount(raw) {
    try { const items = JSON.parse(raw || '[]'); return Array.isArray(items) ? items.length : 0; }
    catch (_) { return 0; }
  }
  function recover(saved) {
    if (!saved) return;
    try {
      // The app may have cleared the active wallet while its old session expired.
      if (cardCount(saved.cards) && !cardCount(localStorage.getItem(CARDS))) {
        localStorage.setItem(CARDS, saved.cards);
      }
      if (saved.owner && !localStorage.getItem(OWNER)) localStorage.setItem(OWNER, saved.owner);
      if (saved.session && !localStorage.getItem(SESSION)) localStorage.setItem(SESSION, saved.session);
    } catch (_) { /* Keep the existing storage untouched if quota is exhausted. */ }
  }
  function clearBackup() {
    try { sessionStorage.removeItem(BACKUP); } catch (_) {}
    delete window.__kartochkaMagicBackup;
  }
  function issue(message) {
    const display = () => {
      const button = document.getElementById('accountButton');
      if (button) button.click();
      const error = document.getElementById('authError');
      if (error) { error.textContent = message; error.hidden = false; }
    };
    if (document.readyState === 'complete') display();
    else window.addEventListener('load', display, { once: true });
  }

  async function completeRedirect() {
    const parameters = new URLSearchParams(location.hash.replace(/^#/, ''));
    const hasCallback = parameters.has('access_token') || parameters.has('error') || parameters.has('error_code');
    if (!hasCallback) return;
    const saved = snapshot();
    // The fragment is never sent in an HTTP request, but still remove it promptly
    // from address bar and history, and do not log, display or persist it.
    history.replaceState(history.state, '', location.pathname + location.search);
    if (parameters.has('error') || parameters.has('error_code')) {
      recover(saved);
      clearBackup();
      issue('Ссылка не сработала или истекла. Запросите новое письмо. Ваши карты не удалены.');
      return;
    }
    const access = parameters.get('access_token');
    const refresh = parameters.get('refresh_token');
    const expiry = Number(parameters.get('expires_in'));
    if (!access || !refresh || !Number.isFinite(expiry) || expiry <= 0) {
      recover(saved);
      clearBackup();
      issue('Ссылка содержит неполную сессию. Запросите новое письмо.');
      return;
    }
    try {
      const response = await fetch(base + '/auth/v1/user', {
        headers: { apikey: key, Authorization: `Bearer ${access}` },
        cache: 'no-store'
      });
      if (!response.ok) throw new Error('Invalid or expired email session');
      const user = await response.json();
      if (!user?.id || !user?.email) throw new Error('Missing authenticated user');
      const previousOwner = saved?.owner || null;
      let previousUser = null;
      try { previousUser = JSON.parse(saved?.session || 'null')?.user?.id || null; } catch (_) {}
      const existingCount = cardCount(saved?.cards);
      if (existingCount && ((previousOwner && previousOwner !== user.id) ||
          (previousUser && previousUser !== user.id))) {
        recover(saved);
        clearBackup();
        issue('На устройстве есть карты другого аккаунта. Они не перенесены. Сохраните резервную копию и войдите в исходный аккаунт.');
        return;
      }
      recover(saved);
      // Do not overwrite another account's identity, even when its wallet is empty.
      if (previousOwner && previousOwner !== user.id) localStorage.removeItem(OWNER);
      const session = {
        access_token: access, refresh_token: refresh,
        token_type: 'bearer', expires_in: expiry,
        expires_at: Math.floor(Date.now() / 1000) + expiry,
        user
      };
      localStorage.setItem(SESSION, JSON.stringify(session));
      clearBackup();
      // app.js reads the stored session during initialization; a clean reload
      // is necessary because the callback arrived after its first initialization.
      location.reload();
    } catch (_) {
      recover(saved);
      clearBackup();
      issue('Не удалось проверить ссылку на сервере. Карты сохранены на устройстве; проверьте интернет и запросите новое письмо.');
    }
  }

  function setup() {
    if (initialized) return;
    const cloud = window.KartochkaCloud;
    const emailForm = document.getElementById('emailForm');
    const codeForm = document.getElementById('codeForm');
    if (!cloud?.sendCode || !emailForm || !codeForm) return;
    initialized = true;
    const message = emailForm.querySelector('.auth-copy');
    if (message) message.textContent = 'Введите почту. Мы отправим одноразовую ссылку для входа. Пароль не нужен. Пока это временный способ входа.';
    const send = document.getElementById('sendCodeButton');
    if (send) send.textContent = 'Получить ссылку';
    const copy = codeForm.querySelector('.auth-copy');
    if (copy) copy.textContent = 'Запрос на письмо принят сервером. Откройте письмо и нажмите ссылку для входа. Это ещё не подтверждает доставку.';
    const hiddenField = codeForm.querySelector('.form-field');
    if (hiddenField) hiddenField.hidden = true;
    const verify = document.getElementById('verifyCodeButton');
    if (verify) verify.hidden = true;
    const input = document.getElementById('authCode');
    if (input) { input.required = false; input.disabled = true; }
    const help = document.createElement('p');
    help.className = 'auth-copy';
    help.id = 'magicLinkHelp';
    help.textContent = 'Если письмо не приходит, проверьте «Спам». Владелец проекта должен выключить неисправный custom SMTP в Supabase; встроенная почта отправляет письма только участникам команды проекта.';
    const change = document.getElementById('changeEmail');
    codeForm.insertBefore(help, change);
    const resend = document.createElement('button');
    resend.type = 'button';
    resend.id = 'resendLink';
    resend.className = 'text-button auth-link';
    resend.textContent = 'Отправить ссылку ещё раз';
    codeForm.insertBefore(resend, change);
    let until = 0;
    const draw = () => {
      const left = Math.ceil((until - Date.now()) / 1000);
      resend.disabled = left > 0;
      resend.textContent = left > 0 ? `Повторить через ${left} с` : 'Отправить ссылку ещё раз';
    };
    const original = cloud.sendCode.bind(cloud);
    cloud.sendCode = async address => {
      try {
        const result = await original(address);
        until = Date.now() + 60_000;
        draw();
        return result;
      } catch (error) {
        if (error?.status === 429 || /rate.limit|too many/i.test(String(error?.message || ''))) {
          until = Date.now() + 60_000;
          draw();
        }
        throw error;
      }
    };
    resend.addEventListener('click', async () => {
      if (resend.disabled) return;
      const address = document.getElementById('sentEmail')?.textContent.trim();
      if (!address) return;
      resend.disabled = true;
      resend.textContent = 'Отправляем…';
      const error = document.getElementById('authError');
      if (error) error.hidden = true;
      try { await cloud.sendCode(address); }
      catch (failure) {
        if (error) { error.textContent = String(failure?.message || 'Не удалось отправить письмо.'); error.hidden = false; }
        draw();
      }
    });
    // No background network activity: this timer only updates the visible resend label.
    setInterval(() => { if (!codeForm.hidden && until > 0) draw(); }, 1000);
  }

  // The browser's default implicit magic link returns to the project's Site URL.
  // No OTP digits should be requested or entered in this temporary mode.
  completeRedirect();
  if (document.readyState === 'complete') setup();
  else {
    document.addEventListener('DOMContentLoaded', setup, { once: true });
    window.addEventListener('load', setup, { once: true });
  }
})();
