/* Store choices are suggestions, not claims about a chain's barcode format. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const groups = [
    ['Продукты', ['Лента','Магнит','Пятёрочка','Перекрёсток','X5 Клуб','ВкусВилл','Дикси','Ашан','О’КЕЙ','METRO','Глобус','Верный','Мираторг','Fix Price','Чижик','Монетка','Победа','Самокат','Яндекс Лавка','Азбука вкуса','SPAR','Виктория','Бахетле','Мария-Ра','Покупочка']],
    ['Дом и покупки', ['Лемана ПРО','Петрович','DNS','М.Видео','Эльдорадо','Ситилинк','ВсеИнструменты.ру','Галамарт','Порядок','Хофф','Аскона','Золотое Яблоко','Рив Гош','Лэтуаль','Подружка','Улыбка радуги']],
    ['Одежда, спорт, дети и книги', ['Спортмастер','Детский мир','Читай-город','Буквоед','O’STIN','Gloria Jeans','Sela','Zolla','Familia','Леонардо','Четыре Лапы','Бетховен']]
  ];
  const priority = ['Лента','Магнит','Пятёрочка','Перекрёсток'];
  const stores = groups.flatMap(([category, names]) => names.map(name => ({ name, category })));
  const normalize = text => String(text || '').toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[’'`]/g, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  let selected = '';

  function choose(name) {
    const input = $('storeName');
    if (!input) return;
    input.value = name;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    selected = name;
    render();
    $('cardNumber')?.focus();
  }

  function render() {
    const panel = $('storeDirectory');
    if (!panel) return;
    const query = normalize($('storeDirectorySearch')?.value);
    const all = $('storeDirectoryAll')?.checked;
    const list = $('storeDirectoryResults');
    if (!list) return;
    const filtered = stores.filter(store => (!query || normalize(store.name).includes(query)) && (query || all || priority.includes(store.name)));
    list.replaceChildren();
    let lastCategory = '';
    filtered.forEach(store => {
      if ((query || all) && lastCategory !== store.category) {
        lastCategory = store.category;
        const heading = document.createElement('div');
        heading.className = 'directory-heading';
        heading.textContent = store.category;
        list.append(heading);
      }
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'directory-choice';
      button.textContent = store.name;
      button.setAttribute('aria-pressed', String(normalize($('storeName')?.value) === normalize(store.name)));
      button.addEventListener('click', () => choose(store.name));
      list.append(button);
    });
    if (!filtered.length) {
      const empty = document.createElement('p');
      empty.className = 'directory-empty';
      empty.textContent = 'Нет в справочнике? Введите название магазина ниже.';
      list.append(empty);
    }
    const toggle = $('storeDirectoryToggle');
    if (toggle) toggle.textContent = all ? 'Свернуть список' : `Все магазины (${stores.length})`;
  }

  function setupDirectory() {
    const form = $('cardForm');
    const old = $('storePresets');
    if (!form || !old || $('storeDirectory')) return;
    const panel = document.createElement('section');
    panel.id = 'storeDirectory';
    panel.className = 'store-directory';
    panel.setAttribute('aria-label', 'Справочник магазинов');
    const head = document.createElement('div');
    head.className = 'directory-top';
    const label = document.createElement('strong');
    label.textContent = 'Популярные магазины';
    const toggle = document.createElement('button');
    toggle.id = 'storeDirectoryToggle';
    toggle.type = 'button';
    toggle.className = 'directory-toggle';
    toggle.setAttribute('aria-controls', 'storeDirectoryResults');
    toggle.setAttribute('aria-expanded', 'false');
    const expanded = document.createElement('input');
    expanded.id = 'storeDirectoryAll';
    expanded.type = 'checkbox';
    expanded.hidden = true;
    toggle.addEventListener('click', () => {
      expanded.checked = !expanded.checked;
      toggle.setAttribute('aria-expanded', String(expanded.checked));
      search.hidden = !expanded.checked;
      if (!expanded.checked) search.value = '';
      render();
      if (expanded.checked) search.focus();
    });
    head.append(label, toggle);
    const search = document.createElement('input');
    search.id = 'storeDirectorySearch';
    search.type = 'search';
    search.autocomplete = 'off';
    search.placeholder = 'Найти магазин';
    search.setAttribute('aria-label', 'Найти магазин');
    search.hidden = true;
    search.addEventListener('input', render);
    const result = document.createElement('div');
    result.id = 'storeDirectoryResults';
    result.className = 'directory-results';
    panel.append(head, expanded, search, result);
    old.replaceWith(panel);
    $('storeName')?.addEventListener('input', render);
    render();
  }

  function setupEmptyAdd() {
    const empty = $('walletEmpty');
    if (!empty) return;
    empty.setAttribute('role', 'button');
    empty.tabIndex = 0;
    empty.setAttribute('aria-label', 'Добавить первую карту');
    empty.addEventListener('click', () => $('addCardHome')?.click());
    empty.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      $('addCardHome')?.click();
    });
  }

  const style = document.createElement('style');
  style.textContent = `
    [hidden] { display: none !important; }
    #quickAdd { display: none !important; }
    .wallet-empty:not([hidden]) { z-index:5; cursor:pointer; }
    .store-directory { margin: 0 0 16px; }
    .directory-top { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:12px; }
    .directory-top strong { font-size:14px; }
    .directory-toggle { border:0; background:none; color:#d3d3dc; padding:10px 2px; font-size:13px; cursor:pointer; }
    #storeDirectorySearch { width:100%; height:44px; margin:0 0 12px; border:1px solid #45454c; border-radius:13px; padding:0 13px; color:white; background:#242427; font-size:16px; }
    .directory-results { display:flex; flex-wrap:wrap; align-items:center; gap:8px; max-height:210px; overflow:auto; overscroll-behavior:contain; }
    .directory-choice { min-height:42px; padding:8px 12px; border:1px solid #3c3c43; border-radius:13px; background:#252529; color:#eee; font-size:13px; cursor:pointer; }
    .directory-choice[aria-pressed="true"] { border-color:#fff; background:#39393f; }
    .directory-heading { width:100%; padding:10px 0 2px; color:#a9a9b1; font-size:12px; font-weight:750; }
    .directory-empty { margin:0; font-size:13px; color:#aaa; }
  `;
  document.head.append(style);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => { setupDirectory(); setupEmptyAdd(); }, { once:true });
  else { setupDirectory(); setupEmptyAdd(); }
  window.KartochkaDirectory = Object.freeze({ stores: stores.map(store => store.name) });
})();