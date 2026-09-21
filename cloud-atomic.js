/* Atomic per-card sync adapter. Loads after cloud.js and before app.js.
 * No secret/service-role keys: authenticated requests stay subject to RLS.
 */
(() => {
  'use strict';
  const legacy = window.KartochkaCloud;
  if (!legacy) throw new Error('Load cloud.js before cloud-atomic.js');
  const config = window.KARTOCHKA_CONFIG || {};
  const baseUrl = String(config.supabaseUrl || '').replace(/\/+$/, '');
  const anonKey = String(config.supabaseAnonKey || '');
  const CARDS_KEY = 'kartochka.cards.v1';
  const OWNER_KEY = 'kartochka.cloud-user.v1';
  const BASE_PREFIX = 'kartochka.sync-baseline.v1.';
  const REVISIONS_PREFIX = 'kartochka.server-revisions.v1.';
  const CACHE_PREFIX = 'kartochka.user-cache.v1.';
  const PENDING_PREFIX = 'kartochka.sync-pending.v1.';
  const DELETIONS_PREFIX = 'kartochka.cloud-deletions.v1.';
  const conflict = 'Конфликт изменений: карта изменилась или была удалена на другом устройстве. Ни одна версия не перезаписана. Проверьте карты и сохраните резервную копию.';
  let observed = null;
  const key = (prefix, uid) => prefix + uid;
  function readJson(storageKey, fallback) {
    try { const data = JSON.parse(localStorage.getItem(storageKey)); return data == null ? fallback : data; }
    catch (_) { return fallback; }
  }
  function cards(storageKey = CARDS_KEY) {
    const data = readJson(storageKey, []);
    return Array.isArray(data) ? data : [];
  }
  function record(storageKey) {
    const value = readJson(storageKey, {});
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }
  function markPending(uid) {
    try { localStorage.setItem(key(PENDING_PREFIX, uid), '1'); } catch (_) {}
    queueMicrotask(() => {
      const status = document.querySelector('#syncStatus');
      const label = status?.querySelector('span');
      if (status && label && !status.classList.contains('syncing')) {
        status.classList.remove('online');
        label.textContent = 'Не все изменения сохранены в облаке · нажмите для проверки';
      }
    });
  }
  async function account() {
    const uid = (await legacy.validSession())?.user?.id;
    if (!uid) throw new Error('Сессия истекла. Войдите снова.');
    return uid;
  }
  async function api(path, options = {}) {
    const session = await legacy.validSession();
    if (!session?.access_token) throw new Error('Сессия истекла. Войдите снова.');
    const response = await fetch(baseUrl + path, {
      ...options,
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    if (!response.ok) {
      let payload = {};
      try { payload = await response.json(); } catch (_) {}
      const error = new Error(payload.code === 'P0001' || /SYNC_CONFLICT/.test(String(payload.message || ''))
        ? conflict : payload.message || payload.error || `Ошибка облака (${response.status})`);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
  function telegramAccount() {
    const user = legacy.user?.();
    return Boolean(
      window.KartochkaTelegram?.active?.() &&
      user?.user_metadata?.telegram_id
    );
  }
  const cardTable = () => telegramAccount() ? 'telegram_test_cards' : 'cards';
  const mutationRpc = () => telegramAccount()
    ? 'apply_telegram_test_card_change'
    : 'apply_card_change';
  const getRows = () => api(`/rest/v1/${cardTable()}?select=*&order=last_used.desc`);
  const cardFromRow = row => ({
    id: row.id, store: row.store, number: row.number,
    a: row.color_a, b: row.color_b, text: row.text_color || '#fff',
    lastUsed: Number(row.last_used || 0), format: row.format || 'code_128',
    codeImage: row.code_image || null
  });
  function cardToPayload(card) {
    return {
      store: card.store, number: String(card.number), color_a: card.a,
      color_b: card.b, text_color: card.text || '#fff',
      last_used: Number(card.lastUsed || Date.now()),
      format: card.format || 'code_128', code_image: card.codeImage || null
    };
  }
  async function hash(card) {
    const value = JSON.stringify([
      card.store, String(card.number), card.a, card.b, card.text || '#fff',
      card.format || 'code_128', card.codeImage || null
    ]);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function hashes(items) {
    return Object.fromEntries(await Promise.all(items.map(async card => [card.id, await hash(card)])));
  }
  function rowsById(rows) { return new Map(rows.map(row => [row.id, row])); }
  function revisions(rows) {
    return Object.fromEntries(rows.map(row => [row.id, Number(row.revision || 1)]));
  }
  function pendingDeletions(uid) {
    const ids = readJson(key(DELETIONS_PREFIX, uid), []);
    return new Set(Array.isArray(ids) ? ids : []);
  }
  function saveCache(uid, current) {
    try {
      const text = JSON.stringify(current);
      localStorage.setItem(key(CACHE_PREFIX, uid), text);
      return localStorage.getItem(key(CACHE_PREFIX, uid)) === text;
    } catch (_) { return false; }
  }
  function sameRevisions(a, b) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every(id => a[id] === b[id]);
  }
  async function mutation(id, expected, remove, card = null) {
    return api(`/rest/v1/rpc/${mutationRpc()}`, {
      method: 'POST', body: JSON.stringify({
        p_card_id: id, p_expected_revision: expected,
        p_delete: remove, p_card: card ? cardToPayload(card) : null
      })
    });
  }
  async function listCards() {
    const uid = await account();
    try {
      const previous = localStorage.getItem(OWNER_KEY);
      if (previous && previous !== uid && cards().length) {
        throw new Error('Карты принадлежат другому аккаунту. Сохраните резервную копию перед сменой аккаунта.');
      }
      if (telegramAccount() && !previous && cards().length) {
        throw new Error('Найдены локальные карты без владельца. Сохраните резервную копию и очистите их перед Telegram-тестом.');
      }
      const serverRows = await getRows();
      const server = rowsById(serverRows);
      const local = new Map(cards(key(CACHE_PREFIX, uid)).map(card => [card.id, card]));
      for (const card of cards()) local.set(card.id, card);
      const baseline = record(key(BASE_PREFIX, uid));
      const deletedByUser = pendingDeletions(uid);
      const localHashes = await hashes([...local.values()]);
      const remoteHashes = await hashes(serverRows.filter(row => !row.deleted_at).map(cardFromRow));
      const merged = [];
      for (const id of new Set([...server.keys(), ...local.keys()])) {
        if (deletedByUser.has(id)) continue;
        const localCard = local.get(id);
        const row = server.get(id);
        if (row?.deleted_at) {
          if (localCard && (!baseline[id] || baseline[id] !== localHashes[id])) throw new Error(conflict);
          continue; // Tombstones are authoritative; do not resurrect a stale device cache.
        }
        if (!row) {
          if (!localCard) continue;
          if (baseline[id]) {
            if (baseline[id] !== localHashes[id]) throw new Error(conflict);
            continue; // Removed by an older client without tombstones.
          }
          merged.push(localCard); // Newly created offline card.
          continue;
        }
        const remoteCard = cardFromRow(row);
        if (!localCard) { merged.push(remoteCard); continue; }
        const latest = Math.max(remoteCard.lastUsed, Number(localCard.lastUsed || 0));
        if (localHashes[id] === remoteHashes[id]) {
          merged.push({ ...remoteCard, lastUsed: latest });
          continue;
        }
        if (!baseline[id]) throw new Error(conflict);
        const localEdited = baseline[id] !== localHashes[id];
        const remoteEdited = baseline[id] !== remoteHashes[id];
        if (localEdited && remoteEdited) throw new Error(conflict);
        merged.push({ ...(localEdited ? localCard : remoteCard), lastUsed: latest });
      }
      observed = { uid, revisions: revisions(serverRows) };
      return merged;
    } catch (error) { observed = null; markPending(uid); throw error; }
  }
  async function upsertCards(desired) {
    const uid = await account();
    try {
      if (!observed || observed.uid !== uid) throw new Error('Сначала загрузите актуальные данные из облака.');
      const fresh = await getRows();
      const freshMap = rowsById(fresh);
      if (!sameRevisions(observed.revisions, revisions(fresh))) throw new Error(conflict);
      const freshHashes = await hashes(fresh.filter(row => !row.deleted_at).map(cardFromRow));
      const desiredHashes = await hashes(desired);
      const known = { ...observed.revisions };
      for (const card of desired) {
        const row = freshMap.get(card.id);
        if (row?.deleted_at) throw new Error(conflict);
        if (freshHashes[card.id] === desiredHashes[card.id]) continue;
        const saved = await mutation(card.id, row ? Number(row.revision) : 0, false, card);
        known[card.id] = Number(saved.revision);
      }
      const latest = cards();
      const latestHashes = await hashes(latest);
      const divergent = latest.length !== desired.length || latest.some(card => desiredHashes[card.id] !== latestHashes[card.id]);
      if (!saveCache(uid, divergent ? latest : desired)) {
        throw new Error('Нет места для резервной копии. Локальные карты сохранены, повторите синхронизацию позже.');
      }
      // Save hashes of what actually reached the server, not of a newer local edit.
      localStorage.setItem(key(BASE_PREFIX, uid), JSON.stringify(desiredHashes));
      localStorage.setItem(key(REVISIONS_PREFIX, uid), JSON.stringify(known));
      if (divergent || pendingDeletions(uid).size) {
        markPending(uid);
        if (divergent) setTimeout(() => document.querySelector('#syncNow')?.click(), 1100);
      } else {
        localStorage.removeItem(key(PENDING_PREFIX, uid));
      }
      observed = null;
    } catch (error) {
      saveCache(uid, cards());
      observed = null;
      markPending(uid);
      throw error;
    }
  }
  async function deleteCard(id) {
    const uid = await account();
    try {
      const rows = await getRows();
      const row = rows.find(item => item.id === id);
      if (row && !row.deleted_at) {
        const known = record(key(REVISIONS_PREFIX, uid));
        const baseline = record(key(BASE_PREFIX, uid));
        let expected = Number(known[id] || 0);
        if (!expected && baseline[id] && baseline[id] === await hash(cardFromRow(row))) {
          expected = Number(row.revision);
        }
        if (!expected) throw new Error(conflict);
        const saved = await mutation(id, expected, true);
        known[id] = Number(saved.revision);
        localStorage.setItem(key(REVISIONS_PREFIX, uid), JSON.stringify(known));
      }
      if (!saveCache(uid, cards().filter(card => card.id !== id))) {
        throw new Error('Не удалось обновить резервную копию. Карта на устройстве сохранена.');
      }
    } catch (error) { markPending(uid); throw error; }
  }
  window.KartochkaCloud = { ...legacy, listCards, upsertCards, deleteCard };
})();
