/* Public Supabase configuration; never place a service_role key here. */
window.KARTOCHKA_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: ''
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

/* Independent, local-only backup and integrity/edit modules. */
for (const src of ['./backup.js', './card-quality.js']) {
  const script = document.createElement('script');
  script.src = src;
  script.async = false;
  document.head.append(script);
}
