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
# Скрипт применяет миграции и спрашивает подтверждение перед изменением базы.
# Неинтерактивный запуск (CI): ASSUME_YES=1. Пароль базы — SUPABASE_DB_PASSWORD,
# иначе supabase спросит его сам.
#
# Секреты читаются только из переменных окружения и никогда не печатаются.
set -uo pipefail

# Пути считаются от расположения скрипта, чтобы его можно было запускать из любого каталога.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || { echo "Не найден корень репозитория" >&2; exit 1; }

REF="${SUPABASE_PROJECT_REF:-}"
HOOK_SECRET="${TELEGRAM_WEBHOOK_SECRET:-}"
SUPA="npx --yes supabase"

if [ -z "$REF" ]; then
  echo "Не задан SUPABASE_PROJECT_REF (это часть адреса https://<ref>.supabase.co)." >&2
  exit 2
fi

echo "1/5 Применяю миграции базы…"
# Миграции идут ПЕРЕД публикацией функции: код обращается к таблицам карт сообщества,
# обращений и истории открытий. Опубликовать функцию раньше схемы значит выкатить бота,
# который падает на первом же запросе.
migrations_out="$($SUPA migration list --project-ref "$REF" 2>&1)"
if [ $? -ne 0 ]; then
  echo "  ! Не удалось получить список миграций." >&2
  printf '    %s\n' "$migrations_out" | head -5 >&2
  echo "    Обычно причина: не выполнен '$SUPA login' или неверный SUPABASE_PROJECT_REF." >&2
  exit 1
fi
printf '%s\n' "$migrations_out"

if [ "${ASSUME_YES:-}" != "1" ]; then
  # Изменение схемы рабочей базы не должно происходить молча, даже если все миграции
  # добавляющие: подтверждение стоит одной секунды, откат — несравнимо дороже.
  printf 'Применить перечисленные миграции к проекту %s? [y/N] ' "$REF"
  read -r answer </dev/tty || answer=""
  case "$answer" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Отменено: база не изменена, функция не публиковалась." >&2; exit 3;;
  esac
fi

if ! $SUPA db push --project-ref "$REF"; then
  echo "Миграции не применены. Функцию не публикую: схема и код разошлись бы." >&2
  echo "Если supabase просит пароль базы — задайте SUPABASE_DB_PASSWORD и запустите снова." >&2
  exit 1
fi

echo
echo "2/5 Публикую функцию telegram…"
# _shared подтягивается автоматически: index.ts импортирует telegram.ts и bot-onboarding.ts.
if ! $SUPA functions deploy telegram --project-ref "$REF"; then
  echo "Деплой не прошёл. Проверьте supabase login и права на проект." >&2
  exit 1
fi

echo
echo "3/5 Проверяю обязательные секреты проекта…"
# Список запрашивается ОДИН раз, и сбой команды отличается от отсутствия секрета: иначе
# неудачный login выглядел бы как «ни один секрет не задан», и вы бы задавали их заново.
secrets_out="$($SUPA secrets list --project-ref "$REF" 2>&1)"
secrets_status=$?
if [ "$secrets_status" -ne 0 ]; then
  echo "  ! Не удалось получить список секретов — проверить их не могу." >&2
  printf '    %s\n' "$secrets_out" | head -5 >&2
  echo "    Обычно причина: не выполнен '$SUPA login' или неверный SUPABASE_PROJECT_REF." >&2
  echo "    Функция уже опубликована; настройку можно продолжить после исправления." >&2
  exit 1
fi

missing=0
for name in TELEGRAM_BOT_TOKEN TELEGRAM_WEBHOOK_SECRET TELEGRAM_WEB_APP_URL; do
  if printf '%s' "$secrets_out" | grep -q "\b${name}\b"; then
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
echo "4/5 Проверяю доступность приложения (diagnose)…"
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
echo "5/5 Настраиваю бота (setup)…"
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
