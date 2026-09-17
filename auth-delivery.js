/* OTP delivery feedback. An accepted request never proves that an email arrived. */
(() => {
  'use strict';
  const RETRY_DELAY_MS = 60_000;
  function setup() {
    const cloud = window.KartochkaCloud;
    const form = document.getElementById('codeForm');
    const email = document.getElementById('sentEmail');
    const change = document.getElementById('changeEmail');
    if (!cloud?.sendCode || !form || !email || !change || cloud.__deliveryFeedback) return;
    cloud.__deliveryFeedback = true;

    const copy = form.querySelector('.auth-copy');
    if (copy) copy.replaceChildren(
      document.createTextNode('Запрос на письмо для '), email,
      document.createTextNode(' принят сервером. Это ещё не подтверждает доставку. Проверьте входящие и «Спам».')
    );
    const help = document.createElement('p');
    help.className = 'auth-copy';
    help.id = 'otpDeliveryHelp';
    help.textContent = 'Пришла ссылка вместо цифр? Владелец должен добавить {{ .Token }} в шаблоны Confirm signup и Magic Link / OTP в Supabase. Ссылку нельзя вставить в поле кода.';
    form.insertBefore(help, change);

    const retry = document.createElement('button');
    retry.id = 'resendCode';
    retry.type = 'button';
    retry.className = 'text-button auth-link';
    retry.textContent = 'Запросить код ещё раз';
    form.insertBefore(retry, change);
    let retryAfter = 0;
    let ticker = null;
    function drawRetry() {
      const seconds = Math.ceil((retryAfter - Date.now()) / 1000);
      if (seconds > 0) {
        retry.disabled = true;
        retry.textContent = `Повторить через ${seconds} с`;
      } else {
        retry.disabled = false;
        retry.textContent = 'Запросить код ещё раз';
        if (ticker) clearInterval(ticker);
        ticker = null;
      }
    }
    function cooldown() {
      retryAfter = Date.now() + RETRY_DELAY_MS;
      drawRetry();
      if (!ticker) ticker = setInterval(drawRetry, 1000);
    }
    const send = cloud.sendCode.bind(cloud);
    cloud.sendCode = async address => {
      try {
        const result = await send(address);
        cooldown();
        return result;
      } catch (error) {
        const message = String(error?.message || '').toLowerCase();
        if (/email.*not.*authori[sz]ed|email_address_not_authorized|not authori[sz]ed.*email|email.*not.*allowed/.test(message)) {
          throw new Error('Supabase запрещает отправлять письма на этот адрес. Владелец должен подключить свой SMTP для регистрации любых пользователей.');
        }
        if (/rate.limit|too many|over_email_send_rate_limit/.test(message) || error?.status === 429) {
          cooldown();
          throw new Error('Превышен лимит отправки. Подождите и повторите попытку позже.');
        }
        if (/smtp|sending email|send.*email|mail service|email provider/.test(message)) {
          throw new Error('Почтовый сервер не смог отправить письмо. Проверьте настройки SMTP и журнал ошибок Auth в Supabase.');
        }
        throw error;
      }
    };
    retry.addEventListener('click', async () => {
      if (retry.disabled || !email.textContent.trim()) return;
      retry.disabled = true;
      retry.textContent = 'Отправляем…';
      const errorNode = document.getElementById('authError');
      if (errorNode) { errorNode.textContent = ''; errorNode.hidden = true; }
      try {
        await cloud.sendCode(email.textContent.trim());
        help.textContent = 'Повторный запрос принят сервером. Если опять пришла ссылка вместо цифр, необходимо исправить шаблон письма Supabase.';
      } catch (error) {
        if (errorNode) {
          errorNode.textContent = String(error?.message || 'Не удалось запросить код.');
          errorNode.hidden = false;
        }
        drawRetry();
      }
    });
  }
  // Dynamic scripts may execute before, during, or after defer execution.
  // DOMContentLoaded runs after cloud.js/app.js; load covers interactive late scripts.
  if (document.readyState === 'complete') setup();
  else {
    document.addEventListener('DOMContentLoaded', setup, { once: true });
    window.addEventListener('load', setup, { once: true });
  }
})();
