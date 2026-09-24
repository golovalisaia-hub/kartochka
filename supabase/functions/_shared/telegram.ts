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

/*
 * Why this check exists.
 *
 * Telegram opens TELEGRAM_WEB_APP_URL verbatim inside its WebView. If that URL is a hosting
 * preview that sits behind an access wall (Vercel Deployment Protection, Netlify password
 * protection, Cloudflare Access, GitHub Pages on a private repo), the host answers Telegram
 * with its OWN login page. The user then taps "Открыть Карточку" and lands on, for example,
 * "Log in to Vercel" inside a window titled «Карточка» — the bot and the Mini App button are
 * configured perfectly, and the app is still unreachable.
 *
 * Nothing in the Telegram API can detect that: setChatMenuButton accepts any HTTPS URL. So we
 * check the URL ourselves before publishing it, and refuse to configure a button that would
 * take users to somebody's login screen.
 */
const ACCESS_WALL_SIGNATURES = [
  {
    id: 'vercel-deployment-protection',
    test: (body, response) =>
      /vercel\.com\/(?:sso|login)|_vercel\/sso|Log in to Vercel|Authentication Required/i.test(body) ||
      response.headers.has('set-cookie') && /_vercel_jwt/i.test(response.headers.get('set-cookie') || '') ||
      /vercel/i.test(response.headers.get('x-vercel-mitigated') || ''),
    hint: 'Vercel Deployment Protection включена. Vercel → Project → Settings → Deployment Protection → Vercel Authentication → Disabled (или добавьте домен в Protection Bypass). Пока защита включена, Telegram будет показывать экран входа Vercel вместо «Карточки».'
  },
  {
    id: 'netlify-password',
    test: body => /netlify.*password|Site is password protected/i.test(body),
    hint: 'Netlify site password включён. Site settings → Access control → Visitor access → снимите пароль.'
  },
  {
    id: 'cloudflare-access',
    test: (body, response) =>
      /cloudflareaccess\.com/i.test(body) || /cloudflareaccess\.com/i.test(response.url || ''),
    hint: 'Cloudflare Access закрывает адрес. Уберите приложение из политики Access или добавьте публичное исключение.'
  },
  {
    id: 'generic-login-wall',
    test: body => /<title>[^<]*(log ?in|sign ?in|authentication)[^<]*<\/title>/i.test(body),
    hint: 'Адрес отвечает страницей входа стороннего сервиса. Откройте его в приватном окне браузера: должна открываться «Карточка», а не форма входа.'
  }
];

// The real app always ships these markers; a login wall never does.
const APP_SIGNATURES = [/<title>\s*Карточка\s*<\/title>/i, /telegram-mini-app\.js/i, /id="quickScreen"/i];

export async function inspectWebAppUrl(url) {
  if (!/^https:\/\//i.test(String(url || ''))) {
    return { ok: false, reason: 'missing', hint: 'TELEGRAM_WEB_APP_URL не задан или не начинается с https://.' };
  }
  let response;
  let body = '';
  try {
    response = await fetch(url, {
      redirect: 'follow',
      headers: {
        // Telegram's WebView asks for HTML; ask the same way so we see the same answer.
        accept: 'text/html,application/xhtml+xml',
        'user-agent': 'KartochkaSetupCheck/1.0'
      }
    });
    body = (await response.text()).slice(0, 200000);
  } catch (_) {
    return { ok: false, reason: 'unreachable', hint: 'Адрес не отвечает. Проверьте, что развёртывание опубликовано и доступно из интернета.' };
  }

  if (!response.ok) {
    return {
      ok: false,
      reason: `http-${response.status}`,
      hint: response.status === 401 || response.status === 403
        ? 'Хостинг требует авторизации. Telegram увидит тот же экран входа. Отключите защиту развёртывания.'
        : `Адрес отвечает кодом ${response.status}. Telegram покажет ту же ошибку.`
    };
  }

  for (const signature of ACCESS_WALL_SIGNATURES) {
    if (signature.test(body, response)) {
      return { ok: false, reason: signature.id, hint: signature.hint };
    }
  }

  if (!APP_SIGNATURES.some(pattern => pattern.test(body))) {
    return {
      ok: false,
      reason: 'not-kartochka',
      hint: 'Адрес отвечает, но это не «Карточка». Проверьте, что TELEGRAM_WEB_APP_URL указывает на корень опубликованного приложения.'
    };
  }

  return { ok: true, reason: 'ok', hint: '' };
}
