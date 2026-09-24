import { jsonResponse, telegramApi } from '../_shared/telegram.ts';

function matchesSecret(request, secret) {
  const received = request.headers.get('x-telegram-bot-api-secret-token') || '';
  if (!secret || received.length !== secret.length) return false;
  let difference = 0;
  for (let index = 0; index < secret.length; index += 1) {
    difference |= received.charCodeAt(index) ^ secret.charCodeAt(index);
  }
  return difference === 0;
}

Deno.serve(async request => {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
  const webhookSecret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') || '';
  const webAppUrl = Deno.env.get('TELEGRAM_WEB_APP_URL') || '';
  if (!matchesSecret(request, webhookSecret)) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  try {
    const update = await request.json();
    if (update?.pre_checkout_query?.id) {
      await telegramApi(botToken, 'answerPreCheckoutQuery', {
        pre_checkout_query_id: update.pre_checkout_query.id,
        ok: false,
        error_message: 'Платежи отключены на время закрытого тестирования.'
      });
      return jsonResponse({ ok: true });
    }

    if (update?.message?.successful_payment) {
      await telegramApi(botToken, 'sendMessage', {
        chat_id: update.message.chat.id,
        text: 'Платёж не активирован: закрытый тест не принимает реальные платежи.'
      });
      return jsonResponse({ ok: true });
    }

    const text = String(update?.message?.text || '');
    if (update?.message?.chat?.id && /^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
      if (!/^https:\/\//i.test(webAppUrl)) throw new Error('Telegram web app URL is missing');
      await telegramApi(botToken, 'sendMessage', {
        chat_id: update.message.chat.id,
        text: 'Откройте «Карточку» для закрытого тестирования. Используйте только вымышленные карты.',
        reply_markup: {
          inline_keyboard: [[{
            text: 'Открыть Карточку',
            web_app: { url: webAppUrl }
          }]]
        }
      });
    }
    return jsonResponse({ ok: true });
  } catch (_) {
    // Telegram retries non-2xx deliveries. Do not acknowledge a failed handler.
    return jsonResponse({ error: 'Webhook processing failed' }, 500);
  }
});
