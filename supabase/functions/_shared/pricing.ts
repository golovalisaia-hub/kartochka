/*
 * Тариф для серверной части бота.
 *
 * Почему файл продублирован: Supabase бандлит при развёртывании только содержимое каталога
 * `supabase/functions`. Импорт `../../../pricing.js` из корня репозитория собирался бы
 * локально, но упал бы уже на развёрнутой функции — и только там, где это дороже всего
 * заметить. Поэтому у бота своя копия внутри каталога функций.
 *
 * Значения обязаны совпадать с корневым `pricing.js`, который читают браузер и страница
 * тарифа. За этим следит тест `tests/legal-pages.cjs`: при расхождении он падает, так что
 * цена не может разойтись между ботом и сайтом незаметно.
 *
 * Меняя цену, правьте ОБА файла.
 */
export const ACCESS_MODEL = 'one_time_period';

export const PLAN = {
  id: 'community_access',
  name: 'Доступ к картам сообщества',
  /** Цена в рублях. null — владельцем не определена. Не подставлять произвольное число. */
  amount: null,
  currency: 'RUB',
  periodDays: 30,
  autoRenew: false
};

export function priceIsPublished() {
  return Number.isFinite(PLAN.amount) && PLAN.amount > 0;
}

export function priceLabel() {
  if (!priceIsPublished()) return 'Стоимость уточняется';
  return `${PLAN.amount} ₽ единоразово за ${PLAN.periodDays} дней доступа`;
}

export function accessModelLabel() {
  return `разовая оплата за ${PLAN.periodDays} дней доступа, без автоматического продления`;
}
