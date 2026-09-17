/* Public Supabase config: publishable key is safe in a browser. NEVER use service_role / secret here. */
window.KARTOCHKA_CONFIG = {
  supabaseUrl: 'https://cwiechastoocixpnobuy.supabase.co',
  supabaseAnonKey: 'sb_publishable_QqSAzVdGEW6_iDXoYxbOyw_--W22GiA'
};

/* The existing wallet may be cleared by the old session initializer before
 * the asynchronous Magic Link verification finishes. Preserve its exact bytes
 * first, so even an expired link or offline validation cannot destroy cards.
 */
(() => {
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  if (!(hash.has('access_token') || hash.has('error') || hash.has('error_code'))) return;
  const backup = {
    cards: localStorage.getItem('kartochka.cards.v1'),
    owner: localStorage.getItem('kartochka.cloud-user.v1'),
    session: localStorage.getItem('kartochka.supabase-session.v1')
  };
  window.__kartochkaMagicBackup = backup;
  try { sessionStorage.setItem('kartochka.magic-link-backup.v1', JSON.stringify(backup)); }
  catch (_) { /* The in-memory copy is still available for this page load. */ }
})();

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

/* Independent local utilities. Temporary email link flow, no passwords. */
for (const src of ['./backup.js', './card-quality.js', './auth-magic-link.js']) {
  const script = document.createElement('script');
  script.src = src;
  script.async = false;
  document.head.append(script);
}
