/* One-shot, branch-only anchored patch. Fail rather than clobber unknown source. */
'use strict';
const fs = require('node:fs');
function edit(file, work) {
  const original = fs.readFileSync(file, 'utf8');
  const changed = work(original);
  if (changed === original) throw new Error(`${file}: no changes`);
  fs.writeFileSync(file, changed);
}
function once(src, before, after, name) {
  if (src.split(before).length !== 2) throw new Error(`${name}: expected exactly one anchor`);
  return src.replace(before, after);
}
function region(src, start, end, replacement, name) {
  const a = src.indexOf(start);
  if (a < 0 || src.indexOf(start, a + 1) >= 0) throw new Error(`${name}: start missing or duplicated`);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`${name}: end missing`);
  return src.slice(0, a) + replacement + src.slice(b + end.length);
}
edit('index.html', src => once(src,
  '  <script src="cloud.js" defer></script>\n',
  '  <script src="cloud.js" defer></script>\n  <script src="cloud-atomic.js" defer></script>\n', 'load atomic adapter'));
edit('sw.js', src => {
  src = once(src, "const CACHE = 'kartochka-v8';", "const CACHE = 'kartochka-v9';", 'cache version');
  return once(src, "  './cloud.js',\n", "  './cloud.js',\n  './cloud-atomic.js',\n", 'cache atomic adapter');
});
edit('app.js', src => {
  src = region(src,
    "      const previousUser = localStorage.getItem(CLOUD_USER_KEY);",
    "      await window.KartochkaCloud.upsertCards(state.cards);",
    `      const walletBeforeSync = JSON.stringify(state.cards);
      const deletionKey = cloudDeletionsKey();
      const pendingDeletions = readStringList(deletionKey);
      for (const id of pendingDeletions) await window.KartochkaCloud.deleteCard(id);
      if (pendingDeletions.length) localStorage.removeItem(deletionKey);

      // listCards reconciles remote tombstones, cached cards and offline edits.
      // Never union local cards again: that would resurrect a deleted card.
      const reconciled = await window.KartochkaCloud.listCards();
      if (JSON.stringify(state.cards) !== walletBeforeSync) {
        throw new Error('Карты изменились во время синхронизации. Повторите попытку.');
      }
      localStorage.setItem(STORAGE_KEY, JSON.stringify(reconciled));
      state.cards = reconciled;
      await window.KartochkaCloud.upsertCards(reconciled);`,
    'authoritative reconciliation');
  src = once(src,
    '    state.cloudTimer = setTimeout(() => syncWithCloud({ quiet: true }), 450);',
    `    try { localStorage.setItem('kartochka.sync-pending.v1.' + state.user.id, '1'); } catch (_) {}
    state.cloudTimer = setTimeout(() => {
      if (state.cloudBusy) queueCloudSync();
      else syncWithCloud({ quiet: true });
    }, 450);`, 'queued writes during busy sync');
  src = region(src,
    '  async function signOut() {',
    '  function initials(name) {',
    `  async function signOut() {
    try {
      // cloud.js first stores a verified recovery copy. If it cannot, stay signed in.
      await window.KartochkaCloud.signOut();
      localStorage.removeItem(STORAGE_KEY);
      state.user = null;
      state.cards = [];
      localStorage.removeItem(CLOUD_USER_KEY);
      renderStack();
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

  function initials(name) {`, 'quota-safe logout');
  src = region(src,
    '    const remainingCards = state.cards.filter(item => item.id !== state.activeCardId);',
    '    releaseScreenWakeLock();',
    `    const remainingCards = state.cards.filter(item => item.id !== state.activeCardId);
    const hasCloud = Boolean(state.user && cloudAvailable());
    const deletionKey = hasCloud ? cloudDeletionsKey() : '';
    const previousQueue = hasCloud ? localStorage.getItem(deletionKey) : null;
    try {
      // Queue the tombstone before changing the active wallet; roll it back on failure.
      if (hasCloud) rememberCloudDeletion(card.id);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(remainingCards));
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
    releaseScreenWakeLock();`, 'queue deletions before local commit');
  return src;
});
edit('tests/password-cloud-e2e.cjs', src => once(src,
  "    if (u.pathname === '/rest/v1/cards') {",
  `    if (u.pathname === '/rest/v1/rpc/apply_card_change') {
      const id = token.replace('Bearer test-access-', '');
      if (!Object.values(accounts).includes(id)) return ok({ message:'Unauthenticated' }, 401);
      const current = remote.get(id) || [];
      const existing = current.find(row => row.id === body.p_card_id);
      const actualRevision = existing ? Number(existing.revision || 1) : 0;
      if (Number(body.p_expected_revision) !== actualRevision || (existing?.deleted_at && !body.p_delete)) {
        return ok({ code:'P0001', message:'SYNC_CONFLICT' }, 409);
      }
      if (body.p_delete) {
        if (!existing || existing.deleted_at) return ok({ code:'P0001', message:'SYNC_CONFLICT' }, 409);
        Object.assign(existing, { store:'Удалена', number:'0', code_image:null,
          deleted_at:new Date().toISOString(), revision:actualRevision + 1 });
      } else {
        const replacement = { ...(existing || {}), ...body.p_card,
          id:body.p_card_id, user_id:id, deleted_at:null, revision:actualRevision + 1 };
        remote.set(id, [...current.filter(row => row.id !== body.p_card_id), replacement]);
      }
      return ok({ revision:actualRevision + 1, deleted:Boolean(body.p_delete) });
    }
    if (u.pathname === '/rest/v1/cards') {`, 'mock atomic card RPC'));
edit('tests/cloud-conflict-e2e.cjs', src => {
  src = once(src,
    "  updated_at:'2026-09-16T20:00:00Z'",
    "  updated_at:'2026-09-16T20:00:00Z', revision:1, deleted_at:null", 'mock row revisions');
  for (const number of ['DEVICE-B-003', 'ORIGINAL-001', 'DEVICE-B-004']) {
    src = once(src, `remote[0].number = '${number}';`,
      `remote[0].number = '${number}'; remote[0].revision++;`, `mock ${number} version`);
  }
  return src;
});
console.log('Atomic client integration patches applied once.');
