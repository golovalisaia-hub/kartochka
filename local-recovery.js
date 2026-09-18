/* Redundant on-device recovery. Card data never leaves this browser here. */
(() => {
  'use strict';

  const PRIMARY_KEY = 'kartochka.cards.v1';
  const MIRROR_KEY = 'kartochka.cards.recovery.v1';
  const DB_NAME = 'kartochka-recovery-v1';
  const STORE_NAME = 'snapshots';
  const SNAPSHOT_KEY = 'active';

  function parseCards(value) {
    if (typeof value !== 'string') return null;
    try {
      const cards = JSON.parse(value);
      return Array.isArray(cards) ? cards : null;
    } catch (_) {
      return null;
    }
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Cannot open recovery database'));
      request.onblocked = () => reject(new Error('Recovery database is blocked'));
    });
  }

  async function readDatabase() {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readonly');
        const request = transaction.objectStore(STORE_NAME).get(SNAPSHOT_KEY);
        request.onsuccess = () => resolve(parseCards(request.result));
        request.onerror = () => reject(request.error || new Error('Cannot read recovery snapshot'));
      });
    } finally {
      database.close();
    }
  }

  async function writeDatabase(cards) {
    const database = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite');
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error('Cannot write recovery snapshot'));
        transaction.onabort = () => reject(transaction.error || new Error('Recovery write aborted'));
        transaction.objectStore(STORE_NAME).put(JSON.stringify(cards), SNAPSHOT_KEY);
      });
    } finally {
      database.close();
    }
  }

  function save(cards) {
    if (!Array.isArray(cards)) return Promise.resolve(false);
    const json = JSON.stringify(cards);
    try { localStorage.setItem(MIRROR_KEY, json); } catch (_) {}
    return writeDatabase(cards).then(() => true, () => false);
  }

  async function restoreOrMirror() {
    const primary = parseCards(localStorage.getItem(PRIMARY_KEY));
    if (primary) {
      await save(primary);
      return { restored: false, source: 'primary' };
    }

    const mirror = parseCards(localStorage.getItem(MIRROR_KEY));
    if (mirror) {
      localStorage.setItem(PRIMARY_KEY, JSON.stringify(mirror));
      await save(mirror);
      return { restored: true, source: 'mirror' };
    }

    let databaseCards = null;
    try { databaseCards = await readDatabase(); } catch (_) {}
    if (databaseCards) {
      const json = JSON.stringify(databaseCards);
      localStorage.setItem(PRIMARY_KEY, json);
      try { localStorage.setItem(MIRROR_KEY, json); } catch (_) {}
      return { restored: true, source: 'indexeddb' };
    }

    await save([]);
    return { restored: false, source: 'empty' };
  }

  const ready = restoreOrMirror().catch(() => ({ restored: false, source: 'unavailable' }));
  window.KartochkaRecovery = { ready, save };
})();
