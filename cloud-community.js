/*
 * Клиент раздела «Карты сообщества».
 *
 * Здесь нет ни одного решения о доступе. Клиент лишь показывает то, что ответил сервер:
 * право на Premium, состав пула и выбор конкретной карты определяются исключительно
 * серверными функциями. Подделка состояния в браузере ничего не открывает — RPC всё равно
 * проверит подписку и вернёт `denied`.
 *
 * Пул целиком сюда не приходит никогда: claim_shared_card отдаёт ровно одну карту и только
 * на время короткой сессии. Владелец выданной карты в ответе не фигурирует.
 */
(() => {
  'use strict';

  const config = () => window.KARTOCHKA_CONFIG || {};

  async function rpc(name, body) {
    const cloud = window.KartochkaCloud;
    const session = await cloud?.validSession?.();
    if (!session?.access_token) throw new Error('Сессия истекла. Войдите снова.');
    const { supabaseUrl, supabaseAnonKey } = config();
    const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body || {})
    });
    if (!response.ok) {
      let payload = {};
      try { payload = await response.json(); } catch (_) {}
      // Сообщения сервера не раскрывают внутренних причин — показываем нейтральный текст.
      throw new Error(payload.message || `Ошибка запроса (${response.status})`);
    }
    return response.json();
  }

  /** Список магазинов и признак доступа. Строится сервером, не клиентом. */
  async function programs() {
    return rpc('community_programs');
  }

  /**
   * Запрос карты. Возвращает одну карту и срок действия сессии либо причину отказа:
   * denied — нет Premium, no_card — сейчас нечего выдать, disabled — раздел выключен,
   * rate_limited — слишком частые запросы.
   */
  async function requestCard(program, brand) {
    return rpc('claim_shared_card', { p_program_key: program, p_brand_key: brand || null });
  }

  /** Владелец включает или выключает общий доступ к своей карте. */
  async function setSharing(cardId, program, brand, enabled) {
    return rpc('set_card_sharing', {
      p_card_id: cardId, p_program_key: program, p_brand_key: brand || null, p_enabled: Boolean(enabled)
    });
  }

  /** Агрегированная статистика владельца. Подписчики в ней не фигурируют. */
  async function stats(cardId) {
    return rpc('owner_sharing_stats', { p_card_id: cardId });
  }

  window.KartochkaCommunity = { programs, requestCard, setSharing, stats };
})();
