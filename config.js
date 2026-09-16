/*
 * Публичная конфигурация Supabase.
 * Эти значения безопасно хранить во фронтенде: доступ к данным ограничивает RLS.
 * Не вставляйте сюда service_role key.
 */
window.KARTOCHKA_CONFIG = {
  supabaseUrl: '',
  supabaseAnonKey: ''
};

/* Photo-name compatibility: the scanner may treat the dot before .png/.jpg
   as part of a store name. Apply an extracted filename hint only to an empty
   store field after the scanner opens the review form; never override a match
   from the photo or the user's own input. */
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

/* Load the independent backup interface. It waits for DOMContentLoaded and
   cannot mutate the wallet unless the user selects and confirms a file. */
(() => {
  const script = document.createElement('script');
  script.src = './backup.js';
  script.async = false;
  document.head.append(script);
})();