/* Password-based Supabase Auth for static GitHub Pages. The password is sent only to Supabase Auth. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const SESSION_KEY = 'kartochka.supabase-session.v1';
  const APP_URL = 'https://golovalisaia-hub.github.io/kartochka/';
  const config = window.KARTOCHKA_CONFIG || {};
  const base = String(config.supabaseUrl || '').replace(/\/+$/, '');
  const key = String(config.supabaseAnonKey || '');
  let mode = 'login';
  let busy = false;

  async function authRequest(path, payload) {
    if (!window.KartochkaCloud?.configured?.()) throw new Error('Облачное хранилище пока не настроено.');
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { apikey: key, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.msg || result.message || result.error_description || result.error || `Ошибка сервера (${response.status})`);
    return result;
  }

  function message(text, error = false) {
    const element = $('passwordAuthMessage');
    if (!element) return;
    element.textContent = text;
    element.hidden = !text;
    element.style.color = error ? '#ffb0b5' : '#b7e8bf';
    if ($('authError')) $('authError').hidden = true;
  }

  function setMode(next) {
    mode = next;
    const signedIn = Boolean(window.KartochkaCloud?.user?.());
    $('authTitle').textContent = signedIn ? 'Ваш аккаунт' : next === 'signup' ? 'Регистрация' : 'Вход в Карточку';
    $('sendCodeButton').textContent = next === 'signup' ? 'Зарегистрироваться' : 'Войти';
    $('passwordAuthMode').textContent = next === 'signup' ? 'Уже есть аккаунт? Войти' : 'Нет аккаунта? Зарегистрироваться';
    $('authPassword').autocomplete = next === 'signup' ? 'new-password' : 'current-password';
    $('passwordAuthCopy').textContent = next === 'signup'
      ? 'Укажите почту и придумайте пароль. Для безопасности может потребоваться подтвердить почту из письма.'
      : 'Войдите с почтой и паролем. Ваши карты будут доступны после синхронизации.';
    message('');
  }

  function saveSession(session) {
    if (!session?.access_token || !session?.refresh_token || !session?.user?.id) throw new Error('Не удалось получить сессию. Попробуйте войти снова.');
    session.expires_at ||= Math.floor(Date.now() / 1000) + Number(session.expires_in || 3600);
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }

  async function submit(event) {
    if (event.target?.id !== 'emailForm') return;
    event.preventDefault();
    event.stopImmediatePropagation(); // Prevent the legacy OTP form handler from sending an unwanted code.
    if (busy) return;
    busy = true;
    const button = $('sendCodeButton');
    const passwordInput = $('authPassword');
    const email = $('authEmail').value.trim().toLowerCase();
    const password = passwordInput.value;
    const initialText = button.textContent;
    button.disabled = true;
    button.textContent = mode === 'signup' ? 'Создаём аккаунт…' : 'Входим…';
    message('');
    try {
      if (password.length < 8) throw new Error('Пароль должен содержать минимум 8 символов.');
      if (mode === 'signup') {
        const result = await authRequest(`/auth/v1/signup?redirect_to=${encodeURIComponent(APP_URL)}`, { email, password });
        if (result.access_token && result.user) {
          saveSession(result);
          passwordInput.value = '';
          window.location.reload();
          return;
        }
        passwordInput.value = '';
        setMode('login');
        $('authEmail').value = email;
        message('Аккаунт создан. Проверьте почту, подтвердите адрес по ссылке и затем войдите с паролем.');
      } else {
        const session = await authRequest('/auth/v1/token?grant_type=password', { email, password });
        saveSession(session);
        passwordInput.value = '';
        window.location.reload();
      }
    } catch (error) {
      const raw = String(error?.message || 'Не удалось войти.');
      const text = /invalid login credentials/i.test(raw) ? 'Неверная почта или пароль.'
        : /email not confirmed/i.test(raw) ? 'Подтвердите адрес по ссылке из письма и попробуйте снова.'
        : /failed to fetch|network|load failed/i.test(raw) ? 'Нет связи с облаком. Проверьте интернет.'
        : /rate limit/i.test(raw) ? 'Слишком много попыток. Подождите немного.' : raw;
      message(text, true);
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = mode === 'signup' ? 'Зарегистрироваться' : 'Войти';
    }
  }

  function boot() {
    const form = $('emailForm');
    const button = $('sendCodeButton');
    if (!form || !button || $('authPassword')) return;
    const copy = form.querySelector('.auth-copy');
    copy.id = 'passwordAuthCopy';
    const label = document.createElement('label');
    label.className = 'form-field';
    const caption = document.createElement('span');
    caption.textContent = 'Пароль';
    const password = document.createElement('input');
    password.id = 'authPassword';
    password.type = 'password';
    password.name = 'password';
    password.minLength = 8;
    password.maxLength = 128;
    password.autocomplete = 'current-password';
    password.required = true;
    password.placeholder = 'Не менее 8 символов';
    label.append(caption, password);
    button.before(label);
    const toggle = document.createElement('button');
    toggle.id = 'passwordAuthMode';
    toggle.type = 'button';
    toggle.className = 'text-button auth-link';
    toggle.addEventListener('click', () => setMode(mode === 'login' ? 'signup' : 'login'));
    form.append(toggle);
    const note = document.createElement('p');
    note.id = 'passwordAuthMessage';
    note.setAttribute('role', 'status');
    note.className = 'auth-copy';
    note.hidden = true;
    form.append(note);
    // OTP markup is left for compatibility with older cached pages, but never used by this flow.
    $('codeForm').hidden = true;
    setMode('login');
    document.addEventListener('click', event => {
      if (!event.target?.closest?.('#accountButton,#syncStatus')) return;
      queueMicrotask(() => { if (window.KartochkaCloud?.user?.()) $('authTitle').textContent = 'Ваш аккаунт'; });
    }, true);
  }

  // Confirmation happens on Supabase; remove access tokens from the address bar and
  // require ordinary password login afterward rather than keeping unverified URL sessions.
  if (/(?:^|[&#])access_token=/.test(window.location.hash)) {
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  document.addEventListener('submit', submit, true);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
