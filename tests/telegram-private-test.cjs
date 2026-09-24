const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

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

  // ---- launch configuration -------------------------------------------------
  const miniApp = read('telegram-mini-app.js');
  // The documented SDK build, loaded once, from telegram.org and nowhere else.
  assert.match(miniApp, /telegram\.org\/js\/telegram-web-app\.js\?63/);
  assert.doesNotMatch(miniApp, /telegram-web-app\.js\?(?!63)\d+/);
  assert.equal((miniApp.match(/telegram\.org\/js\/telegram-web-app\.js/g) || []).length, 1);
  // expand() must never be reachable from startup, and ready() is the app's call to make.
  assert.match(miniApp, /if \(reason === 'startup'\) return false/);
  assert.doesNotMatch(miniApp, /webApp\.ready\(\);\s*\n\s*webApp\.expand\(\)/);
  assert.match(miniApp, /function signalReady/);
  // initData, not initDataUnsafe, is what authentication sends to the server.
  assert.match(miniApp, /loginWithTelegram\(initData\)/);
  assert.doesNotMatch(miniApp, /loginWithTelegram\([^)]*initDataUnsafe/);
  const cloud = read('cloud.js');
  assert.match(cloud, /result\?\.access_token\s*\?\s*result/);
  assert.match(cloud, /result\?\.token_hash/);
  const telegramFunction = read('supabase/functions/telegram/index.ts');
  // GoTrue/bcrypt rejects passwords longer than 72 bytes. Two hyphenless UUIDs are 64 bytes.
  assert.match(telegramFunction, /crypto\.randomUUID\(\)\.replaceAll\('-',\s*''\)\+crypto\.randomUUID\(\)\.replaceAll\('-',\s*''\)/);
  assert.doesNotMatch(telegramFunction, /crypto\.randomUUID\(\)\+'-'\+crypto\.randomUUID\(\)/);
  assert.match(telegramFunction, /\/auth\/v1\/admin\/generate_link/);
  // Raw GoTrue REST returns hashed_token at the top level; supabase-js wraps it in properties.
  assert.match(telegramFunction, /l\.hashed_token\|\|l\.properties\?\.hashed_token/);
  assert.doesNotMatch(telegramFunction, /\/auth\/v1\/token\?grant_type=password/);
  // Viewport plumbing must use the documented fields rather than assuming a full screen.
  for (const field of ['viewportHeight', 'viewportStableHeight', 'safeAreaInset', 'contentSafeAreaInset', 'viewportChanged']) {
    assert.match(miniApp, new RegExp(field), `telegram-mini-app.js must handle ${field}`);
  }
  const appSource = read('app.js');
  assert.doesNotMatch(appSource, /expand\(\s*'startup'\s*\)/);
  console.log('PASS Telegram SDK version, single load, no startup expand and compatible server session login');

  // ---- the Mini App URL health check ----------------------------------------
  const { inspectWebAppUrl } = await import(pathToFileURL(path.join(root, 'supabase/functions/_shared/telegram.ts')).href);
  const originalFetch = globalThis.fetch;
  const serve = (body, init = {}) => {
    globalThis.fetch = async () => new Response(body, { status: 200, headers: {}, ...init });
  };
  try {
    // The exact failure the bot showed: Telegram opened the URL and Vercel answered with its
    // own login page, so the user saw "Log in to Vercel" inside a window titled «Карточка».
    serve('<html><head><title>Login – Vercel</title></head><body>Log in to Vercel</body></html>');
    const vercel = await inspectWebAppUrl('https://example-preview.vercel.app/');
    assert.equal(vercel.ok, false);
    assert.equal(vercel.reason, 'vercel-deployment-protection');
    assert.match(vercel.hint, /Deployment Protection/i);

    serve('<html><head><title>Карточка</title></head><body><script src="telegram-mini-app.js"></script></body></html>');
    assert.equal((await inspectWebAppUrl('https://example.github.io/kartochka/')).ok, true);

    serve('nope', { status: 401 });
    const denied = await inspectWebAppUrl('https://example.com/');
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'http-401');

    serve('<html><head><title>Some other site</title></head><body>hello</body></html>');
    assert.equal((await inspectWebAppUrl('https://example.com/')).reason, 'not-kartochka');

    assert.equal((await inspectWebAppUrl('http://insecure.example')).reason, 'missing');
    assert.equal((await inspectWebAppUrl('')).reason, 'missing');
  } finally {
    globalThis.fetch = originalFetch;
  }

  // Both setup paths must refuse to publish a URL that is not serving the app.
  for (const file of ['supabase/functions/telegram/index.ts', 'supabase/functions/telegram-setup/index.ts']) {
    const source = read(file);
    assert.match(source, /inspectWebAppUrl/, `${file} must verify the Mini App URL`);
    const check = source.indexOf('inspectWebAppUrl(');
    const publish = source.indexOf('setChatMenuButton');
    assert.ok(check > 0 && check < publish, `${file} must check the URL before configuring the button`);
  }
  console.log('PASS Mini App URL health check catches hosting login walls before Telegram sees them');

  // ---- open history ----------------------------------------------------------
  const openMigration = read('supabase/migrations/20260922120000_card_open_history.sql');
  assert.match(openMigration, /add column if not exists last_opened_at/);
  assert.match(openMigration, /where user_id = v_user/);
  // Recording an open must never look like an edit, or a rename on another device conflicts.
  assert.doesNotMatch(openMigration, /revision\s*=\s*revision\s*\+/);
  assert.match(openMigration, /Authentication required/);
  assert.match(openMigration, /grant execute on function public\.record_telegram_test_card_opens\(jsonb\) to authenticated/);
  assert.match(openMigration, /revoke all on function public\.record_telegram_test_card_opens\(jsonb\) from public, anon/);
  // Open history is written only by its own call, never smuggled into a content upsert.
  assert.doesNotMatch(atomic, /last_opened_at:\s*Number\(card/);
  assert.match(atomic, /record_telegram_test_card_opens/);
  assert.match(appSource, /kartochka\.card-opens\.queue/);
  console.log('PASS open history is owner-checked, revision-safe and queued when offline');
})().catch(error => {
  console.error('TELEGRAM PRIVATE TEST FAILURE', error);
  process.exitCode = 1;
});
