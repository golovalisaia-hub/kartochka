/* Card integrity and editing. No external network calls; all changes are user-initiated. */
(() => {
  'use strict';
  const KEY = 'kartochka.cards.v1';
  const $ = id => document.getElementById(id);
  const ascii128 = value => /^[\x20-\x7e]+$/.test(value) && !/\s/.test(value);
  const ean13 = value => {
    if (!/^\d{13}$/.test(value)) return false;
    const sum = [...value.slice(0, 12)].reduce((total, digit, i) => total + Number(digit) * (i % 2 ? 3 : 1), 0);
    return (10 - sum % 10) % 10 === Number(value[12]);
  };
  const readCards = () => {
    const data = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(data)) throw new Error('Не удалось прочитать сохранённые карты.');
    return data;
  };
  const invalid128 = 'Code 128: кириллица, спецсимволы и пробелы сейчас не поддерживаются без искажения. Используйте точный код с фотографии или проверьте формат.';
  const styles = `.card-edit-action{display:block;width:calc(100% - 40px);margin:12px 20px 0;min-height:48px;border:1px solid #c9c9ce;background:#fff;border-radius:14px;color:#191919;font-size:15px;font-weight:700;cursor:pointer}.card-edit-layer{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.73);display:flex;align-items:center;justify-content:center;padding:18px;overflow:auto}.card-edit-layer[hidden]{display:none!important}.card-edit-dialog{background:#202024;color:#fff;border:1px solid #424248;border-radius:24px;padding:22px;width:min(100%,420px);max-height:calc(100dvh - 36px);overflow:auto;box-shadow:0 18px 80px #0009}.card-edit-dialog h2{font-size:22px;margin:0 0 16px}.card-edit-dialog label{display:block;font-size:13px;color:#d5d5dd;margin:14px 0}.card-edit-dialog input,.card-edit-dialog select{display:block;width:100%;min-height:46px;box-sizing:border-box;margin-top:7px;border:1px solid #56565d;border-radius:12px;background:#303036;color:white;padding:10px 12px;font-size:16px}.card-edit-dialog p{font-size:13px;color:#d9d9e0;line-height:1.45}.card-edit-dialog .edit-error{color:#ffadb0;min-height:20px}.card-edit-buttons{display:flex;gap:10px;margin-top:18px}.card-edit-buttons button{flex:1;min-height:46px;border-radius:12px;border:0;font-weight:700}.card-edit-cancel{background:#46464d;color:white}.card-edit-save{background:#fafafa;color:#111}.code-integrity-error{font-size:15px;line-height:1.5;text-align:center;color:#9c2525;padding:14px}`;
  let activeId = null;
  let restoringFocus = null;

  // The original Code 128 renderer replaces unsupported characters with '?'.
  // Block lossy new saves before its own submit handler runs.
  document.addEventListener('submit', event => {
    if (event.target?.id !== 'cardForm') return;
    const format = $('cardFormat')?.value;
    const raw = $('cardNumber')?.value || '';
    const eanAuto = format === 'auto' && ean13(raw.replace(/\s+/g, ''));
    if ((format === 'code_128' || (format === 'auto' && !eanAuto)) && !ascii128(raw.trim())) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const result = $('recognitionResult');
      if (result) { result.textContent = invalid128; result.hidden = false; result.classList.remove('recognized'); }
      $('cardNumber')?.focus();
    }
  }, true);

  function showLegacyCodeSafely() {
    const overlay = $('cardOverlay');
    const mount = $('barcodeMount');
    if (!overlay || overlay.hidden || !mount) return;
    const store = $('detailStore')?.textContent || '';
    const number = $('barcodeNumber')?.textContent || '';
    let cards;
    try { cards = readCards(); } catch { return; }
    const card = cards.find(item => item.store === store && item.number === number && item.format === 'code_128');
    if (!card || ascii128(card.number)) return;
    if (mount.querySelector('.code-integrity-error') || mount.querySelector('.code-integrity-original')) return;
    mount.replaceChildren();
    if (typeof card.codeImage === 'string' && /^data:image\/(?:png|jpeg|webp);base64,/i.test(card.codeImage)) {
      const image = document.createElement('img');
      image.src = card.codeImage;
      image.alt = 'Оригинальное изображение кода';
      image.className = 'code-integrity-original';
      image.style.cssText = 'display:block;max-width:100%;max-height:230px;object-fit:contain;margin:auto';
      mount.append(image);
    } else {
      const warning = document.createElement('p');
      warning.className = 'code-integrity-error';
      warning.textContent = 'Исходный код нельзя безопасно восстановить. Уточните формат и пересканируйте карту: изменённый штрихкод показывать нельзя.';
      mount.append(warning);
    }
  }

  function closeEditor() {
    const dialog = $('cardEditLayer');
    if (!dialog || dialog.hidden) return;
    dialog.hidden = true;
    activeId = null;
    if (restoringFocus?.isConnected) restoringFocus.focus();
  }
  function openEditor() {
    try {
      const cards = readCards();
      const store = $('detailStore')?.textContent;
      const shown = $('barcodeNumber')?.textContent;
      const match = cards.filter(item => item.store === store && (item.number === shown || (item.format === 'qr_code' && shown === 'QR-код')));
      const card = match.find(item => item.id === activeId) || match[0];
      if (!card) { window.alert('Не удалось найти карту. Откройте её повторно.'); return; }
      activeId = card.id;
      restoringFocus = $('cardEditButton');
      $('editStore').value = card.store;
      $('editNumber').value = card.number;
      const select = $('editFormat');
      select.replaceChildren();
      const known = ['code_128','ean_13','qr_code'];
      (known.includes(card.format) ? known : [card.format]).forEach(format => {
        const option = document.createElement('option');
        option.value = format;
        option.textContent = ({ code_128:'Code 128', ean_13:'EAN-13', qr_code:'QR-код' })[format] || `${format} (оригинал)`;
        select.append(option);
      });
      select.value = card.format;
      const locked = !known.includes(card.format);
      $('editNumber').disabled = locked;
      select.disabled = locked;
      $('editHelp').textContent = locked ? 'Для этого формата сохранено исходное изображение. Можно изменить название, но не код.' : 'Проверьте номер и формат: от них зависит считывание на кассе.';
      $('editError').textContent = '';
      $('cardEditLayer').hidden = false;
      $('editStore').focus();
    } catch (error) { window.alert(error.message); }
  }
  function saveEdit(event) {
    event.preventDefault();
    const error = $('editError');
    error.textContent = '';
    try {
      const cards = readCards();
      const index = cards.findIndex(item => item.id === activeId);
      if (index < 0) throw new Error('Карта не найдена. Перезагрузите страницу.');
      const original = cards[index];
      const store = $('editStore').value.trim();
      const format = $('editFormat').value;
      const number = $('editNumber').disabled ? original.number : $('editNumber').value;
      if (!store || store.length > 28 || !number.trim() || number.length > 120) throw new Error('Введите название до 28 символов и номер до 120 символов.');
      if (format === 'ean_13' && !ean13(number)) throw new Error('EAN-13: проверьте 13 цифр и контрольную цифру.');
      if (format === 'code_128' && !ascii128(number)) throw new Error(invalid128);
      if (cards.some((item, i) => i !== index && item.store.trim().toLocaleLowerCase('ru') === store.toLocaleLowerCase('ru') && item.format === format && item.number === number)) throw new Error('Такая карта уже сохранена.');
      if (original.store === store && original.number === number && original.format === format) { closeEditor(); return; }
      const updated = { ...original, store, number, format, lastUsed: Math.max(Date.now(), Number(original.lastUsed || 0) + 1) };
      if (original.number !== number || original.format !== format) updated.codeImage = null;
      cards[index] = updated;
      // Single atomic write. Never modify the in-memory wallet if storage fails.
      localStorage.setItem(KEY, JSON.stringify(cards));
      // The existing cloud initializer compares lastUsed and syncs this revision on reload.
      window.location.reload();
    } catch (reason) { error.textContent = reason.message || 'Не удалось сохранить карту.'; }
  }
  function boot() {
    if ($('cardEditLayer') || !$('cardOverlay')) return;
    const style = document.createElement('style');
    style.textContent = styles;
    document.head.append(style);
    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'cardEditButton';
    button.className = 'card-edit-action';
    button.textContent = 'Изменить карту';
    $('barcodePanel').insertAdjacentElement('afterend', button);
    button.addEventListener('click', openEditor);
    const layer = document.createElement('div');
    layer.id = 'cardEditLayer';
    layer.className = 'card-edit-layer';
    layer.hidden = true;
    layer.innerHTML = '<form class="card-edit-dialog" id="cardEditForm" role="dialog" aria-modal="true" aria-labelledby="cardEditTitle"><h2 id="cardEditTitle">Изменить карту</h2><label>Магазин<input id="editStore" maxlength="28" required></label><label>Номер или содержимое кода<input id="editNumber" maxlength="120" required autocapitalize="off" spellcheck="false"></label><label>Формат кода<select id="editFormat"></select></label><p id="editHelp"></p><p id="editError" class="edit-error" role="alert"></p><div class="card-edit-buttons"><button type="button" class="card-edit-cancel" id="editCancel">Отмена</button><button type="submit" class="card-edit-save">Сохранить</button></div></form>';
    document.body.append(layer);
    $('editCancel').addEventListener('click', closeEditor);
    layer.addEventListener('click', event => { if (event.target === layer) closeEditor(); });
    $('cardEditForm').addEventListener('submit', saveEdit);
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || layer.hidden) return;
      event.preventDefault(); event.stopImmediatePropagation(); closeEditor();
    }, true);
    // Observe existing detail transitions, but only touch demonstrably lossy legacy codes.
    const mount = $('barcodeMount');
    const observer = new MutationObserver(() => showLegacyCodeSafely());
    observer.observe(mount, { childList: true });
    $('cardOverlay').addEventListener('click', event => {
      if (event.target.closest('.stack-card,.grid-card')) return;
      queueMicrotask(showLegacyCodeSafely);
    });
    document.addEventListener('click', event => {
      if (event.target.closest('.stack-card,.grid-card')) queueMicrotask(showLegacyCodeSafely);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();