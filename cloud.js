(() => {
  'use strict';

  const SESSION_KEY = 'kartochka.supabase-session.v1';
  const config = window.KARTOCHKA_CONFIG || {};
  const baseUrl = String(config.supabaseUrl || '').replace(/\/+$/, '');
  const anonKey = String(config.supabaseAnonKey || '').trim();

  function configured() {
    return /^(https:\/\/.+\.supabase\.co|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)$/i.test(baseUrl) && anonKey.length > 20;
  }

  function readSession() {
    try {
      const value = JSON.parse(localStorage.getItem(SESSION_KEY));
      return value?.access_token ? value : null;
    } catch (_) {
      return null;
    }
  }

  function storeSession(value) {
    if (value?.access_token) {
      if (!value.expires_at && value.expires_in) value.expires_at = Math.floor(Date.now() / 1000) + Number(value.expires_in);
      localStorage.setItem(SESSION_KEY, JSON.stringify(value));
    }
    else localStorage.removeItem(SESSION_KEY);
  }

  async function request(path, options = {}, authenticated = false) {
    if (!configured()) throw new Error('Облачное хранилище не настроено.');
    const headers = {
      apikey: anonKey,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    };
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
      throw new Error(message || `Ошибка облака (${response.status})`);
    }
    if (response.status === 204 || response.headers.get('content-length') === '0') return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }

  async function validSession() {
    const session = readSession();
    if (!session) return null;
    const expiresAt = Number(session.expires_at || 0);
    if (!expiresAt || expiresAt * 1000 > Date.now() + 60_000) return session;
    if (!session.refresh_token) {
      storeSession(null);
      return null;
    }
    try {
      const refreshed = await request('/auth/v1/token?grant_type=refresh_token', {
        method: 'POST',
        body: JSON.stringify({ refresh_token: session.refresh_token })
      });
      storeSession(refreshed);
      return refreshed;
    } catch (_) {
      storeSession(null);
      return null;
    }
  }

  function user() {
    return readSession()?.user || null;
  }

  async function sendCode(email) {
    await request('/auth/v1/otp', {
      method: 'POST',
      body: JSON.stringify({ email, create_user: true })
    });
  }

  async function verifyCode(email, token) {
    const session = await request('/auth/v1/verify', {
      method: 'POST',
      body: JSON.stringify({ email, token, type: 'email' })
    });
    storeSession(session);
    return session.user;
  }

  async function signOut() {
    const session = readSession();
    if (session?.access_token) {
      try {
        await request('/auth/v1/logout', {
          method: 'POST',
          headers: { Authorization: `Bearer ${session.access_token}` }
        });
      } catch (_) {}
    }
    storeSession(null);
  }

  function toRow(card, userId) {
    return {
      user_id: userId,
      id: card.id,
      store: card.store,
      number: String(card.number),
      color_a: card.a,
      color_b: card.b,
      text_color: card.text || '#fff',
      last_used: Number(card.lastUsed || Date.now()),
      format: card.format || 'code_128',
      code_image: card.codeImage || null,
      updated_at: new Date().toISOString()
    };
  }

  function fromRow(row) {
    return {
      id: row.id,
      store: row.store,
      number: row.number,
      a: row.color_a,
      b: row.color_b,
      text: row.text_color || '#fff',
      lastUsed: Number(row.last_used || 0),
      format: row.format || 'code_128',
      codeImage: row.code_image || null
    };
  }

  async function listCards() {
    const rows = await request('/rest/v1/cards?select=*&order=last_used.desc', {
      method: 'GET'
    }, true);
    return (rows || []).map(fromRow);
  }

  async function upsertCards(cards) {
    if (!cards.length) return;
    const session = await validSession();
    const userId = session?.user?.id;
    if (!userId) throw new Error('Сессия истекла. Войдите снова.');
    await request('/rest/v1/cards?on_conflict=user_id,id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(cards.map(card => toRow(card, userId)))
    }, true);
  }

  async function deleteCard(id) {
    await request(`/rest/v1/cards?id=eq.${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { Prefer: 'return=minimal' }
    }, true);
  }

  window.KartochkaCloud = {
    configured,
    user,
    validSession,
    sendCode,
    verifyCode,
    signOut,
    listCards,
    upsertCards,
    deleteCard
  };
})();
