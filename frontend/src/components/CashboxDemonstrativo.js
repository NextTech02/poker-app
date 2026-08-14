import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useStage } from '../contexts/StageContext';
import Card from './Card';
import Button from './Button';
import EmptyState from './EmptyState';
import { SkeletonStatCard, SkeletonTableRow } from './SkeletonLoader';
import { useCurrency } from '../contexts/CurrencyContext';
import './CashboxDemonstrativo.css';

const firstOfMonth = () => new Date(new Date().setDate(1)).toISOString().split('T')[0];
const today = () => new Date().toISOString().split('T')[0];

const CashboxDemonstrativo = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { selectedStage } = useStage();
  const { formatCurrency } = useCurrency();

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [staffOptions, setStaffOptions] = useState([]);
  const [filters, setFilters] = useState({
    start: firstOfMonth(),
    end: today(),
    staff_id: '',
  });

  // Lista de funcionários (derivada dos caixas da etapa) para o filtro.
  const loadStaff = useCallback(async () => {
    try {
      const res = await api.get('/cashboxes', { _silentError: true });
      const seen = new Map();
      (res.data || []).forEach((cb) => {
        if (cb.staff_id && !seen.has(cb.staff_id)) {
          seen.set(cb.staff_id, cb.staff_name || cb.staff_email || cb.staff_id);
        }
      });
      setStaffOptions(Array.from(seen, ([id, name]) => ({ id, name })));
    } catch (_) {
      setStaffOptions([]);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = {};
      if (filters.start) params.date_from = `${filters.start}T00:00:00`;
      if (filters.end) params.date_to = `${filters.end}T23:59:59`;
      if (filters.staff_id) params.staff_id = filters.staff_id;
      const res = await api.get('/cashboxes/demonstrativo', { params, _silentError: true });
      setData(res.data);
    } catch (err) {
      toast.error(err.userMessage || t('cashbox.demoError'));
      setData(null);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, t]);

  // Recarrega lista de funcionários ao trocar de etapa.
  useEffect(() => {
    loadStaff();
  }, [loadStaff, selectedStage?.id]);

  // Carrega o relatório ao montar, ao trocar de etapa (reset implícito não, mas re-busca).
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStage?.id]);

  const sessions = data?.sessions || [];
  const entradas = (s) => (s.total_buy_ins || 0) + (s.total_rebuys || 0) + (s.total_addons || 0);
  const grandEntradas = data?.grand_buy_ins || 0;

  const diffClass = (d) => {
    if (d === null || d === undefined) return '';
    if (d === 0) return 'cb-demo__ok';
    return 'cb-demo__bad';
  };

  return (
    <div className="cb-demo">
      {/* Filtros */}
      <Card className="cb-demo__filters-card">
        <div className="cb-demo__filters">
          <div className="form-group">
            <label>{t('cashbox.periodStart')}</label>
            <input
              type="date"
              value={filters.start}
              onChange={(e) => setFilters((p) => ({ ...p, start: e.target.value }))}
            />
          </div>
          <div className="form-group">
            <label>{t('cashbox.periodEnd')}</label>
            <input
              type="date"
              value={filters.end}
              onChange={(e) => setFilters((p) => ({ ...p, end: e.target.value }))}
            />
          </div>
          <div className="form-group">
            <label>{t('cashbox.staff')}</label>
            <select
              value={filters.staff_id}
              onChange={(e) => setFilters((p) => ({ ...p, staff_id: e.target.value }))}
            >
              <option value="">{t('cashbox.allStaff')}</option>
              {staffOptions.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div className="cb-demo__filter-actions">
            <Button onClick={load}>{t('cashbox.generate')}</Button>
          </div>
        </div>
      </Card>

      {/* Totais */}
      <div className="stats-grid">
        {loading ? (
          <><SkeletonStatCard /><SkeletonStatCard /><SkeletonStatCard /><SkeletonStatCard /></>
        ) : data ? (
          <>
            <Card className="stat-card">
              <div className="stat-info">
                <h3>{formatCurrency(grandEntradas)}</h3>
                <p>{t('cashbox.totalEntries')}</p>
              </div>
            </Card>
            <Card className="stat-card">
              <div className="stat-info">
                <h3>{formatCurrency(data.grand_prizes)}</h3>
                <p>{t('cashbox.totalPrizes')}</p>
              </div>
            </Card>
            <Card className="stat-card">
              <div className="stat-info">
                <h3>{formatCurrency(data.grand_expected)}</h3>
                <p>{t('cashbox.expectedTotal')}</p>
              </div>
            </Card>
            <Card className="stat-card">
              <div className="stat-info">
                <h3 className={diffClass(data.grand_difference)}>{formatCurrency(data.grand_difference)}</h3>
                <p>{t('cashbox.differenceTotal')}</p>
              </div>
            </Card>
          </>
        ) : null}
      </div>

      {/* Tabela de sessões */}
      <Card title={t('cashbox.demoTitle')}>
        {loading ? (
          <div className="table-container">
            <table className="transactions-table">
              <thead>
                <tr>
                  <th>{t('cashbox.staff')}</th><th>{t('cashbox.opening')}</th><th>{t('cashbox.closing')}</th>
                  <th>{t('cashbox.initialBalanceShort')}</th><th>{t('cashbox.supply')}</th><th>{t('cashbox.sangria')}</th>
                  <th>{t('cashbox.entries')}</th><th>{t('cashbox.prizes')}</th>
                  <th>{t('cashbox.expectedShort')}</th><th>{t('cashbox.countedShort')}</th><th>{t('cashbox.difference')}</th>
                </tr>
              </thead>
              <tbody>
                <SkeletonTableRow cols={11} />
                <SkeletonTableRow cols={11} />
                <SkeletonTableRow cols={11} />
              </tbody>
            </table>
          </div>
        ) : sessions.length === 0 ? (
          <EmptyState
            icon={null}
            title={t('cashbox.noSessions')}
            subtitle={t('cashbox.noSessionsHint')}
          />
        ) : (
          <div className="table-container">
            <table className="transactions-table cb-demo__table">
              <thead>
                <tr>
                  <th>{t('cashbox.staff')}</th>
                  <th>{t('cashbox.opening')}</th>
                  <th>{t('cashbox.closing')}</th>
                  <th className="amount">{t('cashbox.initialBalanceShort')}</th>
                  <th className="amount">{t('cashbox.supply')}</th>
                  <th className="amount">{t('cashbox.sangria')}</th>
                  <th className="amount">{t('cashbox.entries')}</th>
                  <th className="amount">{t('cashbox.prizes')}</th>
                  <th className="amount">{t('cashbox.expectedShort')}</th>
                  <th className="amount">{t('cashbox.countedShort')}</th>
                  <th className="amount">{t('cashbox.difference')}</th>
                </tr>
              </thead>
              <tbody>
                {sessions.map((s) => (
                  <tr key={s.session_id}>
                    <td>{s.staff_name || '—'}</td>
                    <td>{new Date(s.opened_at).toLocaleString('pt-BR')}</td>
                    <td>
                      {s.is_open ? (
                        <span className="cb-demo__pill-open">{t('cashbox.statusOpen')}</span>
                      ) : s.closed_at ? (
                        new Date(s.closed_at).toLocaleString('pt-BR')
                      ) : '—'}
                    </td>
                    <td className="amount">{formatCurrency(s.initial_balance)}</td>
                    <td className="amount">{formatCurrency(s.total_supply)}</td>
                    <td className="amount">{formatCurrency(s.total_sangria)}</td>
                    <td className="amount">{formatCurrency(entradas(s))}</td>
                    <td className="amount">{formatCurrency(s.total_prizes_paid)}</td>
                    <td className="amount">{formatCurrency(s.expected_balance)}</td>
                    <td className="amount">
                      {s.actual_balance === null || s.actual_balance === undefined
                        ? '—'
                        : formatCurrency(s.actual_balance)}
                    </td>
                    <td className={`amount ${diffClass(s.difference)}`}>
                      {s.difference === null || s.difference === undefined ? '—' : formatCurrency(s.difference)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="cb-demo__totals-row">
                  <td colSpan={3}>{t('cashbox.total')}</td>
                  <td className="amount">{formatCurrency(data.grand_initial)}</td>
                  <td className="amount">{formatCurrency(data.grand_supply)}</td>
                  <td className="amount">{formatCurrency(data.grand_sangria)}</td>
                  <td className="amount">{formatCurrency(grandEntradas)}</td>
                  <td className="amount">{formatCurrency(data.grand_prizes)}</td>
                  <td className="amount">{formatCurrency(data.grand_expected)}</td>
                  <td className="amount">{formatCurrency(data.grand_actual)}</td>
                  <td className={`amount ${diffClass(data.grand_difference)}`}>{formatCurrency(data.grand_difference)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
};

export default CashboxDemonstrativo;
