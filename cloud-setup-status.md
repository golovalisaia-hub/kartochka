# Облачная синхронизация — проверка 16 сентября 2026

Supabase project `kartochka` exists, but the original website had empty `config.js` and used one-time email codes instead of email/password. `public.cards` was absent before setup. Applied migration `migrations/20260916_cloud_cards.sql` through Supabase and checked security advisors (no findings). Public client must use only the publishable key; never use a service role key in GitHub Pages.

Authentication redirect allow-list and email sending settings cannot be inspected or changed by the available Supabase connector. Confirm in Supabase Dashboard → Authentication → URL Configuration: Site URL and redirect URL must be set to `https://golovalisaia-hub.github.io/kartochka/`. Confirm email provider is enabled. An end-to-end test with a real inbox and two devices is necessary before claiming complete reliability.
