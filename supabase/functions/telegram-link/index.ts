import {
  bearerToken, corsHeaders, jsonResponse, syntheticTelegramEmail, verifyTelegramInitData
} from '../_shared/telegram.ts';
import { adminClient } from '../_shared/supabase.ts';

Deno.serve(async request => {
  const cors = corsHeaders(request);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405, cors);

  try {
    const token = bearerToken(request);
    if (!token) return jsonResponse({ error: 'Authentication required' }, 401, cors);
    const admin = adminClient();
    const caller = await admin.auth.getUser(token);
    if (caller.error || !caller.data.user) {
      return jsonResponse({ error: 'Authentication required' }, 401, cors);
    }
    const body = await request.json();
    const action = body?.action;

    if (action === 'link') {
      const telegramUser = await verifyTelegramInitData(
        body?.initData,
        Deno.env.get('TELEGRAM_BOT_TOKEN') || ''
      );
      const current = await admin.from('telegram_accounts')
        .select('user_id')
        .eq('telegram_user_id', telegramUser.id)
        .maybeSingle();
      if (current.error) throw current.error;
      if (current.data && current.data.user_id !== caller.data.user.id) {
        return jsonResponse({ error: 'Telegram account is already linked' }, 409, cors);
      }
      const link = await admin.from('telegram_accounts').upsert({
        telegram_user_id: telegramUser.id,
        user_id: caller.data.user.id,
        telegram_username: telegramUser.username || null,
        telegram_first_name: telegramUser.first_name || null,
        updated_at: new Date().toISOString()
      }, { onConflict: 'telegram_user_id' });
      if (link.error) throw link.error;
      const metadata = await admin.auth.admin.updateUserById(caller.data.user.id, {
        user_metadata: {
          ...(caller.data.user.user_metadata || {}),
          telegram_id: telegramUser.id,
          telegram_username: telegramUser.username || null,
          telegram_first_name: telegramUser.first_name || null
        }
      });
      if (metadata.error) throw metadata.error;
      return jsonResponse({ linked: true }, 200, cors);
    }

    if (action === 'unlink') {
      const fullUser = await admin.auth.admin.getUserById(caller.data.user.id);
      if (fullUser.error) throw fullUser.error;
      const user = fullUser.data.user;
      const hasVerifiedEmail = Boolean(
        user.email &&
        user.email_confirmed_at &&
        user.email !== syntheticTelegramEmail(user.user_metadata?.telegram_id) &&
        !user.email.endsWith('@telegram.kartochka.invalid')
      );
      if (!hasVerifiedEmail) {
        return jsonResponse({
          error: 'Add and verify another login method before unlinking Telegram'
        }, 409, cors);
      }
      const removed = await admin.from('telegram_accounts')
        .delete()
        .eq('user_id', caller.data.user.id);
      if (removed.error) throw removed.error;
      const nextMetadata = { ...(user.user_metadata || {}) };
      delete nextMetadata.telegram_id;
      delete nextMetadata.telegram_username;
      delete nextMetadata.telegram_first_name;
      const metadata = await admin.auth.admin.updateUserById(caller.data.user.id, {
        user_metadata: nextMetadata
      });
      if (metadata.error) throw metadata.error;
      return jsonResponse({ linked: false }, 200, cors);
    }

    return jsonResponse({ error: 'Unsupported action' }, 400, cors);
  } catch (_) {
    return jsonResponse({ error: 'Telegram account operation failed' }, 500, cors);
  }
});
