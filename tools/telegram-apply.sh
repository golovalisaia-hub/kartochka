#!/usr/bin/env bash
# Настройка оформления @KartochkaWalletBot напрямую через Bot API.
#
# Деплой Edge Function для этого НЕ нужен: описание до Start, имя, команды и кнопка меню —
# это вызовы Telegram API, они меняются сразу.
#
# Запуск:
#   export TELEGRAM_BOT_TOKEN='...'          # обязательно
#   export TELEGRAM_WEB_APP_URL='https://...' # необязательно, для кнопки меню
#   bash tools/telegram-apply.sh
#
# Токен читается только из переменной окружения и никогда не печатается.
set -uo pipefail

# Пути считаются от расположения скрипта, чтобы его можно было запускать из любого каталога.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || { echo "Не найден корень репозитория" >&2; exit 1; }

TOKEN="${TELEGRAM_BOT_TOKEN:-}"
APP_URL="${TELEGRAM_WEB_APP_URL:-}"
# Адрес API вынесен, чтобы скрипт можно было прогнать против локального мока в тестах.
API_BASE="${TELEGRAM_API_BASE:-https://api.telegram.org}"
API="${API_BASE}/bot${TOKEN}"

if [ -z "$TOKEN" ]; then
  echo "Не задан TELEGRAM_BOT_TOKEN." >&2
  echo "  export TELEGRAM_BOT_TOKEN='...'   # значение берите у @BotFather, никому не пересылайте" >&2
  exit 2
fi

# Тексты берутся из кода, чтобы терминал и {"action":"setup"} не разошлись.
BRAND_JSON="$(node -e '
import("./supabase/functions/_shared/bot-onboarding.ts").then(m => {
  process.stdout.write(JSON.stringify({
    name: m.BOT_NAME,
    short_description: m.BOT_SHORT_DESCRIPTION,
    description: m.BOT_DESCRIPTION,
    commands: m.BOT_COMMANDS
  }));
}).catch(e => { console.error(e); process.exit(1); });
')" || {
  echo "Не удалось прочитать тексты из supabase/functions/_shared/bot-onboarding.ts." >&2
  echo "Чаще всего причина — старый Node: нужен Node 22 или новее (node --version)." >&2
  exit 1
}

ok_count=0
fail_count=0

call() { # call <метод> <json>
  local method="$1" payload="$2" response description
  response="$(curl -sS --max-time 20 -X POST "${API}/${method}" \
    -H 'Content-Type: application/json' -d "$payload" 2>&1)"
  if printf '%s' "$response" | grep -q '"ok":true'; then
    echo "  ✓ ${method}"
    ok_count=$((ok_count + 1))
    return 0
  fi
  description="$(printf '%s' "$response" | sed -n 's/.*"description":"\([^"]*\)".*/\1/p')"
  echo "  ✗ ${method}: ${description:-нет ответа}"
  fail_count=$((fail_count + 1))
  return 1
}

echo "Проверяю бота…"
me="$(curl -sS --max-time 20 "${API}/getMe" 2>&1)"
if ! printf '%s' "$me" | grep -q '"ok":true'; then
  echo "Telegram не принял токен: $(printf '%s' "$me" | sed -n 's/.*"description":"\([^"]*\)".*/\1/p')" >&2
  exit 1
fi
username="$(printf '%s' "$me" | sed -n 's/.*"username":"\([^"]*\)".*/\1/p')"
echo "  бот: @${username}"
echo

echo "Применяю оформление…"
call setMyName              "$(printf '%s' "$BRAND_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify({name:JSON.parse(s).name})))')"
call setMyShortDescription  "$(printf '%s' "$BRAND_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify({short_description:JSON.parse(s).short_description})))')"
call setMyDescription       "$(printf '%s' "$BRAND_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify({description:JSON.parse(s).description})))')"
call setMyCommands          "$(printf '%s' "$BRAND_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify({commands:JSON.parse(s).commands})))')"

if [ -n "$APP_URL" ]; then
  # Кнопка меню ведёт в Mini App. Адрес обязан открываться без входа в хостинг.
  page="$(curl -sS --max-time 20 -L "$APP_URL" 2>&1 || true)"
  if printf '%s' "$page" | grep -qi 'Log in to Vercel\|_vercel/sso\|vercel.com/sso'; then
    echo "  ✗ setChatMenuButton: по адресу отвечает страница входа Vercel, а не «Карточка»."
    echo "    Снимите Deployment Protection или укажите публичный адрес — иначе кнопка откроет форму входа."
    fail_count=$((fail_count + 1))
  elif ! printf '%s' "$page" | grep -q 'telegram-mini-app.js\|<title>[[:space:]]*Карточка'; then
    echo "  ✗ setChatMenuButton: адрес отвечает, но это не «Карточка». Кнопка не изменена."
    fail_count=$((fail_count + 1))
  else
    call setChatMenuButton "$(node -e 'process.stdout.write(JSON.stringify({menu_button:{type:"web_app",text:"Открыть Карточку",web_app:{url:process.argv[1]}}}))' "$APP_URL")"
  fi
else
  echo "  — setChatMenuButton пропущена: не задан TELEGRAM_WEB_APP_URL"
fi

echo
echo "Готово: успешно ${ok_count}, с ошибкой ${fail_count}."
echo
echo "Что это уже изменило в Telegram:"
echo "  • имя бота, короткое и полное описание в карточке «Что умеет этот бот?»"
echo "  • список команд в меню «/»"
[ -n "$APP_URL" ] && echo "  • кнопку меню «Открыть Карточку»"
echo
echo "Что этим скриптом сделать НЕЛЬЗЯ:"
echo "  • аватар — только @BotFather → /mybots → @${username} → Edit Bot → Edit Botpic"
echo "  • картинку карточки описания — @BotFather → Edit Description Picture"
echo "  • приветствие с GIF и кнопками после /start — нужен деплой Edge Function,"
echo "    см. tools/deploy-telegram.sh"
[ "$fail_count" -gt 0 ] && exit 1
exit 0
