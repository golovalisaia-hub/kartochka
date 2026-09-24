# Supabase Auth settings — verified 18 September 2026

Project: `kartochka-telegram` (`qtyqdlkmfojbebgxcqxl`). The public client uses the publishable/anon key only; no service-role secret is exposed.

## Verified configuration

- Passwordless email authentication is implemented with `/auth/v1/otp` and `/auth/v1/verify` (`type: email`).
- **Magic link or OTP** contains the numeric `{{ .Token }}` code.
- **Confirm sign up** contains `{{ .Token }}` and keeps `{{ .ConfirmationURL }}` as a fallback.
- Site URL: `https://golovalisaia-hub.github.io/kartochka/`
- Redirect allow-list: `https://golovalisaia-hub.github.io/kartochka/`
- Email confirmation remains enabled.

## Email delivery status

An incomplete Gmail custom-SMTP configuration was disabled so it cannot intercept and fail auth mail. Supabase's built-in sender is now the active fallback, but it only sends to pre-authorized project-team addresses and is not intended for production.

Before opening sign-in to arbitrary users, configure a transactional SMTP provider with a verified sender, host, port, username and password. Do not commit SMTP credentials or any service-role key. A real inbox delivery test is still required after those credentials are configured.

## Data protection

`public.cards` has RLS enabled with separate ownership policies for SELECT, INSERT, UPDATE and DELETE. The atomic `apply_card_change` RPC is executable by `authenticated` only, and revisions/tombstones protect against stale overwrites and deletion resurrection.
