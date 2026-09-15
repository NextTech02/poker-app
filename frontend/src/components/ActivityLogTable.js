import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import EmptyState from './EmptyState';
import { SkeletonTableRow } from './SkeletonLoader';
import { diasAtras, hojeLocal } from '../utils/datasLocais';
import { formatUserAgent } from '../utils/userAgent';
import { EVENT_FILTER_OPTIONS, eventLabel, fieldLabel, splitEvent } from '../utils/activityLogEvents';
import './ActivityLogTable.css';

/**
 * Timeline de acessos e ações de UMA organização.
 *
 * Quem decide DE QUAL organização é o `fetchPage` que o pai passa: em
 * Funcionários ele bate em /activity-logs (a org do claim); no painel de
 * Organizações, em /organizations/{id}/activity-logs. A tabela é a mesma de
 * propósito — o admin do clube e a NextHub olham exatamente a mesma coisa.
 *
 * É a primeira lista paginada do sistema. Fica em Anterior/Próxima porque o
 * uso é "o que aconteceu ontem à noite?", não "me leve à página 37".
 *
 * @param {(params: object) => Promise<{items: Array, total: number}>} fetchPage
 * @param {Array<{auth_user_id?: string, name?: string, email?: string}>} [users]
 *   funcionários da org, para o filtro por usuário virar um select.
 */
const TAMANHO_PAGINA = 50;
const MAX_CAMPOS_NO_DIFF = 4;

function valorCurto(v) {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return JSON.stringify(v).slice(0, 40);
  const s = String(v);
  return s.length > 40 ? `${s.slice(0, 37)}…` : s;
}

const ActivityLogTable = ({ fetchPage, users, pageSize = TAMANHO_PAGINA }) => {
  const { t, i18n } = useTranslation();
  const [filters, setFilters] = useState({
    userId: '',
    eventType: '',
    from: diasAtras(30),
    to: hojeLocal(),
  });
  const [page, setPage] = useState(1);
  const [data, setData] = useState({ items: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const res = await fetchPage({
        user_id: filters.userId || undefined,
        event_type: filters.eventType || undefined,
        date_from: filters.from || undefined,
        date_to: filters.to || undefined,
        page,
        page_size: pageSize,
      });
      setData({ items: res?.items || [], total: res?.total || 0 });
    } catch {
      setData({ items: [], total: 0 });
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [fetchPage, filters, page, pageSize]);

  useEffect(() => { load(); }, [load]);

  // Mudar filtro volta para a primeira página: a página 3 do filtro antigo
  // não quer dizer nada no novo.
  const mudarFiltro = (campo, valor) => {
    setFilters((f) => ({ ...f, [campo]: valor }));
    setPage(1);
  };

  const usuarios = useMemo(
    () => (users || []).filter((u) => u.auth_user_id),
    [users],
  );

  const fmtData = useMemo(
    () => new Intl.DateTimeFormat(i18n.language || 'pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
    }),
    [i18n.language],
  );

  const totalPaginas = Math.max(1, Math.ceil(data.total / pageSize));
  const inicio = data.total === 0 ? 0 : (page - 1) * pageSize + 1;
  const fim = Math.min(page * pageSize, data.total);

  const renderDetalhes = (row) => {
    const { access } = splitEvent(row.event_type);
    if (access) {
      const partes = [row.ip, formatUserAgent(row.user_agent)].filter(Boolean);
      return partes.length ? <span className="al-muted">{partes.join(' · ')}</span> : null;
    }
    const changes = row.changes || {};
    const chaves = Object.keys(changes);
    const visiveis = chaves.slice(0, MAX_CAMPOS_NO_DIFF);
    const isUpdate = row.event_type.endsWith('.update');
    return (
      <>
        {row.entity_label && <span className="al-entity">{row.entity_label}</span>}
        {visiveis.length > 0 && (
          <ul className="al-diff">
            {visiveis.map((k) => (
              <li key={k}>
                <span className="al-field">{fieldLabel(t, k)}:</span>{' '}
                {isUpdate && changes[k] && typeof changes[k] === 'object' && 'new' in changes[k] ? (
                  <>
                    <span className="al-old">{valorCurto(changes[k].old)}</span>
                    {' → '}
                    <span className="al-new">{valorCurto(changes[k].new)}</span>
                  </>
                ) : (
                  <span className="al-new">{valorCurto(changes[k])}</span>
                )}
              </li>
            ))}
            {chaves.length > visiveis.length && (
              <li className="al-muted">+{chaves.length - visiveis.length}</li>
            )}
          </ul>
        )}
      </>
    );
  };

  const classeEvento = (eventType) => {
    const { access, op } = splitEvent(eventType);
    if (access) return access === 'logout' ? 'badge-secondary' : 'badge-info';
    if (op === 'delete') return 'badge-danger';
    if (op === 'insert') return 'badge-success';
    return 'badge-warning';
  };

  return (
    <div className="activity-log">
      <div className="al-filters">
        <div className="form-group">
          <label htmlFor="al-user">{t('activityLog.filters.user', 'Usuário')}</label>
          {usuarios.length > 0 ? (
            <select id="al-user" value={filters.userId}
                    onChange={(e) => mudarFiltro('userId', e.target.value)}>
              <option value="">{t('activityLog.filters.allUsers', 'Todos')}</option>
              {usuarios.map((u) => (
                <option key={u.auth_user_id} value={u.auth_user_id}>
                  {u.name || u.email}
                </option>
              ))}
            </select>
          ) : (
            <input id="al-user" type="text" value={filters.userId}
                   placeholder={t('activityLog.filters.userIdHint', 'ID do usuário')}
                   onChange={(e) => mudarFiltro('userId', e.target.value)} />
          )}
        </div>
        <div className="form-group">
          <label htmlFor="al-event">{t('activityLog.filters.event', 'Evento')}</label>
          <select id="al-event" value={filters.eventType}
                  onChange={(e) => mudarFiltro('eventType', e.target.value)}>
            <option value="">{t('activityLog.filters.allEvents', 'Todos')}</option>
            {EVENT_FILTER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.kind === 'access'
                  ? eventLabel(t, o.value)
                  : t(`activityLog.tables.${o.value.slice(0, -2)}`, o.value.slice(0, -2))}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="al-from">{t('common.from', 'De')}</label>
          <input id="al-from" type="date" value={filters.from}
                 onChange={(e) => mudarFiltro('from', e.target.value)} />
        </div>
        <div className="form-group">
          <label htmlFor="al-to">{t('common.to', 'Até')}</label>
          <input id="al-to" type="date" value={filters.to}
                 onChange={(e) => mudarFiltro('to', e.target.value)} />
        </div>
      </div>

      {loading ? (
        <table className="data-table">
          <tbody>
            <SkeletonTableRow cols={4} />
            <SkeletonTableRow cols={4} />
            <SkeletonTableRow cols={4} />
          </tbody>
        </table>
      ) : error ? (
        <EmptyState
          icon={null}
          title={t('activityLog.error', 'Não foi possível carregar o log')}
        />
      ) : data.items.length === 0 ? (
        <EmptyState
          icon={null}
          title={t('activityLog.empty', 'Nenhum registro no período')}
          subtitle={t('activityLog.emptyHint', 'Amplie o período ou limpe os filtros.')}
        />
      ) : (
        <>
          <div className="table-container">
            <table className="data-table al-table">
              <thead>
                <tr>
                  <th>{t('activityLog.columns.when', 'Quando')}</th>
                  <th>{t('activityLog.columns.user', 'Usuário')}</th>
                  <th>{t('activityLog.columns.event', 'Evento')}</th>
                  <th>{t('activityLog.columns.details', 'Detalhes')}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((row) => (
                  <tr key={row.id}>
                    <td className="al-when">{fmtData.format(new Date(row.created_at))}</td>
                    <td className="al-user">
                      {row.user_email || <span className="al-muted">{t('activityLog.system', 'Sistema')}</span>}
                    </td>
                    <td>
                      <span className={`badge ${classeEvento(row.event_type)}`}>
                        {eventLabel(t, row.event_type)}
                      </span>
                    </td>
                    <td className="al-details">{renderDetalhes(row)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="al-pagination">
            <span className="al-muted">
              {t('activityLog.range', '{{from}}–{{to}} de {{total}}', { from: inicio, to: fim, total: data.total })}
            </span>
            <div className="al-pagination-buttons">
              <button type="button" className="btn btn-secondary btn-sm"
                      disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                {t('activityLog.prev', 'Anterior')}
              </button>
              <button type="button" className="btn btn-secondary btn-sm"
                      disabled={page >= totalPaginas} onClick={() => setPage((p) => p + 1)}>
                {t('activityLog.next', 'Próxima')}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default ActivityLogTable;
