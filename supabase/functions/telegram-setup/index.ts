import { inspectWebAppUrl, jsonResponse, telegramApi } from '../_shared/telegram.ts';

Deno.serve(async request => {
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);
  const expectedSecret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET') || '';
  const receivedSecret = request.headers.get('x-telegram-bot-api-secret-token') || '';
  if (!expectedSecret || expectedSecret !== receivedSecret) {
    return jsonResponse({ error: 'Unauthorized' }, 401);
  }

  try {
    const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN') || '';
    const webAppUrl = Deno.env.get('TELEGRAM_WEB_APP_URL') || '';
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    if (!botToken || !expectedSecret || !/^https:\/\//i.test(webAppUrl) || !supabaseUrl) {
      throw new Error('Telegram setup is incomplete');
    }
    // Refuse to point Telegram at a URL that answers with somebody else's login page:
    // the button would open, for example, "Log in to Vercel" in a window titled «Карточка».
    const health = await inspectWebAppUrl(webAppUrl);
    if (!health.ok) {
      return jsonResponse({
        error: 'Telegram Mini App URL is not serving the app',
        reason: health.reason,
        hint: health.hint,
        configured: false
      }, 409);
    }

    const webhookUrl = `${supabaseUrl.replace(/\/+$/, '')}/functions/v1/telegram-webhook`;
    await telegramApi(botToken, 'setWebhook', {
      url: webhookUrl,
      secret_token: expectedSecret,
      allowed_updates: ['message', 'pre_checkout_query'],
      drop_pending_updates: false
    });
    await telegramApi(botToken, 'setMyCommands', {
      commands: [{ command: 'start', description: 'Открыть Карточку' }]
    });
    await telegramApi(botToken, 'setChatMenuButton', {
      menu_button: {
        type: 'web_app',
        text: 'Открыть Карточку',
        web_app: { url: webAppUrl }
      }
    });
    const webhook = await telegramApi(botToken, 'getWebhookInfo', {});
    return jsonResponse({
      ok: true,
      webhook: {
        configured: webhook?.url === webhookUrl,
        pending_update_count: Number(webhook?.pending_update_count || 0),
        last_error_date: webhook?.last_error_date || null,
        has_custom_certificate: Boolean(webhook?.has_custom_certificate)
      }
    });
  } catch (_) {
    return jsonResponse({ error: 'Telegram setup failed' }, 500);
  }
});
