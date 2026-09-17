/* Email-auth UX: supports Supabase Magic Link today and numeric OTP later without passwords. */
(() => {
  'use strict';
  const RETRY_DELAY_MS = 60_000;

  function setup() {
    const cloud = window.KartochkaCloud;
    const emailForm = document.getElementById('emailForm');
    const codeForm = document.getElementById('codeForm');
    const email = document.getElementById('sentEmail');
    const change = document.getElementById('changeEmail');
    const sendButton = document.getElementById('sendCodeButton');
    if (!cloud?.sendCode || !emailForm || !codeForm || !email || !change || cloud.__deliveryFeedback) return;
    cloud.__deliveryFeedback = true;

    const emailCopy = emailForm.querySelector('.auth-copy');
    if (emailCopy) emailCopy.textContent = 'Введите почту. Мы отправим письмо для входа — пароль не нужен.';
    if (sendButton) sendButton.textContent = 'Отправить письмо';

    const copy = codeForm.querySelector('.auth-copy');
    if (copy) copy.replaceChildren(
      document.createTextNode('Письмо отправлено на '), email,
      document.createTextNode('. Если в письме есть кнопка или ссылка — откройте её. Если придёт код, введите его ниже.')
    );

    const help = document.createElement('p');
    help.className = 'auth-copy';
    help.id = 'otpDeliveryHelp';
    help.textContent = 'После перехода по ссылке вернитесь в «Карточку»: вход завершится автоматически. Ссылка одноразовая.';
    codeForm.insertBefore(help, change);

    const retry = document.createElement('button');
    retry.id = 'resendCode';
    retry.type = 'button';
    retry.className = 'text-button auth-link';
    retry.textContent = 'Отправить письмо ещё раз';
    codeForm.insertBefore(retry, change);

    let retryAfter = 0;
    let ticker = null;
    function drawRetry() {
      const seconds = Math.ceil((retryAfter - Date.now()) / 1000);
      if (seconds > 0) {
        retry.disabled = true;
        retry.textContent = `Повторить через ${seconds} с`;
      } else {
        retry.disabled = false;
        retry.textContent = 'Отправить письмо ещё раз';
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
          throw new Error('Supabase пока разрешает отправку только на почту участника проекта.');
        }
        if (/rate.limit|too many|over_email_send_rate_limit/.test(message) || error?.status === 429) {
          cooldown();
          throw new Error('Превышен лимит отправки. Подождите и попробуйте снова.');
        }
        if (/smtp|sending email|send.*email|mail service|email provider/.test(message)) {
          throw new Error('Почтовая отправка в Supabase сейчас настроена неправильно. Отключите неработающий Custom SMTP или исправьте его настройки.');
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
        help.textContent = 'Новое письмо запрошено. Используйте только самое свежее письмо: старые ссылки могут уже не работать.';
      } catch (error) {
        if (errorNode) {
          errorNode.textContent = String(error?.message || 'Не удалось отправить письмо.');
          errorNode.hidden = false;
        }
        drawRetry();
      }
    });

    try {
      const message = sessionStorage.getItem('kartochka.auth-message.v1');
      if (message) {
        sessionStorage.removeItem('kartochka.auth-message.v1');
        setTimeout(() => {
          const toast = document.getElementById('toast');
          if (toast) {
            toast.textContent = message;
            toast.classList.add('show');
            setTimeout(() => toast.classList.remove('show'), 3500);
          }
        }, 250);
      }
    } catch (_) {}
  }

  if (document.readyState === 'complete') setup();
  else {
    document.addEventListener('DOMContentLoaded', setup, { once: true });
    window.addEventListener('load', setup, { once: true });
  }
})();
