const encoder = new TextEncoder();

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function hmacSha256(key, value) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? encoder.encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(value)));
}

export async function verifyTelegramInitData(initData, botToken, options = {}) {
  if (typeof initData !== 'string' || initData.length < 20 || initData.length > 8192) {
    throw new Error('Invalid Telegram initData');
  }
  if (!botToken) throw new Error('Telegram bot is not configured');

  const pairs = initData.split('&');
  const seen = new Set();
  const values = new Map();
  for (const pair of pairs) {
    const separator = pair.indexOf('=');
    if (separator <= 0) throw new Error('Malformed Telegram initData');
    const key = decodeURIComponent(pair.slice(0, separator).replace(/\+/g, ' '));
    const value = decodeURIComponent(pair.slice(separator + 1).replace(/\+/g, ' '));
    if (seen.has(key)) throw new Error('Duplicate Telegram initData field');
    seen.add(key);
    values.set(key, value);
  }

  const receivedHash = String(values.get('hash') || '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(receivedHash)) throw new Error('Invalid Telegram signature');
  values.delete('hash');

  const authDate = Number(values.get('auth_date'));
  const now = Number(options.nowSeconds || Math.floor(Date.now() / 1000));
  const maxAgeSeconds = Number(options.maxAgeSeconds || 600);
  if (!Number.isSafeInteger(authDate) || authDate > now + 30 || now - authDate > maxAgeSeconds) {
    throw new Error('Telegram authorization has expired');
  }

  const dataCheckString = [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = await hmacSha256('WebAppData', botToken);
  const calculatedHash = bytesToHex(await hmacSha256(secretKey, dataCheckString));
  if (!timingSafeEqual(calculatedHash, receivedHash)) {
    throw new Error('Invalid Telegram signature');
  }

  let user;
  try {
    user = JSON.parse(values.get('user') || 'null');
  } catch (_) {
    throw new Error('Invalid Telegram user');
  }
  if (!user || !Number.isSafeInteger(Number(user.id)) || Number(user.id) <= 0) {
    throw new Error('Invalid Telegram user');
  }
  return {
    ...user,
    id: Number(user.id),
    username: typeof user.username === 'string' ? user.username.slice(0, 64) : null,
    first_name: typeof user.first_name === 'string' ? user.first_name.slice(0, 128) : null
  };
}

export function syntheticTelegramEmail(telegramUserId) {
  return `telegram-${String(telegramUserId)}@telegram.kartochka.invalid`;
}

export function bearerToken(request) {
  const header = request.headers.get('authorization') || '';
  return /^Bearer\s+(.+)$/i.exec(header)?.[1] || '';
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
  });
}

export function corsHeaders(request) {
  const origin = request.headers.get('origin') || '';
  const configuredUrl = Deno.env.get('TELEGRAM_WEB_APP_URL') || '';
  let allowedOrigin = '*';
  try {
    const configuredOrigin = new URL(configuredUrl).origin;
    if (origin === configuredOrigin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
      allowedOrigin = origin;
    } else if (origin) {
      allowedOrigin = configuredOrigin;
    }
  } catch (_) {
    if (origin) allowedOrigin = origin;
  }
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin'
  };
}

export async function telegramApi(botToken, method, payload) {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body?.ok !== true) {
    throw new Error(`Telegram API ${method} failed`);
  }
  return body.result;
}
