# «Карточка»: вход только по коду из письма

**Причина проблемы «приходит ссылка, а не код»:** `/auth/v1/otp` в приложении уже запрашивает OTP, но Supabase выбирает содержимое письма из серверного шаблона. Стандартный шаблон отправляет Magic Link. Исправление HTML приложения само по себе не заменяет письмо.

## Одноразовая настройка владельцем

1. Откройте проект **kartochka-telegram**: [Authentication → Email Templates](https://supabase.com/dashboard/project/qtyqdlkmfojbebgxcqxl/auth/templates).
2. Выберите **Magic Link / OTP** (интерфейс может называть вкладку **Magic Link**). Сохраните тему `Код входа в Карточку`, а HTML-содержимое замените на:

   ```html
   <h2>Код входа в Карточку</h2>
   <p>Введите этот одноразовый код в приложении:</p>
   <p><strong>{{ .Token }}</strong></p>
   <p>Если вы не запрашивали код, проигнорируйте письмо.</p>
   ```

3. Аналогично измените шаблон **Confirm signup / Confirm sign up** для первого входа нового пользователя: оставьте короткий текст и `{{ .Token }}` вместо ссылки. Первый вход и повторный вход могут выбирать разные шаблоны. Не отключайте проверку почты.
4. Проверьте [Authentication → URL Configuration](https://supabase.com/dashboard/project/qtyqdlkmfojbebgxcqxl/auth/url-configuration): Site URL должен совпадать с отдельным HTTPS-адресом Telegram-теста.
5. Откройте приложение, запросите **новое** письмо. Старые письма со ссылкой нельзя вставить в поле кода. Введите полученные цифры. Затем добавьте **только вымышленную** тестовую карту и проверьте её на втором устройстве.

**Если запрос отклонён:** откройте [Auth Logs](https://supabase.com/dashboard/project/qtyqdlkmfojbebgxcqxl/logs/auth-logs) и посмотрите только код ошибки. Встроенная SMTP-служба Supabase ограничена адресами участников команды; для регистрации любых пользователей нужна собственная почтовая служба через [Authentication → SMTP Settings](https://supabase.com/dashboard/project/qtyqdlkmfojbebgxcqxl/auth/smtp). Если письма со ссылкой уже приходят на нужный адрес, сначала исправьте шаблоны, не меняйте SMTP без необходимости.

Не публикуйте API service_role, пароли SMTP, коды из писем и содержимое личных карт в GitHub или переписке.

Документация: https://supabase.com/docs/guides/auth/auth-email-passwordless ; https://supabase.com/docs/guides/auth/auth-email-templates ; https://supabase.com/docs/guides/auth/auth-smtp
