const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

function signedInitData(token, user, authDate) {
  const fields = new Map([
    ['auth_date', String(authDate)],
    ['query_id', 'AAHdF6IQAAAAAN0XohDhrOrc'],
    ['user', JSON.stringify(user)]
  ]);
  const check = [...fields.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(check).digest('hex');
  return [...fields.entries(), ['hash', hash]]
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
}

(async () => {
  const helperSource = read('supabase/functions/_shared/telegram.ts');
  const helper = await import(`data:text/javascript;base64,${Buffer.from(helperSource).toString('base64')}`);
  const now = 1_790_000_000;
  const token = '123456789:test-only-token-not-a-real-secret';
  const user = { id: 424242, first_name: 'Тест', username: 'closed_test' };
  const initData = signedInitData(token, user, now - 5);

  const verified = await helper.verifyTelegramInitData(initData, token, {
    nowSeconds: now,
    maxAgeSeconds: 600
  });
  assert.equal(verified.id, user.id);
  assert.equal(verified.username, user.username);

  await assert.rejects(
    helper.verifyTelegramInitData(initData.replace('closed_test', 'attacker'), token, {
      nowSeconds: now,
      maxAgeSeconds: 600
    }),
    /signature/i
  );
  await assert.rejects(
    helper.verifyTelegramInitData(signedInitData(token, user, now - 601), token, {
      nowSeconds: now,
      maxAgeSeconds: 600
    }),
    /expired/i
  );
  await assert.rejects(
    helper.verifyTelegramInitData(`${initData}&auth_date=${now}`, token, {
      nowSeconds: now,
      maxAgeSeconds: 600
    }),
    /duplicate/i
  );
  console.log('PASS Telegram initData signature, freshness and duplicate-field checks');

  const migration = read('supabase/migrations/20260921210000_telegram_private_test.sql');
  assert.match(migration, /alter table public\.telegram_test_cards enable row level security/i);
  assert.match(migration, /auth\.uid\(\)\) = user_id/i);
  assert.match(migration, /references public\.telegram_test_cards\(user_id, id\) on delete cascade/i);
  assert.match(migration, /revoke_telegram_test_card/i);
  assert.doesNotMatch(migration, /create\s+trigger[\s\S]*telegram_test_cards/i);
  assert.match(migration, /number not like 'TEST-%'/i);
  console.log('PASS private-card RLS and share revocation stay separate from wallet edits/deletes');

  const webhook = read('supabase/functions/telegram-webhook/index.ts');
  assert.match(webhook, /x-telegram-bot-api-secret-token/i);
  assert.match(webhook, /answerPreCheckoutQuery/);
  assert.match(webhook, /ok:\s*false/);
  assert.doesNotMatch(webhook, /premium_access|grant.*premium/i);
  const invoice = read('supabase/functions/create-premium-invoice/index.ts');
  assert.match(invoice, /payment_mode:\s*'disabled'/);
  assert.match(invoice, /403/);
  assert.doesNotMatch(invoice, /createInvoiceLink|sendInvoice/i);
  console.log('PASS webhook secret enforcement and real-payment shutdown');

  const atomic = read('cloud-atomic.js');
  assert.match(atomic, /telegram_test_cards/);
  assert.match(atomic, /apply_telegram_test_card_change/);
  assert.match(atomic, /Найдены локальные карты без владельца/);
  const html = read('index.html');
  assert.match(html, /id="catalogView"/);
  assert.match(html, /id="catalogPayment"[^>]+disabled/);
  assert.match(html, /telegram-mini-app\.js/);
  console.log('PASS Telegram Mini App uses isolated storage and exposes a payment-disabled catalog');
})().catch(error => {
  console.error('TELEGRAM PRIVATE TEST FAILURE', error);
  process.exitCode = 1;
});
