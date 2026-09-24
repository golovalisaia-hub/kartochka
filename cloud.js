(() => {
  'use strict';

  const SESSION_KEY = 'kartochka.supabase-session.v1';
  const CARDS_KEY = 'kartochka.cards.v1';
  const RECOVERY_KEY = 'kartochka.cards.recovery.v1';
  const CLOUD_USER_KEY = 'kartochka.cloud-user.v1';
  const USER_CACHE_PREFIX = 'kartochka.user-cache.v1.';
  const BASELINE_PREFIX = 'kartochka.sync-baseline.v1.';
  const PENDING_PREFIX = 'kartochka.sync-pending.v1.';
  const config = window.KARTOCHKA_CONFIG || {};
  const baseUrl = String(config.supabaseUrl || '').replace(/\/+$/, '');
  const anonKey = String(config.supabaseAnonKey || '').trim();
  let lastObserved = null;

  function configured() {
    return /^(https:\/\/.+\.supabase\.co|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/i.test(baseUrl) && anonKey.length > 20;
  }

  function readSession() {
    try {
      const value = JSON.parse(localStorage.getItem(SESSION_KEY));
      return value?.access_token ? value : null;
    } catch (_) { return null; }
  }

  function storeSession(value) {
    if (value?.access_token) {
      if (!value.expires_at && value.expires_in) value.expires_at = Math.floor(Date.now() / 1000) + Number(value.expires_in);
      localStorage.setItem(SESSION_KEY, JSON.stringify(value));
    } else localStorage.removeItem(SESSION_KEY);
  }

  function readCards(key = CARDS_KEY) {
    try {
      const value = JSON.parse(localStorage.getItem(key) || '[]');
      return Array.isArray(value) ? value : [];
    } catch (_) { return []; }
  }

  const cacheKey = userId => `${USER_CACHE_PREFIX}${userId}`;
  const baselineKey = userId => `${BASELINE_PREFIX}${userId}`;
  const pendingKey = userId => `${PENDING_PREFIX}${userId}`;

  // Never clear the active wallet if its recovery copy cannot be written.
  function cacheCards(userId, cards = readCards()) {
    if (!userId || !Array.isArray(cards)) return false;
    try {
      const json = JSON.stringify(cards);
      localStorage.setItem(cacheKey(userId), json);
      return localStorage.getItem(cacheKey(userId)) === json;
    } catch (_) { return false; }
  }
  const cachedCards = userId => userId ? readCards(cacheKey(userId)) : [];

  function syncStatusGuard() {
    const id = readSession()?.user?.id || localStorage.getItem(CLOUD_USER_KEY);
    const pending = id && localStorage.getItem(pendingKey(id)) === '1';
    if (!pending) return;
    const status = document.querySelector('#syncStatus');
    const label = status?.querySelector('span');
    if (status && label && !status.classList.contains('syncing')) {
      status.classList.remove('online');
      const text = 'Не все изменения сохранены в облаке · нажмите для проверки';
      if (label.textContent !== text) label.textContent = text;
    }
    const account = document.querySelector('#accountSyncText');
    if (account && account.textContent !== 'Есть несохранённые изменения. Нажмите «Синхронизировать».') {
      account.textContent = 'Есть несохранённые изменения. Нажмите «Синхронизировать».';
    }
  }
  function markSyncIssue() {
    const id = readSession()?.user?.id || localStorage.getItem(CLOUD_USER_KEY);
    if (id) {
      try { localStorage.setItem(pendingKey(id), '1'); } catch (_) {}
    }
    setTimeout(syncStatusGuard, 0);
  }
  function clearSyncIssue(userId) {
    try { localStorage.removeItem(pendingKey(userId)); } catch (_) {}
  }
  function installStatusGuard() {
    const status = document.querySelector('#syncStatus');
    if (!status) return;
    const observer = new MutationObserver(syncStatusGuard);
    observer.observe(status, { childList: true, subtree: true, characterData: true });
    const account = document.querySelector('#accountSyncText');
    if (account) observer.observe(account, { childList: true, subtree: true, characterData: true });
    syncStatusGuard();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installStatusGuard, { once: true });
  else installStatusGuard();

  async function request(path, options = {}, authenticated = false) {
    if (!configured()) throw new Error('Облачное хранилище не настроено.');
    const headers = { apikey: anonKey, 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (authenticated) {
      const session = await validSession();
      if (!session) throw new Error('Сессия истекла. Войдите снова.');
      headers.Authorization = `Bearer ${session.access_token}`;
    }
    const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
    if (!response.ok) {
      let message = '';
      try {
        const body = await response.json();
        message = body.msg || body.message || body.error_description || body.error || '';
      } catch (_) {}
      const error = new Error(message || `Ошибка облака (${response.status})`);
      error.status = response.status;
      throw error;
    }
    if (response.status === 204 || response.headers.get('content-length') === '0') return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async function validSession() {
    const session = readSession();
    if (!session) return null;
    const expiresAt = Number(session.expires_at || 0);
    if (!expiresAt || expiresAt * 1000 > Date.now() + 60_000 || !session.refresh_token) return session;
    try {
      const refreshed = await request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST', body: JSON.stringify({ refresh_token: session.refresh_token })
      });
      storeSession(refreshed);
      return refreshed;
    } catch (error) {
      if (!error?.status || error.status >= 500 || error.status === 429) {
        markSyncIssue();
        return session;
      }
      if (!cacheCards(session.user?.id)) {
        markSyncIssue();
        return session; // Recovery copy failed: retain the wallet and identity instead of deleting cards.
      }
      try {
        localStorage.setItem(CARDS_KEY, '[]');
        localStorage.setItem(RECOVERY_KEY, '[]');
        window.KartochkaRecovery?.save?.([]);
      } catch (_) {}
      storeSession(null);
      return null;
    }
  }

  function user() { return readSession()?.user || null; }
  async function sendCode(email) {
    await request('/auth/v1/otp', { method: 'POST', body: JSON.stringify({ email, create_user: true }) });
  }
  async function verifyCode(email, token) {
    const session = await request('/auth/v1/verify', {
      method: 'POST', body: JSON.stringify({ email, token, type: 'email' })
    });
    storeSession(session);
    lastObserved = null;
    return session.user;
  }
  async function loginWithTelegram(initData) {
    if (typeof initData !== 'string' || !initData) throw new Error('Telegram не передал данные авторизации.');
    const result = await request('/functions/v1/telegram', {
      method: 'POST',
      body: JSON.stringify({ action: 'login', initData })
    });
    // The Edge Function normally returns a complete server-created session. Keep the
    // token-hash branch for a rolling deploy where an older function may answer briefly.
    let session = result?.access_token ? result : null;
    if (!session && result?.token_hash) {
      session = await request('/auth/v1/verify', {
        method: 'POST',
        body: JSON.stringify({ token_hash: result.token_hash, type: result.type || 'magiclink' })
      });
    }
    if (!session?.access_token || !session?.user?.id) {
      throw new Error('Telegram-вход не подтверждён сервером.');
    }
    storeSession(session);
    lastObserved = null;
    return session.user;
  }
  async function signOut() {
    const session = readSession();
    if (session?.user?.id && !cacheCards(session.user.id)) {
      markSyncIssue();
      throw new Error('Не удалось сохранить резервную копию карт. Выход отменён.');
    }
    if (session?.access_token) {
      try {
        await request('/auth/v1/logout', { method: 'POST', headers: { Authorization: `Bearer ${session.access_token}` } });
      } catch (_) {}
    }
    storeSession(null);
    lastObserved = null;
  }

  function toRow(card, userId) {
    return {
      user_id: userId, id: card.id, store: card.store, number: String(card.number),
      color_a: card.a, color_b: card.b, text_color: card.text || '#fff',
      last_used: Number(card.lastUsed || Date.now()), format: card.format || 'code_128',
      code_image: card.codeImage || null, updated_at: new Date().toISOString()
      // last_opened_at is intentionally absent: only recordOpens writes open history.
    };
  }
  function fromRow(row) {
    return {
      id: row.id, store: row.store, number: row.number, a: row.color_a, b: row.color_b,
      text: row.text_color || '#fff', lastUsed: Number(row.last_used || 0),
      openedAt: Number(row.last_opened_at || 0),
      format: row.format || 'code_128', codeImage: row.code_image || null
    };
  }

  // Opening a card changes lastUsed, but not its contents. Do not treat lastUsed as an edit revision.
  async function signature(card) {
    const content = JSON.stringify([
      card.store, String(card.number), card.a, card.b, card.text || '#fff',
      card.format || 'code_128', card.codeImage || null
    ]);
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function signatures(cards) {
    const entries = await Promise.all(cards.map(async card => [card.id, await signature(card)]));
    return Object.fromEntries(entries);
  }
  function baseline(userId) {
    try {
      const data = JSON.parse(localStorage.getItem(baselineKey(userId)) || '{}');
      return data && !Array.isArray(data) && typeof data === 'object' ? data : {};
    } catch (_) { return {}; }
  }
  const conflictMessage = 'Конфликт изменений: одна карта изменена на другом устройстве. Обе версии сохранены отдельно. Скачайте резервную копию и проверьте карту перед повторной синхронизацией.';

  async function listCards() {
    const session = await validSession();
    const userId = session?.user?.id;
    if (!userId) throw new Error('Сессия истекла. Войдите снова.');
    try {
      const previousUser = localStorage.getItem(CLOUD_USER_KEY);
      if (previousUser && previousUser !== userId && readCards().length) {
        throw new Error('Обнаружены карты другого аккаунта. Выйдите и сохраните отдельную резервную копию.');
      }
      const rows = await request('/rest/v1/cards?select=*&order=last_used.desc', { method: 'GET' }, true);
      const remote = (rows || []).map(fromRow);
      const local = new Map(cachedCards(userId).map(card => [card.id, card]));
      for (const card of readCards()) local.set(card.id, card);
      const cloud = new Map(remote.map(card => [card.id, card]));
      const base = baseline(userId);
      const localHashes = await signatures([...local.values()]);
      const remoteHashes = await signatures(remote);
      const result = [];
      for (const id of new Set([...cloud.keys(), ...local.keys()])) {
        const onDevice = local.get(id);
        const onServer = cloud.get(id);
        if (!onServer) {
          if (!onDevice) continue;
          if (base[id]) {
            if (base[id] !== localHashes[id]) throw new Error(conflictMessage);
            continue; // Deleted on the other device; this copy was not modified.
          }
          result.push(onDevice); // New offline card.
          continue;
        }
        if (!onDevice) { result.push(onServer); continue; }
        if (remoteHashes[id] === localHashes[id]) {
          result.push({
            ...onServer,
            lastUsed: Math.max(onServer.lastUsed, onDevice.lastUsed),
            openedAt: Math.max(Number(onServer.openedAt || 0), Number(onDevice.openedAt || 0))
          });
          continue;
        }
        if (!base[id]) throw new Error(conflictMessage);
        const localEdited = localHashes[id] !== base[id];
        const remoteEdited = remoteHashes[id] !== base[id];
        if (localEdited && remoteEdited) throw new Error(conflictMessage);
        const winner = localEdited ? onDevice : onServer;
        result.push({
          ...winner,
          lastUsed: Math.max(onDevice.lastUsed, onServer.lastUsed) + 1,
          openedAt: Math.max(Number(onDevice.openedAt || 0), Number(onServer.openedAt || 0))
        });
      }
      lastObserved = { userId, hashes: remoteHashes };
      return result;
    } catch (error) { markSyncIssue(); throw error; }
  }

  async function upsertCards(cards) {
    const session = await validSession();
    const userId = session?.user?.id;
    if (!userId) throw new Error('Сессия истекла. Войдите снова.');
    try {
      if (!lastObserved || lastObserved.userId !== userId) throw new Error('Сначала загрузите актуальные данные из облака.');
      // A second read catches changes between the initial download and upload.
      const freshRows = await request('/rest/v1/cards?select=*&order=last_used.desc', { method: 'GET' }, true);
      const fresh = (freshRows || []).map(fromRow);
      const freshHashes = await signatures(fresh);
      const observed = lastObserved.hashes;
      if (new Set([...Object.keys(freshHashes), ...Object.keys(observed)]).size !== Object.keys(observed).length ||
          Object.keys(observed).some(id => observed[id] !== freshHashes[id])) throw new Error(conflictMessage);
      const hashes = await signatures(cards);
      const changed = cards.filter(card => freshHashes[card.id] !== hashes[card.id]);
      if (changed.length) {
        await request('/rest/v1/cards?on_conflict=user_id,id', {
          method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify(changed.map(card => toRow(card, userId)))
        }, true);
      }
      const latest = readCards();
      const latestHashes = await signatures(latest);
      const diverged = latest.length !== cards.length || latest.some(card => latestHashes[card.id] !== hashes[card.id]);
      if (!cacheCards(userId, diverged ? latest : cards)) throw new Error('Нет места для резервной копии. Карты на устройстве сохранены.');
      if (diverged) {
        markSyncIssue();
        // Another edit happened during upload. Never claim that newer local changes were synced.
        setTimeout(() => document.querySelector('#syncNow')?.click(), 1100);
      } else {
        localStorage.setItem(baselineKey(userId), JSON.stringify(hashes));
        clearSyncIssue(userId);
      }
      lastObserved = null;
    } catch (error) {
      const latest = readCards();
      cacheCards(userId, latest.length ? latest : cards);
      markSyncIssue();
      lastObserved = null;
      throw error;
    }
  }

  async function deleteCard(id) {
    const session = await validSession();
    const userId = session?.user?.id;
    if (!userId) throw new Error('Сессия истекла. Войдите снова.');
    try {
      await request(`/rest/v1/cards?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE', headers: { Prefer: 'return=minimal' }
      }, true);
      if (!cacheCards(userId, cachedCards(userId).filter(card => card.id !== id))) {
        throw new Error('Карта удалена в облаке, но не удалось обновить резервную копию.');
      }
      // Do not clear the pending badge here: other card edits may still need an upload.
    } catch (error) { markSyncIssue(); throw error; }
  }

  window.KartochkaCloud = {
    configured, user, validSession, sendCode, verifyCode, loginWithTelegram, signOut,
    listCards, upsertCards, deleteCard
  };
})();
