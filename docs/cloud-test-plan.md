# Test plan for email/password cloud sync

1. Register with a test email and password; verify confirmation email link works and returns to the website. Do not share passwords or tokens.
2. Sign in on device A. Add a fake QR test card, press Sync, wait for an explicit success indicator.
3. Sign in as the same account in a separate browser profile/device B; check the card appears. Edit and delete there, sync and verify on A.
4. Sign in as a different test account in profile C: it must not read/write/delete the first account's cards.
5. Test offline editing, reconnect, reload, and sign out only after confirmation that unsynced cards are safe.
6. Keep real cards out of test runs. Verify RLS and API anonymous access in project independently.

A green GitHub Pages deploy alone is not evidence that real cloud sync or email deliverability works.
