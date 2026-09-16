/* Public Supabase config: publishable key is safe in a browser. NEVER use service_role / secret here. */
window.KARTOCHKA_CONFIG = {
  supabaseUrl: 'https://cwiechastoocixpnobuy.supabase.co',
  supabaseAnonKey: 'sb_publishable_QqSAzVdGEW6_iDXoYxbOyw_--W22GiA'
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

/* Independent local utilities. Authentication stays email + one-time code. */
for (const src of ['./backup.js', './card-quality.js']) {
  const script = document.createElement('script');
  script.src = src;
  script.async = false;
  document.head.append(script);
}
