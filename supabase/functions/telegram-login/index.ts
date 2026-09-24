import { corsHeaders, jsonResponse, verifyTelegramInitData } from '../_shared/telegram.ts';
import { adminClient, telegramAuthLink } from '../_shared/supabase.ts';

Deno.serve(async request => {
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    const body = await request.json();
    const telegramUser = await verifyTelegramInitData(
      body?.initData,
      Deno.env.get('TELEGRAM_BOT_TOKEN') || ''
    );
    const { tokenHash } = await telegramAuthLink(adminClient(), telegramUser);
    return jsonResponse({ token_hash: tokenHash, type: 'magiclink' }, 200, cors);
  } catch (error) {
    const message = String(error?.message || error);
    const status = /expired|invalid|malformed|duplicate/i.test(message) ? 401 : 500;
    return jsonResponse({ error: status === 401 ? message : 'Telegram login failed' }, status, cors);
  }
});
