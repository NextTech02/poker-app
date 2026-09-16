import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import Sidebar from '../components/Sidebar';
import EmptyState from '../components/EmptyState';
import { SkeletonTableRow } from '../components/SkeletonLoader';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useBarShift } from '../contexts/BarShiftContext';
import { usePermissions } from '../contexts/PermissionContext';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { primeiroDiaDoMes, hojeLocal } from '../utils/datasLocais';
import './CashFloor.css';
import './Bar.css';

/**
 * Os TURNOS do bar — o histórico, a abertura e o fechamento.
 *
 * FECHAR O TURNO CONGELA os números. A recusa com comanda aberta é a regra do
 * cliente (comanda não vira dívida) e a recusa com gaveta aberta é o que
 * mantém o demonstrativo limpo — a tela mostra quem está segurando o
 * fechamento, para o gerente resolver no balcão.
 */
const BarShifts = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();
  const { shift: aberto, reload: reloadShift } = useBarShift();
  const { hasPermission } = usePermissions();

  const [shifts, setShifts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState({ from: primeiroDiaDoMes(), to: hojeLocal() });
  const [closing, setClosing] = useState(null);
  const [opening, setOpening] = useState(false);
  const [openForm, setOpenForm] = useState({ business_date: hojeLocal(), label: '' });
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [bloqueio, setBloqueio] = useState(null); // recusa do fechamento

  useEscapeKey(!!closing || opening, () => { if (!submitting) { setClosing(null); setOpening(false); } });

  const load = useCallback(async () => {
    try {
      const res = await api.get('/bar/shifts', {
        params: { date_from: range.from, date_to: range.to },
        _silentError: true,
      });
      setShifts(res.data || []);
    } catch {
      setShifts([]);
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const abrir = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.post('/bar/shifts', { business_date: openForm.business_date, label: openForm.label || null });
      toast.success(t('bar.shiftOpened', 'Turno aberto'));
      setOpening(false);
      await load();
      await reloadShift();
    } catch (err) {
      toast.error(err.userMessage || t('bar.shiftOpenError', 'Não foi possível abrir o turno'));
    } finally {
      setSubmitting(false);
    }
  };

  const fechar = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    setBloqueio(null);
    try {
      await api.post(`/bar/shifts/${closing.id}/close`, { notes: notes || null });
      toast.success(t('bar.shiftClosed', 'Turno encerrado'));
      setClosing(null);
      setNotes('');
      await load();
      await reloadShift();
    } catch (err) {
      const detalhe = err?.response?.data?.detail;
      // As recusas vêm com a LISTA do que segura o fechamento: é isso que o
      // gerente precisa para resolver no balcão, não só a frase.
      if (detalhe?.code === 'turno_com_comanda_aberta' || detalhe?.code === 'turno_com_caixa_aberto') {
        setBloqueio(detalhe);
      }
      toast.error(err.userMessage || t('bar.shiftCloseError', 'Não foi possível encerrar o turno'));
    } finally {
      setSubmitting(false);
    }
  };

  const totalLiquido = useMemo(() => shifts.reduce((s, d) => s + (d.total_net || 0), 0), [shifts]);

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>{t('bar.shifts', 'Turnos')}</h1>
            <p className="subtitle">
              {t('bar.shiftsSubtitle', 'Vendas do bar por turno. O período abaixo somou {{value}} em comandas.', {
                value: formatCurrency(totalLiquido),
              })}
            </p>
          </div>
          {!aberto && hasPermission('bar.shift') && (
            <button type="button" className="btn btn-primary"
                    onClick={() => { setOpenForm({ business_date: hojeLocal(), label: '' }); setOpening(true); }}>
              {t('bar.openShift', 'Abrir turno')}
            </button>
          )}
        </div>

        <div className="bar-filters">
          <div className="form-group">
            <label htmlFor="bs-from">{t('common.from', 'De')}</label>
            <input id="bs-from" type="date" value={range.from}
                   onChange={(e) => setRange({ ...range, from: e.target.value })} />
          </div>
          <div className="form-group">
            <label htmlFor="bs-to">{t('common.to', 'Até')}</label>
            <input id="bs-to" type="date" value={range.to}
                   onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </div>
        </div>

        {loading ? (
          <table className="data-table"><tbody>
            <SkeletonTableRow cols={7} /><SkeletonTableRow cols={7} />
          </tbody></table>
        ) : shifts.length === 0 ? (
          <EmptyState
            icon={null}
            title={t('bar.noShifts', 'Nenhum turno no período')}
            subtitle={t('bar.noShiftsHint', 'Abra o turno para começar a lançar comandas.')}
            ctaLabel={!aberto && hasPermission('bar.shift') ? t('bar.openShift', 'Abrir turno') : undefined}
            onCta={!aberto && hasPermission('bar.shift') ? () => setOpening(true) : undefined}
          />
        ) : (
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('bar.businessDate', 'Data')}</th>
                  <th>{t('common.status', 'Status')}</th>
                  <th>{t('bar.netSales', 'Vendas')}</th>
                  <th>{t('bar.paid', 'Recebido')}</th>
                  <th>{t('bar.discounts', 'Descontos')}</th>
                  <th>{t('bar.margin', 'Margem')}</th>
                  <th>{t('bar.tabsCount', 'Comandas')}</th>
                  <th aria-label={t('common.actions', 'Ações')} />
                </tr>
              </thead>
              <tbody>
                {shifts.map((s) => (
                  <tr key={s.id} className={s.status === 'open' ? 'bar-open' : ''}>
                    <td>
                      <strong>{s.business_date}</strong>
                      {s.label && <div className="bar-muted">{s.label}</div>}
                    </td>
                    <td>
                      <span className={`bar-status-${s.status}`}>
                        {s.status === 'open' ? t('bar.statusOpen', 'Aberto') : t('bar.statusClosed', 'Fechado')}
                      </span>
                    </td>
                    <td className="bar-revenue">{s.total_net != null ? formatCurrency(s.total_net) : '—'}</td>
                    <td>{s.total_paid != null ? formatCurrency(s.total_paid) : '—'}</td>
                    <td>{s.total_discounts != null ? formatCurrency((s.total_discounts || 0) + (s.total_courtesy || 0)) : '—'}</td>
                    <td>{s.total_net != null ? formatCurrency((s.total_net || 0) - (s.total_cogs || 0)) : '—'}</td>
                    <td>{s.tabs_count != null ? s.tabs_count : '—'}</td>
                    <td className="bar-actions">
                      <Link className="btn btn-secondary btn-sm" to={`/bar/turnos/${s.id}`}>
                        {t('common.details', 'Detalhes')}
                      </Link>
                      {s.status === 'open' && hasPermission('bar.shift') && (
                        <button type="button" className="btn btn-secondary btn-sm"
                                onClick={() => { setNotes(''); setBloqueio(null); setClosing(s); }}>
                          {t('bar.closeShift', 'Encerrar')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="bar-muted" style={{ marginTop: '0.9rem' }}>
              {t('bar.openShiftNote', 'Os totais aparecem quando o turno é encerrado — enquanto ele está aberto, o número ao vivo fica no detalhe.')}
            </p>
          </div>
        )}

        {opening && (
          <div className="modal-overlay"
               onClick={(e) => { if (e.target === e.currentTarget && !submitting) setOpening(false); }}>
            <div className="modal" role="dialog" aria-modal="true">
              <h2>{t('bar.openShift', 'Abrir turno')}</h2>
              <form onSubmit={abrir}>
                <div className="form-group">
                  <label htmlFor="bo-date">{t('bar.businessDate', 'Data')}</label>
                  <input id="bo-date" type="date" required value={openForm.business_date}
                         onChange={(e) => setOpenForm({ ...openForm, business_date: e.target.value })} />
                  <small className="form-hint">
                    {t('bar.businessDateHint', 'A data do turno. A noite que vira meia-noite é um turno só.')}
                  </small>
                </div>
                <div className="form-group">
                  <label htmlFor="bo-label">{t('bar.shiftLabel', 'Rótulo')}</label>
                  <input id="bo-label" type="text" value={openForm.label}
                         placeholder={t('bar.shiftLabelPlaceholder', 'Noite, Tarde...')}
                         onChange={(e) => setOpenForm({ ...openForm, label: e.target.value })} />
                </div>
                <div className="modal-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setOpening(false)} disabled={submitting}>
                    {t('common.cancel', 'Cancelar')}
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={submitting}>
                    {submitting ? t('common.saving', 'Salvando...') : t('bar.openShift', 'Abrir turno')}
                  </button>
                </div>
              </form>
            </div>
          </div>
        )}

        {closing && (
          <div className="modal-overlay"
               onClick={(e) => { if (e.target === e.currentTarget && !submitting) setClosing(null); }}>
            <div className="modal" role="dialog" aria-modal="true">
              <h2>{t('bar.closeShiftTitle', 'Encerrar o turno de {{date}}', { date: closing.business_date })}</h2>
              <form onSubmit={fechar}>
                <p className="bar-note">
                  {t('bar.closeShiftHint', 'As vendas do turno serão CONGELADAS. Toda comanda precisa estar quitada e toda gaveta do turno, fechada.')}
                </p>
                {bloqueio && (
                  <div className="bar-warning" data-testid="bloqueio-fechamento">
                    {bloqueio.code === 'turno_com_comanda_aberta' ? (
                      <>
                        <strong>{t('bar.openTabsBlock', '{{count}} comanda(s) aberta(s):', { count: bloqueio.quantidade })}</strong>
                        <ul>
                          {(bloqueio.comandas || []).map((c) => (
                            <li key={c.id}>
                              #{c.number} · {c.player_name || '—'} · {formatCurrency(c.balance_due || 0)}
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : (
                      <>
                        <strong>{t('bar.openCashboxesBlock', '{{count}} caixa(s) aberto(s):', { count: bloqueio.quantidade })}</strong>
                        <ul>
                          {(bloqueio.caixas || []).map((nome, i) => <li key={i}>{nome || '—'}</li>)}
                        </ul>
                      </>
                    )}
                  </div>
                )}
                <div className="form-group">
                  <label htmlFor="bs-notes">{t('cash.notes', 'Observação')}</label>
                  <input id="bs-notes" type="text" value={notes} onChange={(e) => setNotes(e.target.value)} />
                </div>
                <div className="modal-actions">
                  <button type="button" className="btn btn-secondary" onClick={() => setClosing(null)} disabled={submitting}>
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

export default BarShifts;
