/**
 * Vocabulário do log de acessos, do lado da tela.
 *
 * O backend grava `event_type` como 'login' | 'logout' | 'org.switch' ou
 * '<tabela>.<insert|update|delete>'. A lista de tabelas aqui espelha as
 * triggers da migração `database_migration_activity_logs.sql` — se uma tabela
 * entrar lá, entra aqui também, senão o filtro não a oferece (a linha ainda
 * aparece, com o nome cru da tabela).
 */
export const ACCESS_EVENTS = ['login', 'logout', 'org.switch'];

export const AUDITED_TABLES = [
  'tournaments',
  'tournament_days',
  'stages',
  'transactions',
  'sangria_transactions',
  'cashbox_sessions',
  'cashbox_transactions',
  'staff',
  'permission_groups',
  'staff_payments',
  'expenses',
  'other_revenues',
  'buy_types',
  'payment_methods',
  'app_settings',
  'cash_days',
  'cash_transactions',
];

/** Opções do select de evento: acessos + "tudo de uma tabela" (prefixo). */
export const EVENT_FILTER_OPTIONS = [
  ...ACCESS_EVENTS.map((e) => ({ value: e, kind: 'access' })),
  ...AUDITED_TABLES.map((tb) => ({ value: `${tb}.*`, kind: 'table' })),
];

/** Divide 'tournaments.update' em { table, op }; acessos voltam { access }. */
export function splitEvent(eventType) {
  if (!eventType) return { access: null, table: null, op: null };
  if (ACCESS_EVENTS.includes(eventType)) return { access: eventType, table: null, op: null };
  const i = eventType.lastIndexOf('.');
  if (i < 0) return { access: null, table: eventType, op: null };
  return { access: null, table: eventType.slice(0, i), op: eventType.slice(i + 1) };
}

/**
 * Texto do evento, traduzido. `t` é o do react-i18next.
 * Acessos têm frase própria; ações viram "<Verbo> <entidade>".
 */
export function eventLabel(t, eventType) {
  const { access, table, op } = splitEvent(eventType);
  if (access) {
    const key = access === 'org.switch' ? 'orgSwitch' : access;
    return t(`activityLog.events.${key}`, access);
  }
  const entidade = t(`activityLog.tables.${table}`, table);
  if (!op) return entidade;
  const verbo = t(`activityLog.ops.${op}`, op);
  return `${verbo} ${entidade}`;
}

/** Nome de um campo do diff, traduzido quando temos tradução. */
export function fieldLabel(t, field) {
  return t(`activityLog.fields.${field}`, field);
}
