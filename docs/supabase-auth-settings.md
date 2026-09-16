# Required Supabase Auth settings

Supabase project `kartochka` is connected to the public app through a publishable key, not a service role key. Password login is configured in the website, but a real inbox test and project authentication settings confirmation are required before production readiness.

In Supabase Dashboard -> Authentication -> URL Configuration, set Site URL to `https://golovalisaia-hub.github.io/kartochka/` and add the same redirect URL. Authentication -> Providers -> Email must be enabled. Leave email confirmation ON. The default SMTP relay may have limits; set up a reliable sender before welcoming many users.

Never publish a service_role/secret key or a user's password. A successful static-site deployment proves neither email delivery nor cross-device synchronization.
