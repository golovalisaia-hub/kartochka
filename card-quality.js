/* Local card editing and lossless barcode guard. No network calls. */
(() => {
  'use strict';
  const KEY = 'kartochka.cards.v1';
  const $ = id => document.getElementById(id);
  const ascii128 = value => /^[\x20-\x7e]+$/.test(value) && !/\s/.test(value);
  const ean13 = value => {
    if (!/^\d{13}$/.test(value)) return false;
    const sum = [...value.slice(0, 12)].reduce((n, digit, i) => n + Number(digit) * (i % 2 ? 3 : 1), 0);
    return (10 - sum % 10) % 10 === Number(value[12]);
  };
  const readCards = () => {
    const data = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(data)) throw new Error('Не удалось прочитать сохранённые карты.');
    return data;
  };
  const invalid128 = 'Code 128: кириллица, спецсимволы и пробелы пока не поддерживаются без искажения. Проверьте формат или используйте оригинальное изображение кода.';
  let activeId = null;
  let previousFocus = null;

  // The older renderer replaces unsupported characters with '?'. Intercept before its submit handler.
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

  // Record which actual card was tapped BEFORE the original handler re-sorts the wallet.
  document.addEventListener('click', event => {
    const button = event.target?.closest?.('.stack-card,.grid-card');
    if (!button) return;
    try {
      const sorted = readCards().sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
      const isGrid = button.classList.contains('grid-card');
      const siblings = [...button.parentElement.querySelectorAll(isGrid ? '.grid-card' : '.stack-card')];
      const index = siblings.indexOf(button);
      const query = isGrid ? ($('cardSearch')?.value || '').trim().toLocaleLowerCase('ru') : '';
      const available = isGrid ? sorted.filter(card => card.store.toLocaleLowerCase('ru').includes(query)) : sorted.slice(0, 3);
      activeId = available[index]?.id || null;
    } catch { activeId = null; }
  }, true);

  function protectLegacyBarcode() {
    const mount = $('barcodeMount');
    if (!mount || $('cardOverlay')?.hidden) return;
    const store = $('detailStore')?.textContent || '';
    const number = $('barcodeNumber')?.textContent || '';
    let cards;
    try { cards = readCards(); } catch { return; }
    const card = cards.find(item => item.id === activeId) || cards.find(item => item.store === store && item.number === number && item.format === 'code_128');
    if (!card || card.format !== 'code_128' || ascii128(card.number)) return;
    if (mount.querySelector('.code-integrity-error,.code-integrity-original')) return;
    mount.replaceChildren();
    if (typeof card.codeImage === 'string' && /^data:image\/(?:png|jpeg|webp);base64,/i.test(card.codeImage)) {
      const original = document.createElement('img');
      original.src = card.codeImage;
      original.alt = 'Исходное изображение кода';
      original.className = 'code-integrity-original';
      original.style.cssText = 'display:block;max-width:100%;max-height:230px;object-fit:contain;margin:auto';
      mount.append(original);
    } else {
      const warning = document.createElement('p');
      warning.className = 'code-integrity-error';
      warning.textContent = 'Нельзя безопасно восстановить этот штрихкод. Уточните формат и пересканируйте карту.';
      mount.append(warning);
    }
  }

  function closeEdit() {
    const layer = $('cardEditLayer');
    if (layer?.hidden !== false) return;
    layer.hidden = true;
    if (previousFocus?.isConnected) previousFocus.focus();
  }
  function openEdit() {
    try {
      const cards = readCards();
      const store = $('detailStore')?.textContent || '';
      const digits = $('detailDigits')?.textContent || '';
      const shown = $('barcodeNumber')?.textContent || '';
      const candidates = cards.filter(item => item.store === store && ('•••• ' + String(item.number).slice(-4).padStart(4, '0')) === digits && (item.number === shown || (item.format === 'qr_code' && shown === 'QR-код')));
      const selected = cards.find(item => item.id === activeId);
      const card = selected && candidates.some(item => item.id === selected.id) ? selected : candidates.length === 1 ? candidates[0] : null;
      if (!card) throw new Error('Не удалось однозначно определить карту. Закройте её и откройте повторно.');
      activeId = card.id;
      previousFocus = $('cardEditButton');
      $('editStore').value = card.store;
      $('editNumber').value = card.number;
      const formatInput = $('editFormat');
      formatInput.replaceChildren();
      const known = ['code_128', 'ean_13', 'qr_code'];
      (known.includes(card.format) ? known : [card.format]).forEach(format => {
        const option = document.createElement('option');
        option.value = format;
        option.textContent = ({ code_128:'Code 128', ean_13:'EAN-13', qr_code:'QR-код' })[format] || `${format} (оригинал)`;
        formatInput.append(option);
      });
      formatInput.value = card.format;
      const locked = !known.includes(card.format);
      $('editNumber').disabled = locked;
      formatInput.disabled = locked;
      $('editHelp').textContent = locked ? 'Код хранится как оригинальное изображение. Можно изменить название, но нельзя менять содержимое кода.' : 'Проверьте номер и формат перед сохранением: ошибка помешает считыванию на кассе.';
      $('editError').textContent = '';
      $('cardEditLayer').hidden = false;
      $('editStore').focus();
    } catch (error) { window.alert(error.message || 'Не удалось открыть редактирование.'); }
  }
  function saveEdit(event) {
    event.preventDefault();
    $('editError').textContent = '';
    try {
      const cards = readCards();
      const index = cards.findIndex(item => item.id === activeId);
      if (index < 0) throw new Error('Карта не найдена. Перезагрузите страницу.');
      const original = cards[index];
      const store = $('editStore').value.trim();
      const format = $('editFormat').value;
      const number = $('editNumber').disabled ? original.number : $('editNumber').value;
      if (!store || store.length > 28 || !number.trim() || number.length > 120) throw new Error('Название — до 28 символов, содержимое кода — до 120.');
      if (format === 'ean_13' && !ean13(number)) throw new Error('EAN-13: проверьте 13 цифр и контрольную цифру.');
      if (format === 'code_128' && !ascii128(number)) throw new Error(invalid128);
      if (cards.some((item, i) => i !== index && item.store.trim().toLocaleLowerCase('ru') === store.toLocaleLowerCase('ru') && item.format === format && item.number === number)) throw new Error('Такая карта уже сохранена.');
      if (original.store === store && original.number === number && original.format === format) { closeEdit(); return; }
      const updated = { ...original, store, number, format, lastUsed: Math.max(Date.now(), Number(original.lastUsed || 0) + 1) };
      if (original.number !== number || original.format !== format) updated.codeImage = null;
      cards[index] = updated;
      // Single atomic write. On a quota error original local data remains intact.
      const json = JSON.stringify(cards);
      localStorage.setItem(KEY, json);
      try { localStorage.setItem('kartochka.cards.recovery.v1', json); } catch (_) {}
      window.KartochkaRecovery?.save?.(cards);
      // Existing cloud sync uses lastUsed to merge this revision when the app reloads.
      window.location.reload();
    } catch (error) { $('editError').textContent = error.message || 'Не удалось сохранить карту.'; }
  }
  function boot() {
    if ($('cardEditLayer') || !$('cardOverlay')) return;
    const style = document.createElement('style');
    style.textContent = '.card-edit-action{display:block;width:calc(100% - 40px);margin:12px 20px 0;min-height:48px;border:1px solid #c9c9ce;background:#fff;border-radius:14px;color:#191919;font-size:15px;font-weight:700;cursor:pointer}.card-edit-layer{position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,.73);display:flex;align-items:center;justify-content:center;padding:18px;overflow:auto}.card-edit-layer[hidden]{display:none!important}.card-edit-dialog{background:#202024;color:white;border:1px solid #424248;border-radius:24px;padding:22px;width:min(100%,420px);max-height:calc(100dvh - 36px);overflow:auto;box-shadow:0 18px 80px #0009}.card-edit-dialog h2{font-size:22px;margin:0 0 16px}.card-edit-dialog label{display:block;font-size:13px;color:#d5d5dd;margin:14px 0}.card-edit-dialog input,.card-edit-dialog select{display:block;width:100%;min-height:46px;box-sizing:border-box;margin-top:7px;border:1px solid #56565d;border-radius:12px;background:#303036;color:white;padding:10px 12px;font-size:16px}.card-edit-dialog p{font-size:13px;color:#d9d9e0;line-height:1.45}.card-edit-dialog .edit-error{color:#ffadb0;min-height:20px}.card-edit-buttons{display:flex;gap:10px;margin-top:18px}.card-edit-buttons button{flex:1;min-height:46px;border-radius:12px;border:0;font-weight:700}.card-edit-cancel{background:#46464d;color:white}.card-edit-save{background:#fafafa;color:#111}.code-integrity-error{font-size:15px;line-height:1.5;text-align:center;color:#9c2525;padding:14px}';
    document.head.append(style);
    const button = document.createElement('button');
    button.type = 'button'; button.id = 'cardEditButton'; button.className = 'card-edit-action'; button.textContent = 'Изменить карту';
    $('barcodePanel').insertAdjacentElement('afterend', button);
    button.addEventListener('click', openEdit);
    const layer = document.createElement('div');
    layer.id = 'cardEditLayer'; layer.className = 'card-edit-layer'; layer.hidden = true;
    layer.innerHTML = '<form class="card-edit-dialog" id="cardEditForm" role="dialog" aria-modal="true" aria-labelledby="cardEditTitle"><h2 id="cardEditTitle">Изменить карту</h2><label>Магазин<input id="editStore" maxlength="28" required></label><label>Номер или содержимое кода<input id="editNumber" maxlength="120" required autocapitalize="off" spellcheck="false"></label><label>Формат кода<select id="editFormat"></select></label><p id="editHelp"></p><p id="editError" class="edit-error" role="alert"></p><div class="card-edit-buttons"><button type="button" class="card-edit-cancel" id="editCancel">Отмена</button><button type="submit" class="card-edit-save">Сохранить</button></div></form>';
    document.body.append(layer);
    $('editCancel').addEventListener('click', closeEdit);
    layer.addEventListener('click', event => { if (event.target === layer) closeEdit(); });
    $('cardEditForm').addEventListener('submit', saveEdit);
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || layer.hidden) return;
      event.preventDefault(); event.stopImmediatePropagation(); closeEdit();
    }, true);
    const observer = new MutationObserver(protectLegacyBarcode);
    observer.observe($('barcodeMount'), { childList:true });
    document.addEventListener('click', event => {
      if (event.target?.closest?.('.stack-card,.grid-card')) queueMicrotask(protectLegacyBarcode);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once:true });
  else boot();
})();
