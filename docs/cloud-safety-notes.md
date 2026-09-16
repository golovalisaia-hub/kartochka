# Cloud safety

Account authentication must rely on Supabase Auth; no passwords stored in localStorage. Row-level security on `public.cards` restricts each operation to the authenticated owner. Treat browser-stored card data as sensitive and avoid logging or publishing real codes. The application currently keeps local copies; losing the browser's site data can lose unsynced changes. Real two-device, email-delivery, and sign-out race tests remain necessary before claiming complete cloud reliability.
