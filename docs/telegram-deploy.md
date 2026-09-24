# Как выгрузить «Карточку» в Telegram

Изменения в GitHub **не меняют бота**. Telegram узнаёт о них только после двух действий:
настройки через Bot API и публикации Edge Function. Ниже — обе, по возрастанию усилий.

Секреты нигде не печатаются и не передаются в чат. Задавайте их через переменные окружения.

---

## Шаг 1. Оформление до Start — 30 секунд, без деплоя

Меняет имя бота, короткое и полное описание в карточке «Что умеет этот бот?», список команд
и кнопку меню. Публиковать функцию для этого не нужно.

```bash
export TELEGRAM_BOT_TOKEN='...'                  # у @BotFather
export TELEGRAM_WEB_APP_URL='https://...'        # необязательно, для кнопки меню
bash tools/telegram-apply.sh
```

Скрипт берёт тексты прямо из кода (`supabase/functions/_shared/bot-onboarding.ts`), поэтому
настройка из терминала не разойдётся с тем, что публикует `{"action":"setup"}`.

Если по адресу приложения отвечает страница входа Vercel, скрипт **не станет** ставить кнопку
меню и скажет об этом: иначе кнопка вела бы пользователей на форму входа.

## Шаг 2. Приветствие с GIF и кнопками — нужен деплой

Само сообщение после `/start` формирует Edge Function, поэтому её надо опубликовать.

```bash
npm i -g supabase && supabase login              # один раз
export SUPABASE_PROJECT_REF='...'                # часть адреса https://<ref>.supabase.co
export TELEGRAM_WEBHOOK_SECRET='...'             # тот же, что в секретах проекта
bash tools/deploy-telegram.sh
```

Скрипт публикует функцию, проверяет наличие трёх обязательных секретов, показывает отчёт
`diagnose` и вызывает `setup`.

**Без вызова `setup` кнопки не работают**: Telegram не присылает `callback_query`, пока
webhook не подписан на этот тип обновлений.

## Шаг 3. Что можно сделать только руками в @BotFather

| Что | Путь |
| --- | --- |
| Аватар бота | `/mybots` → бот → `Edit Bot` → `Edit Botpic` |
| Картинка карточки описания | `/mybots` → бот → `Edit Bot` → `Edit Description Picture` |

Это два разных изображения. Методов Bot API для них нет — проверить можно запросом
`{"action":"brand"}`, он опрашивает живой API и возвращает вердикт в `avatar.api_probe`.

Перед загрузкой аватара проверьте круглую обрезку:

```bash
node tools/avatar-crop-check.cjs assets/branding/avatar-telegram.jpg
```

## Шаг 4. Обложка приветствия

Положите анимацию в `assets/branding/welcome.gif` и убедитесь, что она открывается по адресу
`<адрес приложения>/assets/branding/welcome.gif` **без авторизации** — Telegram скачивает её
сам. Файл в GitHub ещё не значит файл на сайте.

---

## Если бот не изменился

| Симптом | Причина |
| --- | --- |
| Описание до Start старое | не выполнен шаг 1 или `setup` |
| `/start` шлёт старое сообщение | функция не опубликована (шаг 2) |
| Кнопки не реагируют | не вызван `setup`: webhook без `callback_query` |
| Вместо приложения «Log in to Vercel» | `TELEGRAM_WEB_APP_URL` за Deployment Protection |
| Приветствие без картинки | обложка недоступна по HTTPS без входа |
| Аватар прежний | шаг 3, только через BotFather |

Диагностика одним запросом:

```bash
curl -X POST "https://<ref>.supabase.co/functions/v1/telegram" \
  -H "X-Telegram-Bot-Api-Secret-Token: $TELEGRAM_WEBHOOK_SECRET" \
  -H 'Content-Type: application/json' -d '{"action":"diagnose"}'
```

Ответ показывает только факт наличия секретов, но не их значения.
