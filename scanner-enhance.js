/* Local card-photo recognition. Store names are suggestions; code symbology is read from pixels, never inferred from a shop. */
(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const CARDS_KEY = 'kartochka.cards.v1';
  const MEMORY_KEY = 'kartochka.brand-memory.v1';
  const catalog = [
    ['Перекрёсток', ['перекресток', 'perekrestok', 'perekrestok.ru']],
    ['Пятёрочка', ['пятерочка', 'пятёрочка', '5ka.ru', 'pyaterochka', '5ka']],
    ['X5 Клуб', ['x5 клуб', 'x5 club', 'x5club.ru']],
    ['Магнит', ['магнит', 'magnit', 'moy.magnit.ru', 'my.magnit.ru']],
    ['Лента', ['лента', 'lenta.com', 'lenta.ru']],
    ['ВкусВилл', ['вкусвилл', 'vkusvill', 'vkusvill.ru']],
    ['Дикси', ['дикси', 'dixy', 'dixy.ru']],
    ['Ашан', ['ашан', 'auchan']],
    ['О’КЕЙ', ['окей', 'o key', 'okmarket', 'okmarket.ru']],
    ['METRO', ['метро', 'metro cash', 'metro c&c', 'metro-cc']],
    ['Мираторг', ['мираторг', 'miratorg']],
    ['Спортмастер', ['спортмастер', 'sportmaster']],
    ['Детский мир', ['детский мир', 'detmir', 'detmir.ru']],
    ['Золотое Яблоко', ['золотое яблоко', 'goldapple']],
    ['Подружка', ['подружка', 'podrygka']],
    ['Рив Гош', ['рив гош', 'rive gauche', 'rivegauche']],
    ['Лэтуаль', ['летуаль', 'лэтуаль', 'letu.ru', 'letoile']],
    ['Улыбка радуги', ['улыбка радуги', 'r-ulybka']],
    ['Петрович', ['петрович', 'petrovich']],
    ['Лемана ПРО', ['лемана про', 'lemana pro', 'lemanapro']],
    ['Глобус', ['глобус', 'globus.ru']],
    ['Верный', ['верный', 'verno-info']],
    ['Читай-город', ['читай город', 'читай-город', 'chitai-gorod']],
    ['DNS', ['днс', 'dns shop']],
    ['М.Видео', ['мвидео', 'mvideo']],
    ['Эльдорадо', ['eldorado']],
    ['Fix Price', ['фикс прайс', 'фикс-прайс', 'fixprice']],
    ['Четыре Лапы', ['4 лапы', '4lapy']],
    ['O’STIN', ['остин', 'ostin']],
    ['Gloria Jeans', ['глория джинс', 'gloriajeans']],
    ['Яндекс Лавка', ['yandex lavka', 'yandexlavka']],
    ['Самокат', ['samokat']],
    ['Чижик', ['chizhik']],
    ['SPAR', ['спар']],
    ['Золотое Яблоко', ['gold apple']]
  ];
  const FORMATS = new Set(['qr_code', 'ean_13', 'code_128']);
  const formatNames = { qr_code:'QR-код', ean_13:'EAN-13', ean_8:'EAN-8', code_128:'Code 128', code_39:'Code 39', code_93:'Code 93', upc_a:'UPC-A', upc_e:'UPC-E', itf:'ITF', codabar:'Codabar', data_matrix:'Data Matrix', pdf_417:'PDF417', aztec:'Aztec', code_128_image:'Code 128 (оригинал)' };
  let activeScan = null;
  let busy = false;
  let letCameraClickThrough = false;

  function notice(text) {
    const toast = $('#toast');
    if (toast) { toast.textContent = text; toast.classList.add('show'); }
  }
  function normalize(value) {
    return String(value || '').normalize('NFKC').toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  }
  function findBrand(text) {
    const input = ` ${normalize(text)} `;
    if (input.trim().length < 3) return null;
    // The directory is loaded after this script, but is available when the user imports a photo.
    const directory = window.KartochkaDirectory?.stores || [];
    const aliases = [];
    for (const name of directory) aliases.push({ name, term: normalize(name) });
    for (const [name, terms] of catalog) {
      const official = directory.find(candidate => normalize(candidate) === normalize(name)) || name;
      for (const term of terms) aliases.push({ name: official, term: normalize(term) });
    }
    const hits = aliases.filter(({ term }) => term.length > 2 && input.includes(` ${term} `))
      .sort((a, b) => b.term.length - a.term.length);
    if (!hits.length) return null;
    // A photo with several unrelated retailer names must not silently pick one.
    const longest = hits[0].term.length;
    const top = new Set(hits.filter(hit => hit.term.length === longest).map(hit => hit.name));
    return top.size === 1 ? hits[0].name : null;
  }
  function getCards() {
    try { const value = JSON.parse(localStorage.getItem(CARDS_KEY)); return Array.isArray(value) ? value : []; }
    catch { return []; }
  }
  function getMemory() {
    try { const value = JSON.parse(localStorage.getItem(MEMORY_KEY)); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
    catch { return {}; }
  }
  async function fingerprint(value) {
    if (!crypto.subtle || !value) return null;
    const data = new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function knownBrand(code) {
    const card = getCards().find(item => item.number === code);
    if (card) return card.store;
    const key = await fingerprint(code).catch(() => null);
    return key ? getMemory()[key] || null : null;
  }
  async function remember(code, store) {
    const key = await fingerprint(code).catch(() => null);
    if (!key || !store) return;
    const memory = getMemory();
    memory[key] = store.slice(0, 28);
    const keys = Object.keys(memory);
    keys.slice(0, Math.max(0, keys.length - 250)).forEach(old => delete memory[old]);
    try { localStorage.setItem(MEMORY_KEY, JSON.stringify(memory)); } catch {}
  }
  function optionFor(format) {
    const select = $('#cardFormat');
    if (![...select.options].some(item => item.value === format)) {
      const option = document.createElement('option');
      option.value = format;
      option.textContent = formatNames[format] || 'Оригинал кода';
      select.append(option);
    }
    select.value = format;
  }
  function scaledCanvas(image, maxSide = 1900) {
    const width = image.naturalWidth;
    const height = image.naturalHeight;
    const scale = Math.min(1, maxSide / Math.max(width, height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    canvas.getContext('2d', { willReadFrequently: true }).drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  }
  function rotateCanvas(original) {
    const canvas = document.createElement('canvas');
    canvas.width = original.height;
    canvas.height = original.width;
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(original, 0, 0);
    return canvas;
  }
  function boostContrast(original) {
    const canvas = document.createElement('canvas');
    canvas.width = original.width;
    canvas.height = original.height;
    const ctx = canvas.getContext('2d');
    ctx.filter = 'grayscale(1) contrast(1.9)';
    ctx.drawImage(original, 0, 0);
    return canvas;
  }
  function zxingFormat(result) {
    const value = result.getBarcodeFormat();
    const mapping = window.ZXingBrowser?.BarcodeFormat;
    const name = typeof value === 'number' ? mapping?.[value] : String(value);
    return String(name || '').toLowerCase() || 'unknown';
  }
  async function tryDecode(source) {
    if (window.BarcodeDetector?.getSupportedFormats) {
      try {
        const formats = await BarcodeDetector.getSupportedFormats();
        if (formats.length) {
          const hits = await new BarcodeDetector({ formats }).detect(source);
          if (hits.length) {
            const hit = hits[0];
            return { value: hit.rawValue, format: hit.format, source, points: hit.cornerPoints || [] };
          }
        }
      } catch {}
    }
    if (window.ZXingBrowser?.BrowserMultiFormatReader) {
      try {
        const reader = new ZXingBrowser.BrowserMultiFormatReader();
        const hit = reader.decodeFromCanvas(source);
        return { value: hit.getText(), format: zxingFormat(hit), source, points: hit.getResultPoints?.() || [] };
      } catch {}
    }
    return null;
  }
  async function recognizeCode(image) {
    const original = scaledCanvas(image);
    for (const canvas of [original, boostContrast(original), rotateCanvas(original), rotateCanvas(boostContrast(original))]) {
      const decoded = await tryDecode(canvas);
      if (decoded?.value) return decoded;
    }
    return null;
  }
  function cropCode(hit) {
    const canvas = hit.source;
    const points = hit.points.map(point => ({ x: point.getX?.() ?? point.x, y: point.getY?.() ?? point.y }))
      .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y));
    let x = 0, y = 0, width = canvas.width, height = canvas.height;
    if (points.length >= 2) {
      const xs = points.map(point => point.x), ys = points.map(point => point.y);
      const minX = Math.min(...xs), maxX = Math.max(...xs);
      const minY = Math.min(...ys), maxY = Math.max(...ys);
      const padX = Math.max(28, (maxX - minX) * .2);
      const padY = Math.max(50, (maxY - minY) * .8);
      x = Math.max(0, minX - padX); y = Math.max(0, minY - padY);
      width = Math.min(canvas.width - x, maxX - minX + 2 * padX);
      height = Math.min(canvas.height - y, maxY - minY + 2 * padY);
    }
    const result = document.createElement('canvas');
    const factor = Math.min(1, 1050 / Math.max(width, height));
    result.width = Math.max(1, Math.round(width * factor));
    result.height = Math.max(1, Math.round(height * factor));
    result.getContext('2d').drawImage(canvas, x, y, width, height, 0, 0, result.width, result.height);
    return result.toDataURL('image/jpeg', .83);
  }
  function loadScript(url, globalName) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    return new Promise((resolve, reject) => {
      const tag = document.createElement('script');
      tag.src = url;
      tag.onload = () => window[globalName] ? resolve(window[globalName]) : reject(new Error('Library unavailable'));
      tag.onerror = () => reject(new Error('Script unavailable'));
      document.head.append(tag);
    });
  }
  async function ocrText(image) {
    if (window.TextDetector) {
      try { return (await new TextDetector().detect(image)).map(item => item.rawValue).join(' '); } catch {}
    }
    const lib = await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js', 'Tesseract');
    const worker = await lib.createWorker(['rus', 'eng']);
    try { return (await worker.recognize(image)).data.text || ''; }
    finally { await worker.terminate(); }
  }
  function openReview({ code, format, brand, image, warning }) {
    $('#openManual').click();
    $('#manualTitle').textContent = 'Проверьте распознанную карту';
    $('#cardNumber').value = code;
    $('#storeName').value = brand || '';
    optionFor(format);
    $('#cardNumber').inputMode = format === 'qr_code' || !/^\d+$/.test(code) ? 'text' : 'numeric';
    $('#storeName').dispatchEvent(new Event('input', { bubbles: true }));
    const status = $('#recognitionResult');
    status.hidden = false;
    status.classList.toggle('recognized', Boolean(brand));
    status.textContent = `${formatNames[format] || format} распознан. ${brand ? `Магазин: ${brand}; проверьте название.` : 'Выберите магазин — по одному коду бренд не всегда определить.'}${warning ? ` ${warning}` : ''}`;
    activeScan = { code, format, image };
    notice('Код распознан. Проверьте данные перед сохранением.');
  }
  async function scanPhoto(file) {
    if (!file || busy) return;
    busy = true;
    activeScan = null;
    $('#addOverlay').hidden = true;
    notice('Распознаю штрихкод или QR на фото…');
    const url = URL.createObjectURL(file);
    try {
      if (!file.type.startsWith('image/')) throw new Error('Выберите изображение карты.');
      const image = new Image();
      image.src = url;
      await image.decode();
      if (!window.ZXingBrowser && window.kartochkaScannerReady) await window.kartochkaScannerReady;
      const hit = await recognizeCode(image);
      let brand = findBrand(file.name);
      if (hit) brand ||= (await knownBrand(hit.value)) || findBrand(hit.value);
      if (!brand) {
        notice('Считываю название магазина с фотографии…');
        try { brand = findBrand(await ocrText(image)); } catch { /* OCR may be unavailable offline. */ }
      }
      if (!hit) {
        $('#openManual').click();
        if (brand) {
          $('#storeName').value = brand;
          $('#storeName').dispatchEvent(new Event('input', { bubbles: true }));
        }
        $('#manualTitle').textContent = 'Уточните данные карты';
        $('#recognitionResult').hidden = false;
        $('#recognitionResult').textContent = brand
          ? `Возможно, это ${brand}. Код не прочитан — укажите номер вручную или выберите другое фото.`
          : 'Код не прочитан. Попробуйте чёткое фото штрихкода или введите данные вручную.';
        notice('Код не найден — доступен ручной ввод.');
        return;
      }
      if (hit.value.length > 120) throw new Error('Длинный код: сохранение без обрезки пока недоступно.');
      if (hit.format === 'qr_code' && /(?:qr\.nspk\.ru|payment\.)(?:\/|\?|$)/i.test(hit.value)) throw new Error('Это похоже на платёжный QR, а не скидочную карту.');
      let format = String(hit.format || '').toLowerCase();
      if (format === 'pdf417') format = 'pdf_417';
      const mustKeepImage = !FORMATS.has(format) || (format === 'code_128' && /[^\x20-\x7e]/.test(hit.value));
      if (format === 'code_128' && mustKeepImage) format = 'code_128_image';
      if (format === 'ean_13' && !/^\d{13}$/.test(hit.value)) format = 'unknown';
      const codeImage = mustKeepImage || format === 'unknown' ? cropCode(hit) : null;
      const dynamicHint = brand === 'Магнит' && format === 'qr_code'
        ? 'QR в официальном приложении может обновляться: сохранённая копия может перестать работать.' : '';
      openReview({ code: hit.value, format, brand, image: codeImage, warning: dynamicHint });
    } catch (error) {
      $('#openManual').click();
      $('#recognitionResult').hidden = false;
      $('#recognitionResult').textContent = error.message || 'Не удалось распознать фотографию. Введите данные вручную.';
      notice('Не удалось распознать — доступен ручной ввод.');
    } finally {
      busy = false;
      URL.revokeObjectURL(url);
    }
  }
  document.addEventListener('change', event => {
    if (!['galleryInput', 'cameraInput'].includes(event.target?.id)) return;
    event.stopImmediatePropagation();
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) scanPhoto(file);
  }, true);
  document.addEventListener('click', async event => {
    if (event.target?.closest('#scanCamera') && !letCameraClickThrough && !window.ZXingBrowser) {
      event.preventDefault(); event.stopImmediatePropagation();
      notice('Загружаю сканер камеры…');
      if (window.kartochkaScannerReady && await window.kartochkaScannerReady) {
        letCameraClickThrough = true;
        try { $('#scanCamera').click(); } finally { letCameraClickThrough = false; }
      } else { $('#cameraInput').click(); notice('Камера для живого сканирования недоступна. Сделайте фото.'); }
    }
  }, true);
  document.addEventListener('submit', event => {
    if (event.target?.id !== 'cardForm') return;
    const before = getCards().length;
    const number = $('#cardNumber').value.trim();
    const store = $('#storeName').value.trim();
    const scan = activeScan;
    queueMicrotask(async () => {
      const cards = getCards();
      if (cards.length <= before || !number || !store) return;
      const card = cards[cards.length - 1];
      if (card.store !== store) return;
      let patched = false;
      if (scan && scan.code === number) {
        if (card.number !== number) { card.number = number; patched = true; }
        if (card.format !== scan.format) { card.format = scan.format; patched = true; }
        if (scan.image && card.codeImage !== scan.image) { card.codeImage = scan.image; patched = true; }
      }
      if (patched) {
        try {
          const json = JSON.stringify(cards);
          localStorage.setItem(CARDS_KEY, json);
          try { localStorage.setItem('kartochka.cards.recovery.v1', json); } catch (_) {}
          window.KartochkaRecovery?.save?.(cards);
        }
        catch { notice('Не удалось сохранить оригинал: освободите память устройства.'); return; }
      }
      await remember(number, store);
      activeScan = null;
      if (patched) location.reload();
    });
  }, true);
  $('#cardFormat')?.addEventListener('change', () => {
    if (activeScan && $('#cardFormat').value !== activeScan.format) activeScan = null;
  });
  window.KartochkaScanner = { findBrand, zxingFormat, recognizeCode, knownBrand };
})();
