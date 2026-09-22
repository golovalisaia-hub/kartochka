#!/usr/bin/env bash
# Публикация Edge Function `telegram` и настройка бота одной командой.
#
# Нужно один раз:
#   npm i -g supabase            # или npx supabase
#   supabase login               # откроет браузер
#
# Запуск:
#   export SUPABASE_PROJECT_REF='<ref проекта>'   # из адреса https://<ref>.supabase.co
#   export TELEGRAM_WEBHOOK_SECRET='...'          # тот же, что в секретах проекта
#   bash tools/deploy-telegram.sh
#
# Секреты читаются только из переменных окружения и никогда не печатаются.
set -uo pipefail

REF="${SUPABASE_PROJECT_REF:-}"
HOOK_SECRET="${TELEGRAM_WEBHOOK_SECRET:-}"
SUPA="npx --yes supabase"

if [ -z "$REF" ]; then
  echo "Не задан SUPABASE_PROJECT_REF (это часть адреса https://<ref>.supabase.co)." >&2
  exit 2
fi

echo "1/4 Публикую функцию telegram…"
# _shared подтягивается автоматически: index.ts импортирует telegram.ts и bot-onboarding.ts.
if ! $SUPA functions deploy telegram --project-ref "$REF"; then
  echo "Деплой не прошёл. Проверьте supabase login и права на проект." >&2
  exit 1
fi

echo
echo "2/4 Проверяю обязательные секреты проекта…"
missing=0
for name in TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET TELEGRAM_WEB_APP_URL; do
  if $SUPA secrets list --project-ref "$REF" 2>/dev/null | grep -q "^[[:space:]]*${name}[[:space:]]"; then
    echo "  ✓ ${name} задан"
  else
    echo "  ✗ ${name} НЕ задан — задайте: $SUPA secrets set ${name}='...' --project-ref $REF"
    missing=$((missing + 1))
  fi
done
[ "$missing" -gt 0 ] && { echo "Без этих секретов бот не заработает." >&2; exit 1; }

if [ -z "$HOOK_SECRET" ]; then
  echo
  echo "Функция опубликована, но без TELEGRAM_WEBHOOK_SECRET в окружении я не могу вызвать setup."
  echo "Задайте его и запустите скрипт снова, либо вызовите вручную:"
  echo "  curl -X POST https://${REF}.supabase.co/functions/v1/telegram \\"
  echo "    -H 'X-Telegram-Bot-Api-Secret-Token: <секрет>' \\"
  echo "    -H 'Content-Type: application/json' -d '{\"action\":\"setup\"}'"
  exit 0
fi

FN="https://${REF}.supabase.co/functions/v1/telegram"

echo
echo "3/4 Проверяю доступность приложения (diagnose)…"
curl -sS --max-time 30 -X POST "$FN" \
  -H "X-Telegram-Bot-Api-Secret-Token: ${HOOK_SECRET}" \
  -H 'Content-Type: application/json' -d '{"action":"diagnose"}' \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      try{const r=JSON.parse(s);
        console.log("  адрес приложения:", r.web_app_url?.host||"не задан");
        console.log("  отдаёт «Карточку»:", r.web_app_url?.serving_app?"да":"НЕТ — "+(r.web_app_url?.hint||r.web_app_url?.reason||""));
        console.log("  webhook настроен:", r.webhook?.url_matches?"да":"нет");
        console.log("  кнопка меню:", r.menu_button?.opens_app?"открывает приложение":"не настроена");
      }catch(_){console.log("  неожиданный ответ:",s.slice(0,300))}});'

echo
echo "4/4 Настраиваю бота (setup)…"
response="$(curl -sS --max-time 30 -X POST "$FN" \
  -H "X-Telegram-Bot-Api-Secret-Token: ${HOOK_SECRET}" \
  -H 'Content-Type: application/json' -d '{"action":"setup"}')"
printf '%s' "$response" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  try{const r=JSON.parse(s);
    if(r.ok){console.log("  ✓ webhook, команды, описание и кнопка меню настроены");
      console.log("  webhook подтверждён Telegram:", r.webhook?.configured?"да":"нет");
    } else {
      console.log("  ✗ setup отказал:", r.error||"");
      if(r.hint) console.log("    "+r.hint);
    }
  }catch(_){console.log("  неожиданный ответ:",s.slice(0,300))}});'

echo
echo "Осталось сделать вручную в @BotFather:"
echo "  • аватар:            /mybots → бот → Edit Bot → Edit Botpic"
echo "  • картинка описания: /mybots → бот → Edit Bot → Edit Description Picture"
echo
echo "Проверка: откройте бота и отправьте /start."
