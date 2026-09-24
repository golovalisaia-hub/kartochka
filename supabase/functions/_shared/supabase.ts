import { createClient } from 'npm:@supabase/supabase-js@2';

export function adminClient() {
  const url = Deno.env.get('SUPABASE_URL') || '';
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
  if (!url || !serviceRoleKey) throw new Error('Supabase function environment is incomplete');
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
}

export async function telegramAuthLink(admin, telegramUser) {
  const email = `telegram-${telegramUser.id}@telegram.kartochka.invalid`;
  const existingLink = await admin
    .from('telegram_accounts')
    .select('user_id')
    .eq('telegram_user_id', telegramUser.id)
    .maybeSingle();
  if (existingLink.error) throw existingLink.error;

  let authUser = null;
  if (existingLink.data?.user_id) {
    const result = await admin.auth.admin.getUserById(existingLink.data.user_id);
    if (result.error) throw result.error;
    authUser = result.data.user;
  }

  if (!authUser) {
    const created = await admin.auth.admin.createUser({
      email,
      password: `${crypto.randomUUID()}-${crypto.randomUUID()}`,
      email_confirm: true,
      user_metadata: {
        auth_source: 'telegram',
        telegram_id: telegramUser.id,
        telegram_username: telegramUser.username || null,
        telegram_first_name: telegramUser.first_name || null
      }
    });
    if (created.error && !/already.*registered|already.*exists/i.test(created.error.message || '')) {
      throw created.error;
    }
    authUser = created.data?.user || null;
    if (!authUser) {
      const listed = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
      if (listed.error) throw listed.error;
      authUser = listed.data.users.find(user => user.email === email) || null;
    }
    if (!authUser) throw new Error('Unable to create Telegram test account');

    const linked = await admin.from('telegram_accounts').upsert({
      telegram_user_id: telegramUser.id,
      user_id: authUser.id,
      telegram_username: telegramUser.username || null,
      telegram_first_name: telegramUser.first_name || null,
      updated_at: new Date().toISOString()
    }, { onConflict: 'telegram_user_id', ignoreDuplicates: true });
    if (linked.error) throw linked.error;

    const finalLink = await admin
      .from('telegram_accounts')
      .select('user_id')
      .eq('telegram_user_id', telegramUser.id)
      .single();
    if (finalLink.error) throw finalLink.error;
    if (finalLink.data.user_id !== authUser.id) {
      const result = await admin.auth.admin.getUserById(finalLink.data.user_id);
      if (result.error) throw result.error;
      authUser = result.data.user;
    }
  } else {
    await admin.from('telegram_accounts').update({
      telegram_username: telegramUser.username || null,
      telegram_first_name: telegramUser.first_name || null,
      updated_at: new Date().toISOString()
    }).eq('telegram_user_id', telegramUser.id);
  }

  if (!authUser?.email) throw new Error('Telegram account has no login address');
  const metadata = await admin.auth.admin.updateUserById(authUser.id, {
    user_metadata: {
      ...(authUser.user_metadata || {}),
      telegram_id: telegramUser.id,
      telegram_username: telegramUser.username || null,
      telegram_first_name: telegramUser.first_name || null
    }
  });
  if (metadata.error) throw metadata.error;
  const generated = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: authUser.email
  });
  if (generated.error) throw generated.error;
  const tokenHash = generated.data?.properties?.hashed_token;
  if (!tokenHash) throw new Error('Unable to create Telegram login session');
  return { tokenHash, userId: authUser.id };
}
