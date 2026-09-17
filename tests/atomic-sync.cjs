/* Deterministic two-device tests. All accounts, cards and network replies are fake. */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const source = fs.readFileSync(require('node:path').join(__dirname, '../cloud-atomic.js'), 'utf8');
const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const anotherUser = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const id = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const clone = value => JSON.parse(JSON.stringify(value));
const card = number => ({ id, store:'Лента', number, a:'#245bd0', b:'#122d78',
  text:'#fff', lastUsed:1700000000000, format:'qr_code', codeImage:null });
const row = (number, owner = user) => ({ user_id:owner, id, store:'Лента', number,
  color_a:'#245bd0', color_b:'#122d78', text_color:'#fff',
  last_used:1700000000000, format:'qr_code', code_image:null,
  revision:1, deleted_at:null });
const remote = new Map([[user, new Map([[id, row('ORIGINAL-001')]])]]);
let failingNetwork = false;
let calls = 0;
const response = (value, status = 200) => ({
  ok:status >= 200 && status < 300, status,
  async text() { return value === null ? '' : JSON.stringify(value); },
  async json() { return value; }
});
function profile(uid, initial = []) {
  const data = new Map([['kartochka.cards.v1', JSON.stringify(initial)],
    ['kartochka.cloud-user.v1', uid]]);
  const localStorage = {
    getItem(key) { return data.has(key) ? data.get(key) : null; },
    setItem(key, value) { data.set(key, String(value)); },
    removeItem(key) { data.delete(key); }
  };
  const legacy = {
    configured: () => true,
    user: () => ({ id:uid }),
    validSession: async () => ({ access_token:uid, user:{ id:uid, email:'fake@example.test' } })
  };
  async function fetchMock(url, options = {}) {
    if (failingNetwork) throw new Error('Fake network outage');
    const endpoint = new URL(url);
    assert.equal(options.headers.Authorization, `Bearer ${uid}`);
    const items = remote.get(uid) || new Map();
    if (endpoint.pathname === '/rest/v1/cards') return response(clone([...items.values()]));
    assert.equal(endpoint.pathname, '/rest/v1/rpc/apply_card_change');
    calls++;
    const args = JSON.parse(options.body);
    const current = items.get(args.p_card_id);
    const actual = current ? Number(current.revision) : 0;
    if (actual !== args.p_expected_revision || (current?.deleted_at && !args.p_delete)) {
      return response({ code:'P0001', message:'SYNC_CONFLICT' }, 409);
    }
    if (args.p_delete) {
      if (!current || current.deleted_at) return response({ code:'P0001', message:'SYNC_CONFLICT' }, 409);
      Object.assign(current, { store:'Удалена', number:'0', code_image:null,
        deleted_at:'2026-09-17T00:00:00Z', revision:actual+1 });
    } else {
      const next = { ...(current || {}), ...args.p_card,
        user_id:uid, id:args.p_card_id, deleted_at:null, revision:actual + 1 };
      items.set(args.p_card_id, next);
    }
    remote.set(uid, items);
    return response({ revision:actual+1, deleted:args.p_delete });
  }
  const window = { KARTOCHKA_CONFIG:{ supabaseUrl:'https://example.supabase.co', supabaseAnonKey:'fake-publishable-key' }, KartochkaCloud:legacy };
  vm.runInNewContext(source, { window, document:{querySelector:() => null}, localStorage,
    crypto:webcrypto, TextEncoder, fetch:fetchMock, queueMicrotask,
    setTimeout:() => 0, URL, console }, { filename:'cloud-atomic.js' });
  return {
    sync:window.KartochkaCloud,
    localStorage,
    put(items) { localStorage.setItem('kartochka.cards.v1', JSON.stringify(items)); },
    get() { return JSON.parse(localStorage.getItem('kartochka.cards.v1')); }
  };
}
(async () => {
  const a = profile(user, [card('ORIGINAL-001')]);
  const b = profile(user, [card('ORIGINAL-001')]);
  const c = profile(user, [card('ORIGINAL-001')]);
  for (const device of [a,b,c]) {
    const initial = await device.sync.listCards();
    assert.equal(initial[0].number, 'ORIGINAL-001');
    await device.sync.upsertCards(initial);
  }
  assert.equal(remote.get(user).get(id).revision, 1);
  console.log('PASS independent devices establish matching revision baselines');

  a.put([card('DEVICE-A-002')]);
  b.put([card('DEVICE-B-003')]);
  const first = await a.sync.listCards();
  const second = await b.sync.listCards();
  await a.sync.upsertCards(first);
  const beforeConflict = clone(remote.get(user).get(id));
  await assert.rejects(() => b.sync.upsertCards(second), /Конфликт изменений/);
  assert.deepEqual(remote.get(user).get(id), beforeConflict);
  assert.equal(b.get()[0].number, 'DEVICE-B-003');
  assert.equal(b.localStorage.getItem(`kartochka.sync-pending.v1.${user}`), '1');
  console.log('PASS atomic compare-and-swap blocks stale concurrent write without losing local edit');

  a.put([]);
  await a.sync.deleteCard(id);
  const deleted = remote.get(user).get(id);
  assert.equal(deleted.deleted_at !== null, true);
  assert.equal(deleted.number, '0');
  assert.equal(deleted.code_image, null);
  const writesBefore = calls;
  const reconciled = await c.sync.listCards();
  assert.equal(reconciled.length, 0);
  c.put(reconciled);
  await c.sync.upsertCards(reconciled);
  assert.equal(c.get().length, 0);
  assert.equal(calls, writesBefore);
  assert.equal(remote.get(user).get(id).deleted_at !== null, true);
  console.log('PASS server tombstone removes card on other device without resurrection');

  const stillEdited = clone(b.get());
  await assert.rejects(() => b.sync.listCards(), /Конфликт изменений/);
  assert.deepEqual(b.get(), stillEdited);
  console.log('PASS delete-versus-offline-edit reports conflict and preserves local version');

  const guest = profile(anotherUser);
  const otherCards = await guest.sync.listCards();
  assert.equal(otherCards.length, 0);
  await guest.sync.upsertCards(otherCards);
  assert.equal(remote.get(anotherUser)?.size || 0, 0);
  console.log('PASS separate account has no access to another account cards');

  failingNetwork = true;
  const beforeOutage = clone(b.get());
  await assert.rejects(() => b.sync.listCards(), /Fake network outage/);
  assert.deepEqual(b.get(), beforeOutage);
  assert.equal(b.localStorage.getItem(`kartochka.sync-pending.v1.${user}`), '1');
  failingNetwork = false;
  console.log('PASS connection failure keeps local cards and pending-sync state');
  console.log('PASS all atomic-sync regressions');
})().catch(error => { console.error('FAIL', error); process.exitCode = 1; });
