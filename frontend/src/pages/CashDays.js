import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import Sidebar from '../components/Sidebar';
import EmptyState from '../components/EmptyState';
import { SkeletonTableRow } from '../components/SkeletonLoader';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useCashDay } from '../contexts/CashDayContext';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { primeiroDiaDoMes, hojeLocal } from '../utils/datasLocais';
import './CashFloor.css';
import './CashDays.css';

/**
 * Os DIAS de operação — o histórico e o fechamento.
 *
 * É a tela que responde a pergunta que motivou o módulo: quanto faturamos em
 * cada dia? Por isso a lista é uma tabela por data, com o rake em destaque, e
 * não um relatório agregado do mês.
 *
 * FECHAR O DIA CONGELA os números. A recusa com mesa aberta não é burocracia:
 * uma mesa ainda vai receber apuração de rake, e o total congelado nasceria
 * errado sem nunca mais ser recalculado.
 */
const CashDays = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();
  const { reload: reloadDay } = useCashDay();

  const [days, setDays] = useState([]);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState({ from: primeiroDiaDoMes(), to: hojeLocal() });
  const [closing, setClosing] = useState(null);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEscapeKey(!!closing, () => { if (!submitting) setClosing(null); });

  const load = useCallback(async () => {
    try {
      const res = await api.get('/cash-game/days', {
        params: { date_from: range.from, date_to: range.to },
        _silentError: true,
      });
      setDays(res.data || []);
    } catch {
      setDays([]);
    } finally {
      setLoading(false);
    }
  }, [range.from, range.to]);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const fechar = async (e) => {
    e.preventDefault();
    setSubmitting(true);
    try {
      await api.post(`/cash-game/days/${closing.id}/close`, { notes: notes || null });
      toast.success(t('cash.dayClosed', 'Dia encerrado'));
      setClosing(null);
      setNotes('');
      await load();
      await reloadDay();
    } catch (err) {
      toast.error(err.userMessage || t('cash.dayCloseError', 'Não foi possível encerrar o dia'));
    } finally {
      setSubmitting(false);
    }
  };

  // Rake apurado × giro: dois números diferentes, e só o primeiro é receita.
  const totalRake = days.reduce((s, d) => s + (d.total_rake || 0), 0);

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>{t('cash.days', 'Dias de operação')}</h1>
            <p className="subtitle">
              {t('cash.daysSubtitle', 'Faturamento por dia. O período abaixo somou {{value}} de rake.', {
                value: formatCurrency(totalRake),
              })}
            </p>
          </div>
        </div>

        <div className="cd-filters">
          <div className="form-group">
            <label htmlFor="cd-from">{t('common.from', 'De')}</label>
            <input id="cd-from" type="date" value={range.from}
                   onChange={(e) => setRange({ ...range, from: e.target.value })} />
          </div>
          <div className="form-group">
            <label htmlFor="cd-to">{t('common.to', 'Até')}</label>
            <input id="cd-to" type="date" value={range.to}
                   onChange={(e) => setRange({ ...range, to: e.target.value })} />
          </div>
        </div>

        {loading ? (
          <table className="data-table">
            <tbody>
              <SkeletonTableRow cols={7} />
              <SkeletonTableRow cols={7} />
              <SkeletonTableRow cols={7} />
            </tbody>
          </table>
        ) : days.length === 0 ? (
          <EmptyState
            icon={null}
            title={t('cash.noDays', 'Nenhum dia no período')}
            subtitle={t('cash.noDaysHint', 'Abra o dia pelo Salão para começar a operar.')}
          />
        ) : (
          <div className="table-container">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('cash.businessDate', 'Data')}</th>
                  <th>{t('common.status', 'Status')}</th>
                  {/* Faturamento primeiro: é a coluna que a tela existe para mostrar. */}
                  <th>{t('cash.revenue', 'Faturamento (rake)')}</th>
                  <th>{t('cash.jackpot', 'Jackpot')}</th>
                  <th>{t('cash.turnover', 'Giro (buy-ins)')}</th>
                  <th>{t('cash.paid', 'Cash-outs')}</th>
                  <th>{t('cash.tablesAndPlayers', 'Mesas / jogadores')}</th>
                  <th aria-label={t('common.actions', 'Ações')} />
                </tr>
              </thead>
              <tbody>
                {days.map((d) => (
                  <tr key={d.id} className={d.status === 'open' ? 'cd-open' : ''}>
                    <td>
                      <strong>{d.business_date}</strong>
                      {d.label && <div className="cd-label">{d.label}</div>}
                    </td>
                    <td>
                      <span className={`status-badge ${d.status === 'open' ? 'active' : 'completed'}`}>
                        {d.status === 'open'
                          ? t('cash.statusOpen', 'Aberto')
                          : t('cash.statusClosed', 'Fechado')}
                      </span>
                    </td>
                    <td className="cd-revenue">
                      {d.total_rake != null ? formatCurrency(d.total_rake) : '—'}
                    </td>
                    <td>{d.total_jackpot != null ? formatCurrency(d.total_jackpot) : '—'}</td>
                    <td>{d.total_buy_ins != null ? formatCurrency(d.total_buy_ins) : '—'}</td>
                    <td>{d.total_cash_outs != null ? formatCurrency(d.total_cash_outs) : '—'}</td>
                    <td>
                      {d.tables_count != null ? `${d.tables_count} / ${d.players_count ?? 0}` : '—'}
                    </td>
                    <td>
                      {d.status === 'open' && (
                        <button type="button" className="btn btn-secondary btn-sm"
                                onClick={() => { setNotes(''); setClosing(d); }}>
                          {t('cash.closeDay', 'Encerrar')}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Enquanto o dia está aberto os totais são NULOS de propósito: um
                total parcial gravado viraria um segundo número para a mesma
                pergunta, e ninguém saberia qual vale. */}
            <p className="cd-note">
              {t('cash.openDayNote', 'Os totais aparecem quando o dia é encerrado — enquanto ele está aberto, o número ao vivo fica no Salão.')}
            </p>
          </div>
        )}

        {closing && (
          <div className="modal-overlay"
               onClick={(e) => { if (e.target === e.currentTarget && !submitting) setClosing(null); }}>
            <div className="modal" role="dialog" aria-modal="true">
              <h2>{t('cash.closeDayTitle', 'Encerrar o dia {{date}}', { date: closing.business_date })}</h2>
              <form onSubmit={fechar}>
                <p className="ctd-close-hint">
                  {t('cash.closeDayHint', 'O faturamento do dia será CONGELADO. Todas as mesas precisam estar fechadas — é a última apuração de cada uma que fecha a conta.')}
                </p>
                <div className="form-group">
                  <label htmlFor="cd-notes">{t('cash.notes', 'Observação')}</label>
                  <input id="cd-notes" type="text" value={notes}
                         onChange={(e) => setNotes(e.target.value)} />
                </div>
                <div className="modal-actions">
                  <button type="button" className="btn btn-secondary"
                          onClick={() => setClosing(null)} disabled={submitting}>
                    {t('common.cancel', 'Cancelar')}
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={submitting}>
                    {submitting ? t('common.saving', 'Salvando...') : t('cash.closeDay', 'Encerrar')}
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

export default CashDays;
