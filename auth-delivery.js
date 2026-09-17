/* Better email-code delivery feedback. Never treats an accepted request as proof of inbox delivery. */
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
      document.createTextNode('Сервер принял запрос для '), email,
      document.createTextNode('. Это ещё не подтверждает доставку письма. Проверьте входящие и «Спам».')
    );
    const help = document.createElement('p');
    help.className = 'auth-copy';
    help.id = 'otpDeliveryHelp';
    help.textContent = 'Нет письма? Проверьте адрес и папку «Спам». Если сервер отказал в отправке, приложение покажет причину.';
    form.insertBefore(help, change);

    const retry = document.createElement('button');
    retry.id = 'resendCode';
    retry.type = 'button';
    retry.className = 'text-button auth-link';
    retry.textContent = 'Отправить код ещё раз';
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
        retry.textContent = 'Отправить код ещё раз';
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
        if (/email.*not.*authori[sz]ed|email_address_not_authorized|not authori[sz]ed.*email|email.*not.*allowed/.test(message) || error?.status === 403) {
          throw new Error('Сервер запретил отправку на эту почту. Для входа любых пользователей владелец должен настроить собственный SMTP в Supabase → Authentication → SMTP Settings.');
        }
        if (/rate.limit|too many|over_email_send_rate_limit/.test(message) || error?.status === 429) {
          cooldown();
          throw new Error('Превышен лимит отправки писем. Подождите и повторите попытку позже.');
        }
        if (/smtp|sending email|send.*email|mail service|email provider/.test(message)) {
          throw new Error('Почтовый сервер не смог отправить письмо. Проверьте настройки SMTP в Supabase и журнал ошибок Auth.');
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
        help.textContent = 'Повторный запрос принят сервером. Проверьте входящие и «Спам». Доставка ещё не подтверждена.';
      } catch (error) {
        if (errorNode) {
          errorNode.textContent = String(error?.message || 'Не удалось запросить код.');
          errorNode.hidden = false;
        }
        drawRetry();
      }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup, { once: true });
  else setup();
})();
