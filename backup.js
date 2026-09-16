/* Optional, fully local backups. This file does not send card data to a server. */
(() => {
  'use strict';
  const KEY = 'kartochka.cards.v1';
  const TYPE = 'kartochka-backup';
  const MAX_FILE = 12 * 1024 * 1024;
  const MAX_IMAGE = 3 * 1024 * 1024;
  const hex = value => typeof value === 'string' && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(value);
  const ean13 = value => {
    if (!/^\d{13}$/.test(value)) return false;
    const sum = [...value.slice(0, 12)].reduce((n, d, i) => n + Number(d) * (i % 2 ? 3 : 1), 0);
    return (10 - sum % 10) % 10 === Number(value[12]);
  };
  function cardsOnDevice() {
    const data = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(data)) throw new Error('Хранилище карт повреждено. Не заменяйте его резервной копией.');
    return data;
  }
  function normalized(card) {
    if (!card || typeof card !== 'object' || Array.isArray(card)) throw new Error('Некорректная запись карты.');
    const store = typeof card.store === 'string' ? card.store.trim() : '';
    const number = typeof card.number === 'string' ? card.number : '';
    const format = typeof card.format === 'string' ? card.format : 'code_128';
    if (!store || store.length > 28 || !number.trim() || number.length > 120) throw new Error('В архиве есть карта с некорректным названием или номером.');
    if (!/^[a-z][a-z0-9_]{1,29}$/.test(format)) throw new Error('В архиве указан неизвестный тип кода.');
    if (format === 'ean_13' && !ean13(number)) throw new Error('В архиве есть EAN-13 с неверной контрольной цифрой.');
    if (format === 'code_128' && !/^[\x20-\x7e]+$/.test(number)) throw new Error('Код Code 128 содержит символы, которые приложение не может воспроизвести без изменений.');
    const codeImage = card.codeImage == null ? null : card.codeImage;
    if (codeImage !== null && (typeof codeImage !== 'string' || codeImage.length > MAX_IMAGE || !/^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=]+$/i.test(codeImage))) {
      throw new Error('В архиве есть неподдерживаемое изображение кода.');
    }
    if (!['qr_code','ean_13','code_128'].includes(format) && !codeImage) throw new Error('Для этого типа кода в архиве отсутствует изображение.');
    return {
      id: crypto.randomUUID(), store, number, format, codeImage,
      a: hex(card.a) ? card.a : '#29292c',
      b: hex(card.b) ? card.b : '#101012',
      text: hex(card.text) ? card.text : '#fff',
      lastUsed: Number.isFinite(card.lastUsed) && card.lastUsed > 0 ? card.lastUsed : Date.now()
    };
  }
  const identity = card => [card.store.normalize('NFKC').trim().toLocaleLowerCase('ru'), card.format || 'code_128', card.number].join('\u001f');

  function boot() {
    const view = document.getElementById('designView');
    if (!view || document.getElementById('backupPanel')) return;
    const panel = document.createElement('section');
    panel.id = 'backupPanel';
    panel.className = 'backup-panel';
    panel.setAttribute('aria-labelledby', 'backupTitle');
    panel.innerHTML = '<h2 id="backupTitle">Резервная копия</h2><p>Сохраните карты в файл, чтобы перенести их на другое устройство или восстановить после потери данных.</p><p class="backup-warning">Файл содержит полные номера и QR-коды. Храните его в надёжном месте и никому не отправляйте.</p><p id="backupCount"></p><div class="backup-actions"><button type="button" id="backupExport" class="primary-button">Скачать копию</button><button type="button" id="backupImport" class="secondary-button">Восстановить из файла</button></div><input type="file" id="backupInput" accept=".json,application/json" hidden><p id="backupStatus" role="status" aria-live="polite"></p>';
    view.append(panel);
    const style = document.createElement('style');
    style.textContent = '.backup-panel{margin:28px 0 112px;padding:20px;border:1px solid rgba(255,255,255,.13);border-radius:24px;background:#1b1b1e;color:#fff}.backup-panel h2{font-size:22px;margin:0 0 12px}.backup-panel p{color:#b7b7bd;font-size:14px;line-height:1.5;margin:8px 0}.backup-panel .backup-warning{color:#eec78e}.backup-panel .backup-actions{display:grid;grid-template-columns:1fr;gap:10px;margin-top:18px}.backup-panel .backup-actions button{width:100%;min-height:52px;font-size:14px}.backup-panel #backupStatus{min-height:18px;color:#a9e1bb;overflow-wrap:anywhere}@media(min-width:560px){.backup-panel .backup-actions{grid-template-columns:1fr 1fr}}';
    document.head.append(style);
    const status = panel.querySelector('#backupStatus');
    const count = panel.querySelector('#backupCount');
    const updateCount = () => {
      try { count.textContent = `Сейчас на устройстве: ${cardsOnDevice().length} карт.`; }
      catch (error) { count.textContent = error.message; }
    };
    updateCount();
    document.querySelector('[data-view="design"]')?.addEventListener('click', updateCount);
    panel.querySelector('#backupExport').addEventListener('click', () => {
      try {
        const cards = cardsOnDevice();
        const data = JSON.stringify({ type: TYPE, version: 1, createdAt: new Date().toISOString(), cards }, null, 2);
        const url = URL.createObjectURL(new Blob([data], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = `kartochka-backup-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        status.textContent = `Сохранена копия: ${cards.length} карт. Не отправляйте файл посторонним.`;
      } catch (error) { status.textContent = `Не получилось создать копию: ${error.message}`; }
    });
    const input = panel.querySelector('#backupInput');
    panel.querySelector('#backupImport').addEventListener('click', () => input.click());
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.value = '';
      if (!file) return;
      try {
        if (file.size > MAX_FILE) throw new Error('Размер файла больше 12 МБ.');
        const backup = JSON.parse(await file.text());
        if (!backup || backup.type !== TYPE || backup.version !== 1 || !Array.isArray(backup.cards) || backup.cards.length > 1000) {
          throw new Error('Выберите JSON-копию «Карточки» версии 1 (не более 1000 карт).');
        }
        // Validate the ENTIRE input before ever touching localStorage.
        const imported = backup.cards.map(normalized);
        const current = cardsOnDevice();
        const known = new Set(current.map(identity));
        const additions = imported.filter(card => {
          const key = identity(card);
          if (known.has(key)) return false;
          known.add(key);
          return true;
        });
        if (!additions.length) { status.textContent = 'Новых карт нет: все карты из копии уже сохранены.'; return; }
        const online = document.querySelector('#accountButton')?.classList.contains('signed-in');
        const message = `Добавить ${additions.length} карт из файла? Существующие ${current.length} карт останутся без изменений.${online ? ' Включённая синхронизация может добавить их и в облачный аккаунт.' : ''}`;
        if (!window.confirm(message)) { status.textContent = 'Восстановление отменено. Карты не изменены.'; return; }
        // One atomic write; a storage/quota error leaves all original cards unchanged.
        localStorage.setItem(KEY, JSON.stringify([...current, ...additions]));
        status.textContent = `Добавлено ${additions.length} карт. Перезагружаем приложение…`;
        window.location.reload();
      } catch (error) { status.textContent = `Восстановление не выполнено: ${error.message}`; }
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();