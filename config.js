/* Public Supabase config: publishable key is safe in a browser. NEVER use service_role / secret here. */
window.KARTOCHKA_CONFIG = {
  supabaseUrl: 'https://qtyqdlkmfojbebgxcqxl.supabase.co',
  supabaseAnonKey: 'sb_publishable_eyYpf8NHcvSMgy15sNG_bg_FgaRnlUe'
};

/* Photo filename is only a hint; never overwrite a recognized or typed store. */
(() => {
  let filenameHint = null;
  window.addEventListener('change', event => {
    if (!['galleryInput', 'cameraInput'].includes(event.target?.id)) return;
    const filename = event.target.files?.[0]?.name || '';
    const base = filename.replace(/\.[^.]+$/, '').replace(/[._-]+/g, ' ');
    filenameHint = window.KartochkaScanner?.findBrand(base) || null;
  }, true);
  document.addEventListener('click', event => {
    if (event.target?.id !== 'openManual') return;
    const hint = filenameHint;
    filenameHint = null;
    if (!hint) return;
    queueMicrotask(() => {
      const store = document.getElementById('storeName');
      if (!store || store.value.trim()) return;
      store.value = hint;
      store.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }, true);
})();

/* Independent local utilities. Auth accepts Supabase email links now and remains compatible with numeric OTP later. */
for (const src of ['./auth-magic-link.js', './backup.js', './card-quality.js', './auth-delivery.js']) {
  const script = document.createElement('script');
  script.src = src;
  script.async = false;
  document.head.append(script);
}
