(() => {
  'use strict';

  const STORAGE_KEY = 'kartochka.cards.v1';
  const RECOVERY_KEY = 'kartochka.cards.recovery.v1';
  const THEME_KEY = 'kartochka.wallet-theme.v1';
  const DEMO_CLEANUP_KEY = 'kartochka.demo-cleanup.v1';
  const CLOUD_USER_KEY = 'kartochka.cloud-user.v1';
  const OPEN_QUEUE_KEY = 'kartochka.card-opens.queue.v1';
  const CLOUD_IDS_PREFIX = 'kartochka.cloud-ids.v1.';
  const CLOUD_DELETIONS_PREFIX = 'kartochka.cloud-deletions.v1.';
  const LEGACY_DEMO_NUMBERS = new Set(['2200000715238','2900635618427','7800037421956','4600001853120']);
  const palettes = [
    { id: 'berry', name: 'Ягодный', a: '#ef4444', b: '#8b1538', text: '#fff' },
    { id: 'green', name: 'Зелёный', a: '#27a857', b: '#075b38', text: '#fff' },
    { id: 'blue', name: 'Синий', a: '#3184f5', b: '#183b93', text: '#fff' },
    { id: 'orange', name: 'Янтарный', a: '#f29b31', b: '#b93b20', text: '#fff' },
    { id: 'violet', name: 'Фиолетовый', a: '#8b5cf6', b: '#482493', text: '#fff' }
  ];
  const storeBrands = [
    { id: 'perekrestok', name: 'Перекрёсток', match: ['перекрёсток','перекресток','perekrestok'], mark: 'П', a: '#31ad5a', b: '#08703b', text: '#fff' },
    { id: 'magnit', name: 'Магнит', match: ['магнит','magnit'], mark: 'М', a: '#f0444d', b: '#aa0832', text: '#fff' },
    { id: 'lenta', name: 'Лента', match: ['лента','lenta'], mark: 'Л', a: '#245bd0', b: '#122d78', text: '#fff' },
    { id: 'pyaterochka', name: 'Пятёрочка', match: ['пятёрочка','пятерочка','pyaterochka','5ka'], mark: '5', a: '#ef4938', b: '#ad1721', text: '#fff' },
    { id: 'x5', name: 'X5 Клуб', match: ['x5 клуб','x5club','x5'], mark: 'X5', a: '#42ac45', b: '#127b54', text: '#fff' },
    { id: 'vkusvill', name: 'ВкусВилл', match: ['вкусвилл','vkusvill'], mark: 'В', a: '#81bd3f', b: '#347327', text: '#fff' },
    { id: 'dixy', name: 'Дикси', match: ['дикси','dixy'], mark: 'Д', a: '#f7941d', b: '#c84518', text: '#fff' }
  ];
  const themes = [
    { id: 'black', name: 'Чёрная кожа', a: '#29292c', b: '#101012', edge: '#3b3b40', thread: 'rgba(255,255,255,.17)' },
    { id: 'brown', name: 'Коньячная', a: '#7c492d', b: '#3b1e12', edge: '#9c6241', thread: 'rgba(255,228,197,.33)' },
    { id: 'graphite', name: 'Графит', a: '#4a4b51', b: '#24252a', edge: '#65666d', thread: 'rgba(255,255,255,.24)' },
    { id: 'navy', name: 'Ночной синий', a: '#243c5a', b: '#101c2c', edge: '#375a81', thread: 'rgba(182,215,255,.27)' },
    { id: 'cream', name: 'Светлая кожа', a: '#d4c2a5', b: '#9f8766', edge: '#e4d6bf', thread: 'rgba(64,42,19,.28)' }
  ];
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const state = {
    cards: [],
    theme: localStorage.getItem(THEME_KEY) || 'black',
    walletOpen: false,
    selectedPalette: palettes[0],
    pendingCodeImage: null,
    pendingFormat: 'code_128',
    activeCardId: null,
    toastTimer: null,
    scannerControls: null,
    scannerBusy: false,
    wakeLock: null,
    user: null,
    cloudTimer: null,
    cloudBusy: false,
    pendingEmail: '',
    mode: 'normal',
    gateReason: '',
    quickReturnView: null
  };

  /*
   * Card open history.
   *
   * The original `lastUsed` field was written both when a card was CREATED and when it was
   * OPENED, so an old value is not proof that the user ever opened that card. Renaming it
   * into open history would invent a history the app never recorded.
   *
   * The migration is therefore additive and lossless:
   *   - `openedAt` (server column `last_opened_at`) counts ONLY real opens and starts empty;
   *   - the old value is preserved as `legacyTouchedAt`, used only as a weak tiebreaker
   *     between cards that have never been opened, and never presented as an open;
   *   - `lastUsed` itself is left untouched so older clients and backups keep working.
   */
  function migrateCards(stored) {
    let changed = false;
    const cards = stored.map(card => {
      if (card && typeof card === 'object' && 'openedAt' in card) return card;
      changed = true;
      return { ...card, openedAt: 0, legacyTouchedAt: Number(card?.lastUsed || 0) };
    });
    return { cards, changed };
  }

  const openedAtOf = card => Number(card?.openedAt || 0);
  const legacyHintOf = card => Number(card?.legacyTouchedAt ?? card?.lastUsed ?? 0);

  function loadCards() {
    try {
      let stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (!Array.isArray(stored)) {
        stored = JSON.parse(localStorage.getItem(RECOVERY_KEY));
        if (!Array.isArray(stored)) {
          localStorage.setItem(DEMO_CLEANUP_KEY, '1');
          return [];
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      }
      if (!localStorage.getItem(DEMO_CLEANUP_KEY)) {
        const cleaned = stored.filter(card => !LEGACY_DEMO_NUMBERS.has(String(card.number)));
        localStorage.setItem(DEMO_CLEANUP_KEY, '1');
        const migratedClean = migrateCards(cleaned).cards;
        persistCards(migratedClean);
        return migratedClean;
      }
      const { cards, changed } = migrateCards(stored);
      if (changed) persistCards(cards);
      return cards;
    } catch (_) {
      return [];
    }
  }

  function persistCards(cards) {
    const json = JSON.stringify(cards);
    localStorage.setItem(STORAGE_KEY, json);
    try { localStorage.setItem(RECOVERY_KEY, json); } catch (_) {}
    window.KartochkaRecovery?.save?.(cards);
  }

  /*
   * Opening a card is history, not an edit. It is queued per account and flushed to the
   * server through a dedicated call that never bumps the card's content revision, so an
   * open on device A reaches device B without creating a false editing conflict. The queue
   * survives reloads, so an offline open is never dropped without the user noticing.
   */
  function openQueueKey() {
    const owner = state.user?.id || localStorage.getItem(CLOUD_USER_KEY) || 'local';
    return `${OPEN_QUEUE_KEY}.${owner}`;
  }

  function readOpenQueue() {
    try {
      const data = JSON.parse(localStorage.getItem(openQueueKey()) || '{}');
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    } catch (_) { return {}; }
  }

  function writeOpenQueue(queue) {
    try { localStorage.setItem(openQueueKey(), JSON.stringify(queue)); } catch (_) {}
  }

  function queueOpen(id, at) {
    const queue = readOpenQueue();
    if (Number(queue[id] || 0) >= at) return;
    queue[id] = at;
    writeOpenQueue(queue);
  }

  /* Opens recorded before the account was known are stored under a neutral key. Once the
     user is signed in they belong to that account, so they are folded in rather than lost. */
  function adoptAnonymousOpens() {
    if (!state.user) return;
    const anonymousKey = `${OPEN_QUEUE_KEY}.local`;
    if (anonymousKey === openQueueKey()) return;
    let pending = {};
    try {
      pending = JSON.parse(localStorage.getItem(anonymousKey) || '{}');
    } catch (_) { pending = {}; }
    const ids = Object.keys(pending || {});
    if (!ids.length) {
      try { localStorage.removeItem(anonymousKey); } catch (_) {}
      return;
    }
    const owned = new Set(state.cards.map(card => card.id));
    const queue = readOpenQueue();
    for (const id of ids) {
      // Only adopt opens for cards this account actually holds.
      if (!owned.has(id)) continue;
      const at = Number(pending[id] || 0);
      if (at > Number(queue[id] || 0)) queue[id] = at;
    }
    writeOpenQueue(queue);
    try { localStorage.removeItem(anonymousKey); } catch (_) {}
  }

  async function flushOpenQueue() {
    adoptAnonymousOpens();
    const queue = readOpenQueue();
    const entries = Object.entries(queue);
    if (!entries.length || !state.user || !window.KartochkaCloud?.recordOpens) return;
    try {
      const accepted = await window.KartochkaCloud.recordOpens(entries.map(([id, at]) => ({ id, at: Number(at) })));
      const remaining = readOpenQueue();
      for (const id of accepted || []) {
        // Only drop entries the server actually stored, and only if no newer open arrived.
        if (Number(remaining[id] || 0) <= Number(queue[id] || 0)) delete remaining[id];
      }
      writeOpenQueue(remaining);
    } catch (_) {
      // Keep the queue: the next successful sync retries it.
    }
  }

  function markOpened(card) {
    const now = Date.now();
    card.openedAt = now;
    persistCards(state.cards);
    queueOpen(card.id, now);
    flushOpenQueue().catch(() => {});
  }

  function saveCards(sync = true) {
    persistCards(state.cards);
    if (sync) queueCloudSync();
  }

  function cloudAvailable() {
    return Boolean(window.KartochkaCloud?.configured?.());
  }

  function telegramMode() {
    return Boolean(window.KartochkaTelegram?.active?.());
  }

  function cloudErrorMessage(error) {
    const value = String(error?.message || error || '');
    if (/invalid login credentials|token has expired|session/i.test(value)) return 'Сессия истекла. Войдите снова.';
    if (/rate limit|over_email_send_rate_limit/i.test(value)) return 'Слишком много запросов. Подождите немного и попробуйте снова.';
    if (/email.*invalid|invalid.*email/i.test(value)) return 'Проверьте адрес электронной почты.';
    if (/token.*invalid|otp.*expired|expired.*token/i.test(value)) return 'Код неверный или уже истёк.';
    if (/failed to fetch|network|load failed/i.test(value)) return 'Нет связи с облаком. Проверьте интернет.';
    return value || 'Не удалось выполнить запрос.';
  }

  function setAuthError(message = '') {
    const element = $('#authError');
    element.textContent = message;
    element.hidden = !message;
  }

  function setButtonBusy(button, busy, busyText) {
    if (!button) return;
    if (!button.dataset.label) button.dataset.label = button.textContent;
    button.disabled = busy;
    button.textContent = busy ? busyText : button.dataset.label;
  }

  function updateCloudUI() {
    const configured = cloudAvailable();
    const signedIn = Boolean(state.user);
    $('#accountButton').classList.toggle('signed-in', signedIn);
    $('#accountButton').setAttribute('aria-label', signedIn ? 'Открыть настройки синхронизации' : 'Войти и включить синхронизацию');
    const status = $('#syncStatus');
    status.classList.toggle('online', signedIn);
    status.classList.toggle('syncing', state.cloudBusy);
    status.querySelector('span').textContent = state.cloudBusy
      ? 'Синхронизация…'
      : signedIn
        ? `Сохранено в облаке · ${telegramMode() ? window.KartochkaTelegram.displayName() : (state.user.email || 'аккаунт')}`
        : configured
          ? 'Войдите, чтобы сохранять карты в облаке'
          : 'Карты хранятся только на этом устройстве';
  }

  function showAuthStep(step) {
    const configured = cloudAvailable();
    const telegram = telegramMode();
    $('#authUnavailable').hidden = configured;
    $('#telegramAuthPanel').hidden = !configured || !telegram || step === 'account';
    $('#emailForm').hidden = !configured || telegram || step !== 'email';
    $('#codeForm').hidden = !configured || telegram || step !== 'code';
    $('#accountPanel').hidden = !configured || step !== 'account';
    if (step === 'account' && state.user) {
      $('#accountEmail').textContent = telegram
        ? window.KartochkaTelegram.displayName()
        : (state.user.email || 'Аккаунт');
      $('#accountSyncText').textContent = state.cloudBusy ? 'Синхронизация…' : 'Карты синхронизированы с облаком';
    }
  }

  function openAccount() {
    setAuthError();
    showAuthStep(state.user ? 'account' : 'email');
    showOverlay('#authOverlay');
    if (!state.user && cloudAvailable() && !telegramMode()) setTimeout(() => $('#authEmail').focus(), 200);
  }

  function queueCloudSync() {
    if (!state.user || !cloudAvailable()) return;
    clearTimeout(state.cloudTimer);
    try { localStorage.setItem('kartochka.sync-pending.v1.' + state.user.id, '1'); } catch (_) {}
    state.cloudTimer = setTimeout(() => {
      if (state.cloudBusy) queueCloudSync();
      else syncWithCloud({ quiet: true });
    }, 450);
  }

  function readStringList(key) {
    try {
      const value = JSON.parse(localStorage.getItem(key));
      return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
    } catch (_) {
      return [];
    }
  }

  function cloudIdsKey(userId = state.user?.id) {
    return `${CLOUD_IDS_PREFIX}${userId || ''}`;
  }

  function cloudDeletionsKey(userId = state.user?.id) {
    return `${CLOUD_DELETIONS_PREFIX}${userId || ''}`;
  }

  function rememberCloudDeletion(id) {
    if (!state.user) return;
    const key = cloudDeletionsKey();
    const ids = new Set(readStringList(key));
    ids.add(id);
    localStorage.setItem(key, JSON.stringify([...ids]));
  }

  function mergeCards(localCards, cloudCards) {
    const merged = new Map();
    localCards.forEach(card => merged.set(card.id, card));
    cloudCards.forEach(card => {
      const local = merged.get(card.id);
      if (!local || Number(card.lastUsed || 0) >= Number(local.lastUsed || 0)) merged.set(card.id, card);
    });
    return [...merged.values()];
  }

  function cardContentSignature(cards) {
    return JSON.stringify(cards.map(card => [
      card.id, card.store, String(card.number), card.a, card.b,
      card.text || '#fff', card.format || 'code_128', card.codeImage || null
    ]));
  }

  async function syncWithCloud({ quiet = false, initial = false } = {}) {
    if (!state.user || !cloudAvailable() || state.cloudBusy) return;
    state.cloudBusy = true;
    updateCloudUI();
    showAuthStep('account');
    try {
      // Compare CONTENT only. Opening a card during a sync changes open history, and that
      // must not abort the upload of a genuine edit — an open is not an edit.
      const walletBeforeSync = cardContentSignature(state.cards);
      const deletionKey = cloudDeletionsKey();
      const pendingDeletions = readStringList(deletionKey);
      for (const id of pendingDeletions) await window.KartochkaCloud.deleteCard(id);
      if (pendingDeletions.length) localStorage.removeItem(deletionKey);

      // listCards reconciles remote tombstones, cached cards and offline edits.
      // Never union local cards again: that would resurrect a deleted card.
      const reconciled = await window.KartochkaCloud.listCards();
      if (cardContentSignature(state.cards) !== walletBeforeSync) {
        throw new Error('Карты изменились во время синхронизации. Повторите попытку.');
      }
      persistCards(reconciled);
      state.cards = reconciled;
      await window.KartochkaCloud.upsertCards(reconciled);
      localStorage.setItem(CLOUD_USER_KEY, state.user.id);
      localStorage.setItem(cloudIdsKey(), JSON.stringify(state.cards.map(card => card.id)));
      renderStack();
      renderQuick();
      renderGrid($('#cardSearch').value);
      if (!quiet) toast('Карты синхронизированы');
    } catch (error) {
      if (!quiet) toast(cloudErrorMessage(error));
    } finally {
      state.cloudBusy = false;
      updateCloudUI();
      showAuthStep(state.user ? 'account' : 'email');
    }
  }

  async function initializeCloud() {
    updateCloudUI();
    if (!cloudAvailable()) {
      revealAfterAuth();
      return;
    }
    try {
      await window.KartochkaTelegram?.ready;
      if (telegramMode()) await window.KartochkaTelegram.authenticate();
      const session = await window.KartochkaCloud.validSession();
      state.user = session?.user || null;
      if (telegramMode() && !state.user) throw new Error('Сессия истекла. Войдите снова.');
      if (!state.user && localStorage.getItem(CLOUD_USER_KEY)) {
        state.cards = [];
        saveCards(false);
        localStorage.removeItem(CLOUD_USER_KEY);
        renderStack();
        renderQuick();
        renderGrid();
      }
      revealAfterAuth();
      updateCloudUI();
      if (state.user) {
        await syncWithCloud({ quiet: true });
        await flushOpenQueue();
      }
    } catch (error) {
      state.user = null;
      updateCloudUI();
      if (telegramMode()) {
        // No verified session means no cards: leave the neutral gate up rather than falling
        // back to whatever happens to sit in this device's localStorage.
        state.cards = [];
        renderStack();
        renderQuick();
        renderGrid();
        showPrivacyGate(cloudErrorMessage(error), true);
        setAuthError(cloudErrorMessage(error));
        showAuthStep('email');
        return;
      }
      revealAfterAuth();
    }
  }

  /*
   * Decides whether the cards sitting in this device's localStorage may be shown to the
   * account that just signed in.
   *
   * CLOUD_USER_KEY records who this device's wallet last belonged to. Inside Telegram a
   * wallet with a different owner — or with no recorded owner at all, which cannot be
   * attributed to anybody — stays hidden until the cloud sync resolves it. Nothing is
   * deleted: the data stays on disk and its real owner still gets it back on their next
   * sign-in, and the backup tools still see it.
   */
  function localCardsBelongToCurrentUser() {
    const owner = localStorage.getItem(CLOUD_USER_KEY);
    if (!state.user) return !telegramMode();
    if (owner) return owner === state.user.id;
    return !telegramMode();
  }

  /* Only now may local cards be read and painted: the account is settled. */
  function revealAfterAuth() {
    if (!state.cards.length && localCardsBelongToCurrentUser()) {
      state.cards = loadCards();
      renderStack();
      renderQuick();
      renderGrid();
    }
    hidePrivacyGate();
    syncBackButton();
  }

  async function submitEmail(event) {
    event.preventDefault();
    setAuthError();
    const email = $('#authEmail').value.trim().toLocaleLowerCase('en');
    const button = $('#sendCodeButton');
    setButtonBusy(button, true, 'Отправляем…');
    try {
      await window.KartochkaCloud.sendCode(email);
      state.pendingEmail = email;
      $('#sentEmail').textContent = email;
      showAuthStep('code');
      $('#authCode').value = '';
      setTimeout(() => $('#authCode').focus(), 100);
    } catch (error) {
      setAuthError(cloudErrorMessage(error));
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function submitCode(event) {
    event.preventDefault();
    setAuthError();
    const token = $('#authCode').value.replace(/\D/g, '');
    const button = $('#verifyCodeButton');
    setButtonBusy(button, true, 'Проверяем…');
    try {
      state.user = await window.KartochkaCloud.verifyCode(state.pendingEmail, token);
      updateCloudUI();
      showAuthStep('account');
      await syncWithCloud({ initial: true });
      toast('Вход выполнен');
    } catch (error) {
      setAuthError(cloudErrorMessage(error));
    } finally {
      setButtonBusy(button, false);
    }
  }

  async function signOut() {
    try {
      // cloud.js first stores a verified recovery copy. If it cannot, stay signed in.
      await window.KartochkaCloud.signOut();
      state.user = null;
      state.cards = [];
      saveCards(false);
      localStorage.removeItem(CLOUD_USER_KEY);
      renderStack();
      renderQuick();
      renderGrid();
      updateCloudUI();
      showAuthStep('email');
      toast('Вы вышли из аккаунта');
    } catch (error) {
      const message = cloudErrorMessage(error);
      setAuthError(message);
      toast(message);
    }
  }

  function initials(name) {
    return (name.trim()[0] || 'К').toUpperCase();
  }

  function lastDigits(number) {
    const value = String(number || '');
    return `•••• ${value.slice(-4).padStart(4, '0')}`;
  }

  function brandForStore(name) {
    const normalized = String(name || '').trim().toLocaleLowerCase('ru');
    return storeBrands.find(brand => brand.match.some(value => normalized === value || normalized.startsWith(`${value} `))) || null;
  }

  function makeCardFace(card, className, index = 0) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.style.setProperty('--card-a', card.a);
    button.style.setProperty('--card-b', card.b);
    button.style.setProperty('--card-text', card.text || '#fff');
    const storeBrand = brandForStore(card.store);
    button.dataset.brand = storeBrand?.id || 'custom';
    button.dataset.brandMark = storeBrand?.mark || initials(card.store);
    if (className === 'stack-card') {
      button.style.setProperty('--i', index);
      button.style.zIndex = String(3 - index);
    }
    button.setAttribute('aria-label', `Открыть карту ${card.store}`);

    const brand = document.createElement('span');
    brand.className = 'card-brand';
    const monogram = document.createElement('span');
    monogram.className = 'card-monogram';
    monogram.textContent = storeBrand?.mark || initials(card.store);
    brand.append(monogram);
    if (className === 'stack-card') {
      const chip = document.createElement('span');
      chip.className = 'card-chip';
      brand.append(chip);
    }
    const title = document.createElement('strong');
    title.textContent = card.store;
    const digits = document.createElement('small');
    digits.textContent = lastDigits(card.number);
    button.append(brand, title, digits);
    button.addEventListener('click', event => {
      event.stopPropagation();
      openCard(card.id);
    });
    return button;
  }

  function sortedCards() {
    // 1. Cards with a confirmed open, newest first.
    // 2. Cards that were never opened, after them.
    // 3. Equal timestamps fall back to a stable order so the list never reshuffles itself.
    return [...state.cards].sort((a, b) => {
      const openedA = openedAtOf(a);
      const openedB = openedAtOf(b);
      if (openedA !== openedB) return openedB - openedA;
      if (openedA === 0) {
        const hint = legacyHintOf(b) - legacyHintOf(a);
        if (hint) return hint;
      }
      return String(a.id).localeCompare(String(b.id));
    });
  }

  function openedCards() {
    return sortedCards().filter(card => openedAtOf(card) > 0);
  }

  function renderStack() {
    const stack = $('#recentStack');
    stack.replaceChildren();
    const recent = sortedCards().slice(0, 3);
    recent.forEach((card, index) => stack.append(makeCardFace(card, 'stack-card', index)));
    $('#walletEmpty').hidden = state.cards.length !== 0;
    stack.hidden = state.cards.length === 0;
    $('#cardCountTop').textContent = String(state.cards.length);
    $('#openAllTop').hidden = state.cards.length === 0;
    $('#showAllHome').hidden = state.cards.length === 0;
    $('#walletActions').classList.toggle('single', state.cards.length === 0);
    const extra = Math.max(0, state.cards.length - 3);
    $('#showAllLabel').textContent = !state.cards.length ? 'Все карты' : extra ? `Ещё ${extra}` : `Все ${state.cards.length}`;
  }

  function renderGrid(filter = '') {
    const grid = $('#cardsGrid');
    grid.replaceChildren();
    const query = filter.trim().toLocaleLowerCase('ru');
    const cards = sortedCards().filter(card => card.store.toLocaleLowerCase('ru').includes(query));
    cards.forEach(card => grid.append(makeCardFace(card, 'grid-card')));
    $('#noResults').hidden = cards.length !== 0;
  }

  function renderPalettes() {
    const palette = $('#cardPalette');
    palette.replaceChildren();
    palettes.forEach(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `color-choice${state.selectedPalette.id === item.id ? ' active' : ''}`;
      button.style.setProperty('--color-a', item.a);
      button.style.setProperty('--color-b', item.b);
      button.setAttribute('aria-label', item.name);
      button.addEventListener('click', () => {
        state.selectedPalette = item;
        renderPalettes();
      });
      palette.append(button);
    });
  }

  function renderStorePresets() {
    const list = $('#storePresets');
    if (!list) return;
    const selected = brandForStore($('#storeName').value);
    list.replaceChildren();
    storeBrands.forEach(brand => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `store-preset${selected?.id === brand.id ? ' active' : ''}`;
      button.style.setProperty('--preset-a', brand.a);
      button.style.setProperty('--preset-b', brand.b);
      button.textContent = brand.name;
      button.addEventListener('click', () => {
        $('#storeName').value = brand.name;
        state.selectedPalette = brand;
        $('#recognitionResult').hidden = true;
        renderStorePresets();
        renderPalettes();
        $('#cardNumber').focus();
      });
      list.append(button);
    });
  }

  function renderThemes() {
    const list = $('#themeList');
    list.replaceChildren();
    themes.forEach(theme => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `theme-option${state.theme === theme.id ? ' active' : ''}`;
      button.style.setProperty('--swatch-a', theme.a);
      button.style.setProperty('--swatch-b', theme.b);
      const swatch = document.createElement('span');
      swatch.className = 'theme-swatch';
      const title = document.createElement('strong');
      title.textContent = theme.name;
      const check = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
      use.setAttribute('href', '#i-check');
      check.append(use);
      button.append(swatch, title, check);
      button.addEventListener('click', () => applyTheme(theme.id));
      list.append(button);
    });
  }

  function applyTheme(themeId) {
    const theme = themes.find(item => item.id === themeId) || themes[0];
    state.theme = theme.id;
    localStorage.setItem(THEME_KEY, theme.id);
    const root = document.documentElement.style;
    root.setProperty('--wallet-a', theme.a);
    root.setProperty('--wallet-b', theme.b);
    root.setProperty('--wallet-edge', theme.edge);
    root.setProperty('--wallet-thread', theme.thread);
    renderThemes();
  }

  /* ---------------------------------------------------------------------
   * Compact quick-access screen (startapp=quick).
   * A separate screen with its own markup, not a squeezed wallet: no bottom
   * navigation, no catalog, no design tab, no Premium.
   * ------------------------------------------------------------------- */
  function renderQuick() {
    const list = $('#quickList');
    if (!list) return;
    const empty = $('#quickEmpty');
    const allButton = $('#quickAllCards');
    const recent = openedCards().slice(0, 3);
    list.replaceChildren();
    list.hidden = recent.length === 0;
    empty.hidden = recent.length > 0;

    if (!recent.length) {
      const noCards = state.cards.length === 0;
      $('#quickEmptyTitle').textContent = noCards ? 'Здесь появятся ваши карты' : 'Пока нет открытых карт';
      $('#quickEmptyText').textContent = noCards
        ? 'Добавьте первую карту — дальше она будет открываться одним нажатием.'
        : 'Выберите карту из списка — в следующий раз она будет здесь первой.';
      allButton.textContent = noCards ? 'Добавить первую карту' : 'Все карты';
      allButton.dataset.action = noCards ? 'add' : 'all';
      return;
    }

    allButton.textContent = 'Все карты';
    allButton.dataset.action = 'all';
    recent.forEach((card, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = index === 0 ? 'quick-card primary' : 'quick-card';
      button.setAttribute('role', 'listitem');
      button.style.setProperty('--card-a', card.a);
      button.style.setProperty('--card-b', card.b);
      button.style.setProperty('--card-text', card.text || '#fff');
      const brand = brandForStore(card.store);
      const logo = document.createElement('span');
      logo.className = 'quick-card-logo';
      logo.textContent = brand?.mark || initials(card.store);
      const body = document.createElement('span');
      body.className = 'quick-card-body';
      const store = document.createElement('strong');
      store.className = 'quick-card-store';
      store.textContent = card.store;
      const digits = document.createElement('small');
      digits.className = 'quick-card-digits';
      // Only the tail of the number: the full number never appears on the quick screen.
      digits.textContent = lastDigits(card.number);
      body.append(store, digits);
      const arrow = document.createElement('span');
      arrow.className = 'quick-card-arrow';
      arrow.textContent = '\u203a';
      button.append(logo, body, arrow);
      button.setAttribute('aria-label', `Показать код: ${card.store}`);
      button.addEventListener('click', () => openCard(card.id));
      list.append(button);
    });
  }

  /* The code sheet needs more height than a compact launch provides. This runs inside the
     same tap that opened the card, so no extra button appears. Telegram documents no way
     back to compact height, so nothing here promises one. */
  function requestRoomForCode() {
    const telegram = window.KartochkaTelegram;
    if (!telegram?.active?.() || telegram.isExpanded?.()) return;
    const stable = Number(telegram.viewport?.().stableHeight || 0);
    if (stable && stable >= 520) return; // Already tall enough for a scannable code.
    telegram.expand('card-opened');
  }

  function enterQuickMode() {
    state.mode = 'quick';
    document.body.classList.add('quick-mode');
    $('#quickScreen').hidden = false;
    renderQuick();
  }

  function leaveQuickMode(target = 'all') {
    // A deliberate user action, so asking Telegram for the full sheet is allowed here.
    window.KartochkaTelegram?.expand?.('open-full-wallet');
    state.quickReturnView = 'quick';
    document.body.classList.remove('quick-mode');
    $('#quickScreen').hidden = true;
    showView(target);
    syncBackButton();
  }

  function returnToQuickScreen() {
    if (state.mode !== 'quick') return false;
    state.quickReturnView = null;
    document.body.classList.add('quick-mode');
    $('#quickScreen').hidden = false;
    renderQuick();
    syncBackButton();
    return true;
  }

  /* Telegram's BackButton handler is registered once inside KartochkaTelegram; here we only
     swap which action it performs and whether it is visible. */
  function syncBackButton() {
    const telegram = window.KartochkaTelegram;
    if (!telegram?.active?.()) return;
    const codeOpen = !$('#cardOverlay').hidden;
    if (codeOpen) {
      telegram.backButton.show(() => $('#closeCard').click());
      return;
    }
    if (state.mode === 'quick' && state.quickReturnView === 'quick') {
      telegram.backButton.show(() => returnToQuickScreen());
      return;
    }
    telegram.backButton.hide();
  }

  /* ---------------------------------------------------------------------
   * Neutral boot gate. Inside Telegram no private card is painted until the
   * server has verified initData and returned a session for THIS account.
   * ------------------------------------------------------------------- */
  function showPrivacyGate(message = 'Проверяем вход…', retry = false) {
    const gate = $('#privacyGate');
    if (!gate) return;
    gate.hidden = false;
    $('#privacyGateText').textContent = message;
    $('#privacyGateRetry').hidden = !retry;
  }

  function hidePrivacyGate() {
    const gate = $('#privacyGate');
    if (gate) gate.hidden = true;
  }

  function showView(name) {
    $$('.view').forEach(view => view.classList.toggle('active', view.id === `${name}View`));
    $$('.nav-item').forEach(item => item.classList.toggle('active', item.dataset.view === name));
    if (name === 'all') renderGrid($('#cardSearch').value);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function toggleWallet() {
    state.walletOpen = !state.walletOpen;
    $('#walletStage').classList.toggle('open', state.walletOpen);
    $('#walletBody').setAttribute('aria-expanded', String(state.walletOpen));
  }

  function showOverlay(id) {
    $(id).hidden = false;
    document.body.style.overflow = 'hidden';
  }

  function hideOverlay(id) {
    $(id).hidden = true;
    if ($$('.overlay:not([hidden])').length === 0) document.body.style.overflow = '';
  }

  function openAdd() {
    state.pendingCodeImage = null;
    state.pendingFormat = 'code_128';
    showOverlay('#addOverlay');
  }

  function openManual(fromScan = false) {
    hideOverlay('#addOverlay');
    if (!fromScan) {
      $('#cardForm').reset();
      state.pendingCodeImage = null;
      state.pendingFormat = 'code_128';
      state.selectedPalette = palettes[0];
      $('#cardFormat').value = 'auto';
      $('#recognitionResult').hidden = true;
      $('#manualTitle').textContent = 'Данные карты';
    }
    renderPalettes();
    renderStorePresets();
    showOverlay('#manualOverlay');
    setTimeout(() => ($('#storeName').value ? $('#cardNumber') : $('#storeName')).focus(), 250);
  }

  function toast(message) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => element.classList.remove('show'), 2600);
  }

  function formatFromZXing(result) {
    const name = window.ZXingBrowser?.BarcodeFormat?.[result.getBarcodeFormat?.()];
    return String(name || 'CODE_128').toLocaleLowerCase('en');
  }

  function canRegenerate(format) {
    return ['qr_code', 'ean_13', 'code_128'].includes(format);
  }

  function brandFromText(value) {
    const normalized = String(value || '').toLocaleLowerCase('ru').replace(/ё/g, 'е');
    return storeBrands.find(brand => brand.match.some(term => normalized.includes(term.replace(/ё/g, 'е')))) || null;
  }

  function rgbToHsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let hue = 0;
    if (delta) {
      if (max === r) hue = 60 * (((g - b) / delta) % 6);
      else if (max === g) hue = 60 * ((b - r) / delta + 2);
      else hue = 60 * ((r - g) / delta + 4);
    }
    if (hue < 0) hue += 360;
    return { hue, saturation: max ? delta / max : 0, value: max };
  }

  function guessBrandFromColors(canvas) {
    const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = { red: 0, orange: 0, yellow: 0, lime: 0, green: 0, blue: 0 };
    let colorful = 0;
    for (let index = 0; index < data.length; index += 16) {
      const { hue, saturation, value } = rgbToHsv(data[index], data[index + 1], data[index + 2]);
      if (saturation < .38 || value < .28 || value > .98) continue;
      colorful++;
      if (hue < 16 || hue > 344) colors.red++;
      else if (hue < 43) colors.orange++;
      else if (hue < 70) colors.yellow++;
      else if (hue < 106) colors.lime++;
      else if (hue < 166) colors.green++;
      else if (hue > 190 && hue < 256) colors.blue++;
    }
    if (colorful < 90) return null;
    Object.keys(colors).forEach(key => { colors[key] /= colorful; });
    const byId = id => storeBrands.find(brand => brand.id === id);
    if (colors.blue > .42 && colors.yellow > .025) return byId('lenta');
    if (colors.orange > .42) return byId('dixy');
    if (colors.red > .27 && colors.green + colors.lime > .11) return byId('pyaterochka');
    if (colors.red > .52) return byId('magnit');
    if (colors.green > .31 && colors.yellow > .1) return byId('x5');
    if (colors.lime > .5 && colors.green < .28) return byId('vkusvill');
    if (colors.green > .5) return byId('perekrestok');
    return null;
  }

  async function detectStoreFromImage(source, filename = '') {
    const fromName = brandFromText(filename);
    if (fromName) return fromName;
    const width = source.videoWidth || source.naturalWidth || source.width || 0;
    const height = source.videoHeight || source.naturalHeight || source.height || 0;
    if (!width || !height) return null;
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 72;
    canvas.getContext('2d').drawImage(source, 0, 0, width, height, 0, 0, canvas.width, canvas.height);
    if ('TextDetector' in window) {
      try {
        const blocks = await new TextDetector().detect(canvas);
        const fromText = brandFromText(blocks.map(block => block.rawValue || '').join(' '));
        if (fromText) return fromText;
      } catch (_) {}
    }
    return guessBrandFromColors(canvas);
  }

  function prepareScannedCard(number, format, codeImage = null, detectedBrand = null) {
    $('#cardForm').reset();
    $('#cardNumber').value = number || '';
    state.pendingFormat = format || 'code_128';
    state.pendingCodeImage = codeImage;
    state.selectedPalette = detectedBrand || palettes[0];
    $('#storeName').value = detectedBrand?.name || '';
    $('#cardFormat').value = canRegenerate(state.pendingFormat) ? state.pendingFormat : 'auto';
    $('#cardNumber').inputMode = state.pendingFormat === 'qr_code' ? 'text' : 'numeric';
    $('#manualTitle').textContent = 'Проверьте карту';
    const result = $('#recognitionResult');
    result.hidden = false;
    result.classList.toggle('recognized', Boolean(detectedBrand));
    result.textContent = detectedBrand
      ? `Похоже, это ${detectedBrand.name}. Проверьте и сохраните.`
      : 'Код найден, но магазин не распознан. Выберите его ниже.';
    openManual(true);
    toast(detectedBrand ? `${detectedBrand.name} распознан` : 'Код найден — выберите магазин');
  }

  function captureCodeImage(source, points = []) {
    const width = source.videoWidth || source.width || 0;
    const height = source.videoHeight || source.height || 0;
    if (!width || !height) return null;
    const xs = points.map(point => point.getX?.() ?? point.x).filter(Number.isFinite);
    const ys = points.map(point => point.getY?.() ?? point.y).filter(Number.isFinite);
    const defaultBox = { x: width * .08, y: height * .28, width: width * .84, height: height * .38 };
    const box = xs.length > 1 && ys.length > 1 ? {
      x: Math.min(...xs), y: Math.min(...ys),
      width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
      height: Math.max(1, Math.max(...ys) - Math.min(...ys))
    } : defaultBox;
    const padding = Math.max(22, Math.min(width, height) * .05);
    const sx = Math.max(0, box.x - padding);
    const sy = Math.max(0, box.y - padding);
    const sw = Math.min(width - sx, box.width + padding * 2);
    const sh = Math.min(height - sy, box.height + padding * 2);
    const scale = Math.min(1, 900 / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    canvas.getContext('2d').drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', .9);
  }

  async function startLiveScanner() {
    hideOverlay('#addOverlay');
    showOverlay('#scannerOverlay');
    $('#scannerStatus').textContent = 'Запрашиваем доступ к камере…';
    state.scannerBusy = false;
    if (!window.ZXingBrowser || !navigator.mediaDevices?.getUserMedia) {
      $('#scannerStatus').textContent = 'Живая камера недоступна — сделайте фотографию';
      return;
    }
    try {
      const reader = new ZXingBrowser.BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 180 });
      state.scannerControls = await reader.decodeFromConstraints(
        { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
        $('#scannerVideo'),
        async (result, _error, controls) => {
          if (!result || state.scannerBusy) return;
          state.scannerBusy = true;
          const format = formatFromZXing(result);
          const video = $('#scannerVideo');
          const detectedBrand = await detectStoreFromImage(video);
          const image = canRegenerate(format) ? null : captureCodeImage(video, result.getResultPoints?.() || []);
          controls.stop();
          stopLiveScanner();
          prepareScannedCard(result.getText(), format, image, detectedBrand);
        }
      );
      $('#scannerStatus').textContent = 'Держите код внутри рамки';
    } catch (_) {
      $('#scannerStatus').textContent = 'Не удалось открыть камеру — сделайте фотографию';
    }
  }

  function stopLiveScanner(hide = true) {
    try { state.scannerControls?.stop(); } catch (_) {}
    state.scannerControls = null;
    state.scannerBusy = false;
    const video = $('#scannerVideo');
    video.srcObject?.getTracks?.().forEach(track => track.stop());
    video.pause?.();
    if (hide) {
      $('#scannerOverlay').hidden = true;
      if ($$('.overlay:not([hidden])').length === 0) document.body.style.overflow = '';
    }
  }

  async function scanFile(file) {
    if (!file) return;
    hideOverlay('#addOverlay');
    toast('Ищу код на изображении…');
    if (!window.ZXingBrowser) {
      openManual();
      toast('Сканер недоступен — введите номер вручную');
      return;
    }
    const url = URL.createObjectURL(file);
    try {
      const image = new Image();
      image.src = url;
      await image.decode();
      const reader = new ZXingBrowser.BrowserMultiFormatReader();
      const result = await reader.decodeFromImageElement(image);
      const format = formatFromZXing(result);
      const detectedBrand = await detectStoreFromImage(image, file.name);
      let codeImage = null;
      if (!canRegenerate(format)) {
        const bitmap = await createImageBitmap(file);
        codeImage = captureCodeImage(bitmap, result.getResultPoints?.() || []);
        bitmap.close?.();
      }
      prepareScannedCard(result.getText(), format, codeImage, detectedBrand);
    } catch (_) {
      openManual();
      toast('Код не найден — попробуйте другое фото');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function isValidEAN13(value) {
    if (!/^\d{13}$/.test(value)) return false;
    const digits = [...value].map(Number);
    const sum = digits.slice(0, 12).reduce((total, digit, index) => total + digit * (index % 2 === 0 ? 1 : 3), 0);
    return (10 - (sum % 10)) % 10 === digits[12];
  }

  function resolveCardFormat(selected, value) {
    if (selected !== 'auto') return selected;
    if (state.pendingFormat && state.pendingFormat !== 'code_128') return state.pendingFormat;
    return isValidEAN13(value.replace(/\s+/g, '')) ? 'ean_13' : 'code_128';
  }

  function requestPersistentStorage() {
    if (!navigator.storage?.persist || localStorage.getItem('kartochka.persist-requested')) return;
    localStorage.setItem('kartochka.persist-requested', '1');
    navigator.storage.persist().catch(() => false);
  }

  function addCard(event) {
    event.preventDefault();
    const store = $('#storeName').value.trim();
    const rawNumber = $('#cardNumber').value.trim();
    const format = resolveCardFormat($('#cardFormat').value, rawNumber);
    const number = format === 'qr_code' ? rawNumber : rawNumber.replace(/\s+/g, '');
    if (!store || !number) return;
    if (format === 'ean_13' && !isValidEAN13(number)) {
      toast('Для EAN-13 нужно 13 цифр с правильной контрольной цифрой');
      return;
    }
    const palette = state.selectedPalette;
    state.cards.push({
      id: crypto.randomUUID(), store, number,
      a: palette.a, b: palette.b, text: palette.text,
      lastUsed: Date.now(), openedAt: 0, legacyTouchedAt: Date.now(), format,
      codeImage: state.pendingCodeImage || null
    });
    try {
      saveCards();
    } catch (_) {
      state.cards.pop();
      toast('Не удалось сохранить изображение. Попробуйте номер карты.');
      return;
    }
    hideOverlay('#manualOverlay');
    renderStack();
    renderQuick();
    renderGrid();
    showView('wallet');
    state.walletOpen = true;
    $('#walletStage').classList.add('open');
    $('#walletBody').setAttribute('aria-expanded', 'true');
    requestPersistentStorage();
    toast('Карта добавлена');
  }

  function openCard(id) {
    const card = state.cards.find(item => item.id === id);
    if (!card) return;
    // A real open, recorded separately from creation and editing.
    markOpened(card);
    state.activeCardId = id;
    renderStack();
    renderQuick();
    renderQuick();
    renderGrid($('#cardSearch').value);
    // Still inside the user's tap: if the compact sheet is too short for a readable code,
    // ask Telegram for more room now rather than making the user press a second button.
    if (state.mode === 'quick') requestRoomForCode();
    $('#detailCard').style.setProperty('--card-a', card.a);
    $('#detailCard').style.setProperty('--card-b', card.b);
    $('#detailCard').style.setProperty('--card-text', card.text || '#fff');
    const storeBrand = brandForStore(card.store);
    $('#detailCard').dataset.brand = storeBrand?.id || 'custom';
    $('#detailCard').dataset.brandMark = storeBrand?.mark || initials(card.store);
    $('#detailLogo').textContent = storeBrand?.mark || initials(card.store);
    $('#detailStore').textContent = card.store;
    $('#detailDigits').textContent = lastDigits(card.number);
    $('#barcodeNumber').textContent = card.format === 'qr_code' ? 'QR-код' : card.number;
    const mount = $('#barcodeMount');
    mount.replaceChildren();
    try {
      if (card.format === 'qr_code' && window.ZXingBrowser) {
        mount.append(makeQRCode(card.number));
      } else if (card.format === 'ean_13' && isValidEAN13(card.number)) {
        mount.append(makeEAN13(card.number));
      } else if (card.format === 'code_128' || !card.codeImage) {
        mount.append(makeCode128(card.number));
      } else {
        const image = new Image();
        image.src = card.codeImage;
        image.alt = `Код карты ${card.store}`;
        mount.append(image);
      }
    } catch (_) {
      const error = document.createElement('p');
      error.className = 'barcode-error';
      error.textContent = 'Не удалось построить код. Проверьте данные карты.';
      mount.append(error);
    }
    showOverlay('#cardOverlay');
    syncBackButton();
    requestScreenWakeLock();
  }

  async function requestScreenWakeLock() {
    const status = $('#awakeStatus');
    if (!navigator.wakeLock?.request) {
      status.textContent = 'Для быстрого сканирования экран остаётся светлым';
      return;
    }
    try {
      state.wakeLock = await navigator.wakeLock.request('screen');
      status.textContent = 'Экран не погаснет, пока открыт код';
      state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    } catch (_) {
      status.textContent = 'Для быстрого сканирования экран остаётся светлым';
    }
  }

  function releaseScreenWakeLock() {
    if (state.wakeLock) state.wakeLock.release().catch(() => {});
    state.wakeLock = null;
  }

  function deleteActiveCard() {
    const card = state.cards.find(item => item.id === state.activeCardId);
    if (!card) return;
    $('#deleteConfirmText').textContent = state.user
      ? `Карта «${card.store}» будет удалена с этого устройства и из облака.`
      : `Карта «${card.store}» будет удалена с этого устройства.`;
    showOverlay('#deleteConfirmOverlay');
  }

  function confirmDeleteActiveCard() {
    const card = state.cards.find(item => item.id === state.activeCardId);
    if (!card) {
      hideOverlay('#deleteConfirmOverlay');
      return;
    }
    const remainingCards = state.cards.filter(item => item.id !== state.activeCardId);
    const hasCloud = Boolean(state.user && cloudAvailable());
    const deletionKey = hasCloud ? cloudDeletionsKey() : '';
    const previousQueue = hasCloud ? localStorage.getItem(deletionKey) : null;
    try {
      // Queue the tombstone before changing the active wallet; roll it back on failure.
      if (hasCloud) rememberCloudDeletion(card.id);
      persistCards(remainingCards);
    } catch (_) {
      if (hasCloud) {
        try {
          if (previousQueue === null) localStorage.removeItem(deletionKey);
          else localStorage.setItem(deletionKey, previousQueue);
        } catch (_) {}
      }
      hideOverlay('#deleteConfirmOverlay');
      toast('Не удалось безопасно удалить карту. Проверьте доступ к хранилищу.');
      return;
    }
    state.cards = remainingCards;
    if (hasCloud) queueCloudSync();
    releaseScreenWakeLock();
    hideOverlay('#deleteConfirmOverlay');
    hideOverlay('#cardOverlay');
    renderStack();
    renderQuick();
    renderGrid($('#cardSearch').value);
    toast('Карта удалена');
  }

  const code128Patterns = [
    '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212',
    '112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131',
    '311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321',
    '112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121',
    '313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
    '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114',
    '122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212',
    '124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113',
    '114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','2331112'
  ];

  function makeQRCode(raw) {
    const writer = new ZXingBrowser.BrowserQRCodeSvgWriter();
    const svg = writer.write(String(raw), 280, 280);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'QR-код карты');
    return svg;
  }

  function makeEAN13(raw) {
    const value = String(raw);
    const left = ['0001101','0011001','0010011','0111101','0100011','0110001','0101111','0111011','0110111','0001011'];
    const odd = ['0100111','0110011','0011011','0100001','0011101','0111001','0000101','0010001','0001001','0010111'];
    const right = ['1110010','1100110','1101100','1000010','1011100','1001110','1010000','1000100','1001000','1110100'];
    const parity = ['LLLLLL','LLGLGG','LLGGLG','LLGGGL','LGLLGG','LGGLLG','LGGGLL','LGLGLG','LGLGGL','LGGLGL'];
    let bits = '101';
    const layout = parity[Number(value[0])];
    for (let index = 1; index <= 6; index++) bits += layout[index - 1] === 'L' ? left[Number(value[index])] : odd[Number(value[index])];
    bits += '01010';
    for (let index = 7; index <= 12; index++) bits += right[Number(value[index])];
    bits += '101';
    const quiet = 12;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${bits.length + quiet * 2} 90`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Штрихкод EAN-13 ${value}`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    [...bits].forEach((bit, index) => {
      if (bit !== '1') return;
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', String(index + quiet));
      rect.setAttribute('y', '0');
      rect.setAttribute('width', '1');
      rect.setAttribute('height', '90');
      rect.setAttribute('fill', '#000');
      svg.append(rect);
    });
    return svg;
  }

  function makeCode128(raw) {
    const value = String(raw || '').replace(/[^\x20-\x7e]/g, '?');
    const codes = [...value].map(char => char.charCodeAt(0) - 32);
    let checksum = 104;
    codes.forEach((code, index) => { checksum += code * (index + 1); });
    const sequence = [104, ...codes, checksum % 103, 106];
    const quiet = 12;
    const modules = sequence.reduce((sum, code) => sum + [...code128Patterns[code]].reduce((a, n) => a + Number(n), 0), quiet * 2);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${modules} 90`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `Штрихкод ${value}`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    let x = quiet;
    sequence.forEach(code => {
      [...code128Patterns[code]].forEach((widthText, index) => {
        const width = Number(widthText);
        if (index % 2 === 0) {
          const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          rect.setAttribute('x', String(x));
          rect.setAttribute('y', '0');
          rect.setAttribute('width', String(width));
          rect.setAttribute('height', '90');
          rect.setAttribute('fill', '#000');
          svg.append(rect);
        }
        x += width;
      });
    });
    return svg;
  }

  const QUICK_LINK = 'https://t.me/KartochkaWalletBot?startapp=quick&mode=compact';

  function bindQuickEvents() {
    $('#quickAllCards').addEventListener('click', event => {
      if (event.currentTarget.dataset.action === 'add') {
        leaveQuickMode('wallet');
        openAdd();
        return;
      }
      leaveQuickMode('all');
    });
    $('#privacyGateRetry').addEventListener('click', () => {
      showPrivacyGate('Проверяем вход…');
      initializeCloud();
    });
    $('#openQuickAccess').addEventListener('click', () => showView('quickAccess'));
    $('#quickAccessUrl').textContent = QUICK_LINK;
    $('#copyQuickLink').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(QUICK_LINK);
        toast('Ссылка скопирована');
      } catch (_) {
        // Clipboard access is refused in some in-app browsers; select the text instead of lying.
        const range = document.createRange();
        range.selectNodeContents($('#quickAccessUrl'));
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        toast('Скопируйте выделенную ссылку вручную');
      }
    });
    $('#testQuickLink').addEventListener('click', () => {
      const status = $('#quickLinkStatus');
      status.hidden = false;
      // Opening the link from inside Telegram just reloads this Mini App, which proves nothing.
      status.textContent = window.KartochkaTelegram?.active?.()
        ? 'Вы уже внутри Telegram. Проверьте ссылку из браузера или другого чата — так виден реальный запуск.'
        : 'Открываем ссылку в Telegram. Если приложение не откроется, проверьте, что бот настроен как Main Mini App.';
      if (!window.KartochkaTelegram?.active?.()) window.open(QUICK_LINK, '_blank', 'noopener');
    });
  }

  function bindEvents() {
    bindQuickEvents();
    $('#walletBody').addEventListener('click', toggleWallet);
    ['#quickAdd','#addCardHome','#addCardAll'].forEach(id => $(id).addEventListener('click', openAdd));
    ['#openAllTop','#showAllHome'].forEach(id => $(id).addEventListener('click', () => showView('all')));
    $$('.nav-item').forEach(item => item.addEventListener('click', () => showView(item.dataset.view)));
    $$('[data-go]').forEach(item => item.addEventListener('click', () => showView(item.dataset.go)));
    $$('[data-close="add"]').forEach(item => item.addEventListener('click', () => hideOverlay('#addOverlay')));
    $$('[data-close="manual"]').forEach(item => item.addEventListener('click', () => hideOverlay('#manualOverlay')));
    $('#openManual').addEventListener('click', () => openManual());
    $('#backToMethods').addEventListener('click', () => { hideOverlay('#manualOverlay'); showOverlay('#addOverlay'); });
    $('#scanCamera').addEventListener('click', startLiveScanner);
    $('#scanGallery').addEventListener('click', () => $('#galleryInput').click());
    $('#closeScanner').addEventListener('click', () => stopLiveScanner());
    $('#scannerFallback').addEventListener('click', () => { stopLiveScanner(); $('#cameraInput').click(); });
    $('#scannerManual').addEventListener('click', () => { stopLiveScanner(); openManual(); });
    $('#cameraInput').addEventListener('change', event => scanFile(event.target.files[0]).finally(() => { event.target.value = ''; }));
    $('#galleryInput').addEventListener('change', event => scanFile(event.target.files[0]).finally(() => { event.target.value = ''; }));
    $('#cardForm').addEventListener('submit', addCard);
    $('#storeName').addEventListener('input', event => {
      const brand = brandForStore(event.target.value);
      if (brand) state.selectedPalette = brand;
      if (event.isTrusted) $('#recognitionResult').hidden = true;
      renderStorePresets();
      renderPalettes();
    });
    $('#cardFormat').addEventListener('change', event => {
      $('#cardNumber').inputMode = event.target.value === 'qr_code' ? 'text' : 'numeric';
    });
    $('#cardSearch').addEventListener('input', event => renderGrid(event.target.value));
    $('#closeCard').addEventListener('click', () => { releaseScreenWakeLock(); hideOverlay('#cardOverlay'); syncBackButton(); });
    $('#deleteCard').addEventListener('click', deleteActiveCard);
    $('#cancelDelete').addEventListener('click', () => hideOverlay('#deleteConfirmOverlay'));
    $('#confirmDelete').addEventListener('click', confirmDeleteActiveCard);
    $('#accountButton').addEventListener('click', openAccount);
    $('#syncStatus').addEventListener('click', openAccount);
    $$('[data-close="auth"]').forEach(item => item.addEventListener('click', () => hideOverlay('#authOverlay')));
    $('#emailForm').addEventListener('submit', submitEmail);
    $('#codeForm').addEventListener('submit', submitCode);
    $('#changeEmail').addEventListener('click', () => { setAuthError(); showAuthStep('email'); $('#authEmail').focus(); });
    $('#syncNow').addEventListener('click', () => syncWithCloud());
    $('#signOut').addEventListener('click', signOut);
    $$('.overlay').forEach(overlay => overlay.addEventListener('click', event => {
      if (event.target === overlay && !['cardOverlay','scannerOverlay'].includes(overlay.id)) hideOverlay(`#${overlay.id}`);
    }));
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      const open = $$('.overlay:not([hidden])').at(-1);
      if (!open) return;
      if (open.id === 'scannerOverlay') stopLiveScanner();
      else if (open.id === 'cardOverlay') { releaseScreenWakeLock(); hideOverlay('#cardOverlay'); syncBackButton(); }
      else hideOverlay(`#${open.id}`);
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && !$('#cardOverlay').hidden && !state.wakeLock) requestScreenWakeLock();
    });
  }

  function registerWebMCP() {
    const context = document.modelContext;
    if (!context?.registerTool) return;
    const register = tool => {
      try { Promise.resolve(context.registerTool(tool)).catch(() => {}); } catch (_) {}
    };
    register({
      name: 'list_loyalty_cards',
      title: 'Показать карты',
      description: 'Возвращает сохранённые на устройстве скидочные карты в порядке недавнего использования.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute() {
        return { cards: sortedCards().map(card => ({ id: card.id, store: card.store, lastFour: String(card.number).slice(-4) })) };
      }
    });
    register({
      name: 'open_loyalty_card',
      title: 'Открыть карту',
      description: 'Открывает сохранённую скидочную карту по её идентификатору и показывает код для кассира.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string', minLength: 1 } },
        required: ['id'], additionalProperties: false
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute(input) {
        if (!input || typeof input.id !== 'string') throw new Error('Укажите идентификатор карты.');
        const card = state.cards.find(item => item.id === input.id);
        if (!card) throw new Error('Карта не найдена.');
        openCard(card.id);
        return { opened: true, id: card.id, store: card.store };
      }
    });
    register({
      name: 'create_loyalty_card',
      title: 'Добавить карту',
      description: 'Сохраняет новую скидочную карту на этом устройстве по названию магазина и номеру штрихкода.',
      inputSchema: {
        type: 'object',
        properties: {
          store: { type: 'string', minLength: 1, maxLength: 28 },
          number: { type: 'string', minLength: 3, maxLength: 120 },
          color: { type: 'string', enum: palettes.map(item => item.id) },
          format: { type: 'string', enum: ['code_128','ean_13','qr_code'] }
        },
        required: ['store', 'number'], additionalProperties: false
      },
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute(input) {
        const store = typeof input?.store === 'string' ? input.store.trim() : '';
        const rawNumber = typeof input?.number === 'string' ? input.number.trim() : '';
        const format = input.format || (isValidEAN13(rawNumber.replace(/\s+/g, '')) ? 'ean_13' : 'code_128');
        const number = format === 'qr_code' ? rawNumber : rawNumber.replace(/\s+/g, '');
        if (!store || store.length > 28 || number.length < 3 || number.length > 120) throw new Error('Проверьте название магазина и номер карты.');
        const palette = palettes.find(item => item.id === input.color) || brandForStore(store) || palettes[0];
        if (format === 'ean_13' && !isValidEAN13(number)) throw new Error('Некорректный номер EAN-13.');
        const card = { id: crypto.randomUUID(), store, number, a: palette.a, b: palette.b, text: palette.text, lastUsed: Date.now(), openedAt: 0, legacyTouchedAt: Date.now(), format, codeImage: null };
        state.cards.push(card);
        saveCards();
        requestPersistentStorage();
        renderStack(); renderQuick(); renderGrid($('#cardSearch').value); showView('wallet');
        return { created: true, id: card.id, store: card.store };
      }
    });
  }

  async function init() {
    await window.KartochkaRecovery?.ready;
    applyTheme(state.theme);
    renderPalettes();
    renderStorePresets();
    bindEvents();
    registerWebMCP();

    // Decide the Telegram situation BEFORE any private card touches the DOM. Inside Telegram
    // the identity of the account is not known until the server has verified initData, and a
    // second Telegram account on the same phone must not see the first account's wallet —
    // not even for one frame.
    //
    // `likely()` answers synchronously from the launch parameters, so an ordinary web page
    // renders immediately and never waits on an SDK that has nothing to tell it.
    const telegram = window.KartochkaTelegram;
    const likelyTelegram = telegram?.likely?.() ?? false;
    if (likelyTelegram) {
      showPrivacyGate('Проверяем вход…');
    } else {
      state.cards = loadCards();
      renderStack();
      renderQuick();
      renderGrid();
    }

    const inTelegram = await (telegram?.ready ?? Promise.resolve(false));
    if (inTelegram) {
      // Retract anything rendered eagerly: inside Telegram the account is not settled yet.
      state.cards = [];
      renderStack();
      renderQuick();
      renderGrid();
      showPrivacyGate('Проверяем вход…');
      if (telegram.mode() === 'quick') enterQuickMode();
      // Telegram may now paint: the first screen is the neutral gate, never someone's cards.
      telegram.signalReady();
      telegram.onViewportChange(() => renderQuick());
    } else {
      if (likelyTelegram) {
        // Looked like a Telegram launch but no signed initData arrived; fall back to the
        // ordinary offline wallet rather than hanging on the gate.
        state.cards = loadCards();
        renderStack();
        renderQuick();
        renderGrid();
        hidePrivacyGate();
      }
      // Outside Telegram ?startapp=quick still selects the compact screen, which makes the
      // layout testable in an ordinary browser.
      if (telegram?.startParam?.() === 'quick') enterQuickMode();
    }

    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
    await initializeCloud();
  }

  init();
})();
