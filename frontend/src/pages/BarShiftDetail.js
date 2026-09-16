import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import Sidebar from '../components/Sidebar';
import Breadcrumb from '../components/Breadcrumb';
import EmptyState from '../components/EmptyState';
import CashboxAdminPanel from '../components/CashboxAdminPanel';
import CashboxDemonstrativo from '../components/CashboxDemonstrativo';
import { SkeletonStatCard } from '../components/SkeletonLoader';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useBarShift } from '../contexts/BarShiftContext';
import { usePermissions } from '../contexts/PermissionContext';
import { useEscapeKey } from '../hooks/useEscapeKey';
import useRealtimeRefresh from '../hooks/useRealtimeRefresh';
import { aoMudarOCaixa } from '../utils/eventosDoCaixa';
import './CashFloor.css';
import './Bar.css';

/**
 * Um TURNO por dentro: os números (ao vivo ou congelados), o que ainda segura
 * o fechamento (comandas abertas), e as GAVETAS do turno — o painel de caixas
 * e o demonstrativo, os mesmos do Financeiro, ancorados aqui em vez da etapa.
 */
const BarShiftDetail = () => {
  const { id } = useParams();
  const { t } = useTranslation();
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();
  const { reload: reloadShift } = useBarShift();
  const { hasPermission } = usePermissions();

  const [shift, setShift] = useState(null);
  const [summary, setSummary] = useState(null);
  const [openTabs, setOpenTabs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [closing, setClosing] = useState(false);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [bloqueio, setBloqueio] = useState(null);

  useEscapeKey(closing, () => { if (!submitting) setClosing(false); });

  const load = useCallback(async () => {
    try {
      const [s, r, tabs] = await Promise.all([
        api.get(`/bar/shifts/${id}`, { _silentError: true }),
        api.get(`/bar/shifts/${id}/summary`, { _silentError: true }).catch(() => ({ data: null })),
        api.get('/bar/tabs', { params: { bar_shift_id: id, status: 'open' }, _silentError: true })
          .catch(() => ({ data: [] })),
      ]);
      setShift(s.data);
      setSummary(r.data);
      setOpenTabs(tabs.data || []);
    } catch {
      setShift(null);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  useRealtimeRefresh({
    canal: `bar-shift-${id}`,
    tabelas: [
      { table: 'bar_tabs', filter: `bar_shift_id=eq.${id}` },
      { table: 'bar_tab_payments', filter: `bar_shift_id=eq.${id}` },
      { table: 'bar_shifts', filter: `id=eq.${id}` },
    ],
    aoMudar: () => load(),
    ativo: !!id,
  });
  useEffect(() => aoMudarOCaixa(() => load()), [load]);

  const fechar = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setBloqueio(null);
    try {
      await api.post(`/bar/shifts/${id}/close`, { notes: notes || null });
      toast.success(t('bar.shiftClosed', 'Turno encerrado'));
      setClosing(false);
      await load();
      await reloadShift();
    } catch (err) {
      const detalhe = err?.response?.data?.detail;
      if (detalhe?.code === 'turno_com_comanda_aberta' || detalhe?.code === 'turno_com_caixa_aberto') {
        setBloqueio(detalhe);
      }
      toast.error(err.userMessage || t('bar.shiftCloseError', 'Não foi possível encerrar o turno'));
    } finally {
      setSubmitting(false);
    }
  };

  const isOpen = shift?.status === 'open';

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <Breadcrumb items={[
          { label: t('bar.title', 'Bar'), to: '/bar' },
          { label: t('bar.shifts', 'Turnos'), to: '/bar/turnos' },
          { label: shift ? shift.business_date : '…' },
        ]} />

        <div className="page-header">
          <div>
            <h1>
              {t('bar.shiftTitle', 'Turno de {{date}}', { date: shift?.business_date || '' })}
              {shift?.label ? ` · ${shift.label}` : ''}
            </h1>
            <p className="subtitle">
              {shift && (
                <span className={`bar-status-${shift.status}`}>
                  {isOpen ? t('bar.statusOpen', 'Aberto') : t('bar.statusClosed', 'Fechado')}
                </span>
              )}
            </p>
          </div>
          {isOpen && hasPermission('bar.shift') && (
            <button type="button" className="btn btn-primary"
                    onClick={() => { setNotes(''); setBloqueio(null); setClosing(true); }}>
              {t('bar.closeShift', 'Encerrar')}
            </button>
          )}
        </div>

        {loading ? (
          <div className="stats-grid"><SkeletonStatCard /><SkeletonStatCard /><SkeletonStatCard /></div>
        ) : !shift ? (
          <EmptyState icon={null} title={t('bar.shiftNotFound', 'Turno não encontrado')} />
        ) : (
          <>
            {summary && (
              <div className="stats-grid">
                <div className="stat-card stat-card--highlight">
                  <span className="stat-label">{t('bar.netSales', 'Vendas')}</span>
                  <span className="stat-value">{formatCurrency(summary.total_net)}</span>
                  <span className="stat-hint">
                    {t('bar.grossAndDiscounts', 'bruto {{gross}} · descontos {{disc}}', {
                      gross: formatCurrency(summary.total_gross),
                      disc: formatCurrency((summary.total_discounts || 0) + (summary.total_courtesy || 0)),
                    })}
                  </span>
                </div>
                <div className="stat-card">
                  <span className="stat-label">{t('bar.paid', 'Recebido')}</span>
                  <span className="stat-value">{formatCurrency(summary.total_paid)}</span>
                  <span className="stat-hint">
                    {t('bar.paidBreakdown', 'dinheiro {{cash}} · crédito {{credit}}', {
                      cash: formatCurrency(summary.total_paid_cash),
                      credit: formatCurrency(summary.total_paid_credit),
                    })}
                  </span>
                </div>
                <div className="stat-card">
                  <span className="stat-label">{t('bar.margin', 'Margem')}</span>
                  <span className="stat-value">{formatCurrency(summary.gross_margin)}</span>
                  <span className="stat-hint">
                    {t('bar.cogsHint', 'CMV {{cogs}}', { cogs: formatCurrency(summary.total_cogs) })}
                  </span>
                </div>
                <div className="stat-card">
                  <span className="stat-label">{t('bar.tabsCount', 'Comandas')}</span>
                  <span className="stat-value">{summary.tabs_total}</span>
                  <span className="stat-hint">
                    {isOpen
                      ? t('bar.tabsOpenHint', '{{open}} aberta(s) · saldo {{due}}', {
                        open: summary.tabs_open, due: formatCurrency(summary.balance_due),
                      })
                      : t('bar.itemsHint', '{{items}} item(ns)', { items: summary.items_count })}
                  </span>
                </div>
              </div>
            )}

            {summary && summary.by_method?.length > 0 && (
              <div className="bar-section">
                <h2>{t('bar.byMethod', 'Por forma de pagamento')}</h2>
                <ul className="bar-kpi-list">
                  {summary.by_method.map((m) => (
                    <li key={m.payment_method}>
                      <span className="bar-muted">{m.payment_method}</span>
                      <strong>{formatCurrency(m.amount)}</strong>
                      <span className="bar-muted"> · {m.count}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {isOpen && (
              <div className="bar-section">
                <h2>{t('bar.openTabs', 'Comandas abertas')}</h2>
                {openTabs.length === 0 ? (
                  <p className="bar-muted">{t('bar.noOpenTabs', 'Nenhuma comanda aberta.')}</p>
                ) : (
                  <div className="table-container">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>{t('bar.player', 'Jogador')}</th>
                          <th>{t('bar.total', 'Total')}</th>
                          <th>{t('bar.paid', 'Recebido')}</th>
                          <th>{t('bar.balanceDue', 'Saldo')}</th>
                          <th aria-label={t('common.actions', 'Ações')} />
                        </tr>
                      </thead>
                      <tbody>
                        {openTabs.map((c) => (
                          <tr key={c.id}>
                            <td>{c.number}</td>
                            <td>{c.player_name || '—'}</td>
                            <td>{formatCurrency(c.total)}</td>
                            <td>{formatCurrency(c.paid_amount)}</td>
                            <td><strong>{formatCurrency(c.balance_due)}</strong></td>
                            <td>
                              <Link className="btn btn-secondary btn-sm" to={`/bar/comandas/${c.id}`}>
                                {t('common.details', 'Detalhes')}
                              </Link>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            <div className="bar-section">
              <CashboxAdminPanel anchor={{ barShiftId: id }} />
            </div>
            <div className="bar-section">
              <CashboxDemonstrativo anchor={{ barShiftId: id }} />
            </div>
          </>
        )}

        {closing && (
          <div className="modal-overlay"
               onClick={(e) => { if (e.target === e.currentTarget && !submitting) setClosing(false); }}>
            <div className="modal" role="dialog" aria-modal="true">
              <h2>{t('bar.closeShiftTitle', 'Encerrar o turno de {{date}}', { date: shift?.business_date })}</h2>
              <form onSubmit={fechar}>
                <p className="bar-note">
                  {t('bar.closeShiftHint', 'As vendas do turno serão CONGELADAS. Toda comanda precisa estar quitada e toda gaveta do turno, fechada.')}
                </p>
                {bloqueio && (
                  <div className="bar-warning" data-testid="bloqueio-fechamento">
                    <strong>
                      {bloqueio.code === 'turno_com_comanda_aberta'
                        ? t('bar.openTabsBlock', '{{count}} comanda(s) aberta(s):', { count: bloqueio.quantidade })
                        : t('bar.openCashboxesBlock', '{{count}} caixa(s) aberto(s):', { count: bloqueio.quantidade })}
                    </strong>
                    <ul>
                      {bloqueio.code === 'turno_com_comanda_aberta'
                        ? (bloqueio.comandas || []).map((c) => (
                          <li key={c.id}>#{c.number} · {c.player_name || '—'} · {formatCurrency(c.balance_due || 0)}</li>
                        ))
                        : (bloqueio.caixas || []).map((nome, i) => <li key={i}>{nome || '—'}</li>)}
                    </ul>
                  </div>
                )}
                <div className="form-group">
                  <label htmlFor="bsd-notes">{t('cash.notes', 'Observação')}</label>
                  <input id="bsd-notes" type="text" value={notes} onChange={(e) => setNotes(e.target.value)} />
                </div>
                <div className="modal-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setClosing(false)} disabled={submitting}>
                    {t('common.cancel', 'Cancelar')}
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={submitting}>
                    {submitting ? t('common.saving', 'Salvando...') : t('bar.closeShift', 'Encerrar')}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}
      </main>
    </div>
  );
};

export default BarShiftDetail;
