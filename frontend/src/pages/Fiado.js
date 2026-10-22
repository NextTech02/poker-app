import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import Sidebar from '../components/Sidebar';
import { SkeletonBlock } from '../components/SkeletonLoader';
import EmptyState from '../components/EmptyState';
import ReceberFiadoModal from '../components/fiado/ReceberFiadoModal';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useCashDay } from '../contexts/CashDayContext';
import { useBarShift } from '../contexts/BarShiftContext';
import '../components/fiado/Fiado.css';
import './PlayerDetail.css';

/**
 * FIADO DO CLUBE: quem deve, há quanto tempo, e o que fazer.
 *
 * A lista vem na ordem da cobrança (a dívida mais antiga primeiro). O
 * "abatimento a menor" é o relatório do conluio clássico — o operador paga o
 * cash-out inteiro ao amigo e deixa a dívida de pé —, por isso mostra QUEM
 * abateu menos e o motivo que deu.
 */
const Fiado = () => {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();
  const { cashDayId } = useCashDay() || {};
  const { barShiftId } = useBarShift() || {};
  const ancora = cashDayId ? { cash_day_id: cashDayId } : barShiftId ? { bar_shift_id: barShiftId } : null;

  const [aba, setAba] = useState('devedores');
  const [devedores, setDevedores] = useState(null);
  const [abaixo, setAbaixo] = useState([]);
  const [cfg, setCfg] = useState(null);
  const [salvando, setSalvando] = useState(false);
  const [recebendo, setRecebendo] = useState(null);

  const carregar = useCallback(async () => {
    const [d, a, c] = await Promise.all([
      api.get('/house-credit/debtors').catch(() => ({ data: { rows: [] } })),
      api.get('/house-credit/under-offsets', { _silentError: true }).catch(() => ({ data: [] })),
      api.get('/house-credit/settings', { _silentError: true }).catch(() => ({ data: null })),
    ]);
    setDevedores(d.data);
    setAbaixo(a.data || []);
    setCfg(c.data ? {
      due_days: String(c.data.due_days),
      block_overdue: !!c.data.block_overdue,
      default_limit: String(c.data.default_limit ?? 0),
    } : null);
  }, []);

  useEffect(() => { carregar(); }, [carregar]);

  const salvarConfig = async (e) => {
    e.preventDefault();
    setSalvando(true);
    try {
      await api.put('/house-credit/settings', {
        due_days: parseInt(cfg.due_days, 10),
        block_overdue: !!cfg.block_overdue,
        default_limit: parseFloat(cfg.default_limit || 0),
      });
      toast.success(t('fiado.settingsSaved', 'Configuração salva'));
      await carregar();
    } catch (err) {
      toast.error(err.userMessage || t('fiado.saveError', 'Não foi possível salvar'));
    } finally {
      setSalvando(false);
    }
  };

  const whatsapp = (fone) => {
    const digitos = (fone || '').replace(/\D/g, '');
    return digitos ? `https://wa.me/${digitos}` : null;
  };

  const quando = (iso) => (iso ? new Date(iso).toLocaleDateString(i18n.language) : '—');

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>{t('fiado.pageTitle', 'Fiado')}</h1>
            <p className="subtitle">
              {t('fiado.pageSubtitle', 'O que os jogadores devem ao clube. Fiado é recebível, não receita: só vira dinheiro quando volta.')}
            </p>
          </div>
        </div>

        <div className="fiado-tabs" role="tablist">
          {[
            ['devedores', t('fiado.tabDebtors', 'Devedores')],
            ['abaixo', t('fiado.tabUnderOffset', 'Abatimento a menor')],
            ['config', t('fiado.tabSettings', 'Configuração')],
          ].map(([chave, rotulo]) => (
            <button
              key={chave} type="button" role="tab" aria-selected={aba === chave}
              className={`btn btn-sm ${aba === chave ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => setAba(chave)}
            >
              {rotulo}
            </button>
          ))}
        </div>

        {devedores === null ? (
          <SkeletonBlock height="10rem" />
        ) : aba === 'devedores' ? (
          <>
            <div className="fiado-page-totals">
              <div className="pd-finance-box">
                <span className="pd-finance-label">{t('fiado.totalOpen', 'Total em aberto')}</span>
                <span className="pd-finance-value">{formatCurrency(devedores.total_open || 0)}</span>
              </div>
              <div className="pd-finance-box">
                <span className="pd-finance-label">
                  {t('fiado.totalOverdue', 'Vencido (mais de {{days}} dias)', { days: devedores.due_days })}
                </span>
                <span className="pd-finance-value pd-negative">{formatCurrency(devedores.total_overdue || 0)}</span>
              </div>
              <div className="pd-finance-box">
                <span className="pd-finance-label">{t('fiado.debtorsCount', 'Jogadores devendo')}</span>
                <span className="pd-finance-value">
                  {devedores.count}{devedores.overdue_count ? ` (${devedores.overdue_count} ${t('fiado.overdueWord', 'vencidos')})` : ''}
                </span>
              </div>
            </div>
            {devedores.rows.length === 0 ? (
              <EmptyState title={t('fiado.noDebtors', 'Ninguém deve fiado.')} />
            ) : (
              <div className="pd-table-wrap">
                <table className="pd-table">
                  <thead>
                    <tr>
                      <th>{t('cash.player', 'Jogador')}</th>
                      <th className="pd-num">{t('fiado.balance', 'Deve')}</th>
                      <th className="pd-num">{t('fiado.limit', 'Limite')}</th>
                      <th>{t('fiado.since', 'Em aberto desde')}</th>
                      <th>{t('fiado.contact', 'Contato')}</th>
                      <th aria-label={t('fiado.colActions', 'Ações')} />
                    </tr>
                  </thead>
                  <tbody>
                    {devedores.rows.map((d) => (
                      <tr key={d.player_id} className={d.overdue ? 'fiado-overdue-row' : ''}>
                        <td data-label={t('cash.player', 'Jogador')}>
                          <Link to={`/jogadores/${d.player_id}`}>{d.player_name}</Link>
                          {d.nickname && <small className="fiado-reason"> ({d.nickname})</small>}
                        </td>
                        <td className="pd-num" data-label={t('fiado.balance', 'Deve')}>{formatCurrency(d.balance)}</td>
                        <td className="pd-num" data-label={t('fiado.limit', 'Limite')}>{formatCurrency(d.credit_limit)}</td>
                        <td data-label={t('fiado.since', 'Em aberto desde')}>
                          {quando(d.oldest_open_at)}
                          {d.days_open !== null && d.days_open !== undefined && (
                            <small className="fiado-reason">
                              {' · '}{t('fiado.days', '{{count}} dias', { count: d.days_open })}
                              {d.overdue && ` · ${t('fiado.overdueTag', 'vencido')}`}
                            </small>
                          )}
                        </td>
                        <td data-label={t('fiado.contact', 'Contato')}>
                          {whatsapp(d.phone)
                            ? <a href={whatsapp(d.phone)} target="_blank" rel="noopener noreferrer">{d.phone}</a>
                            : (d.phone || '—')}
                        </td>
                        <td>
                          <button
                            type="button" className="btn btn-primary btn-sm"
                            onClick={() => setRecebendo(d)} disabled={!ancora}
                            title={!ancora ? t('fiado.noDrawerHere', 'Para receber, abra o dia do cash (ou o turno do bar) e a sua gaveta.') : undefined}
                          >
                            {t('fiado.receive', 'Receber')}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : aba === 'abaixo' ? (
          abaixo.length === 0 ? (
            <EmptyState title={t('fiado.noUnderOffset', 'Nenhum cash-out com abatimento menor que a dívida.')} />
          ) : (
            <div className="pd-table-wrap">
              <table className="pd-table">
                <thead>
                  <tr>
                    <th>{t('playerDetail.colDate', 'Data')}</th>
                    <th>{t('cash.player', 'Jogador')}</th>
                    <th>{t('fiado.operator', 'Operador')}</th>
                    <th className="pd-num">{t('fiado.chips', 'Fichas')}</th>
                    <th className="pd-num">{t('fiado.expected', 'Proposto')}</th>
                    <th className="pd-num">{t('fiado.settled', 'Abatido')}</th>
                    <th>{t('fiado.reason', 'Motivo')}</th>
                  </tr>
                </thead>
                <tbody>
                  {abaixo.map((r) => (
                    <tr key={r.cash_transaction_id}>
                      <td data-label={t('playerDetail.colDate', 'Data')}>{new Date(r.created_at).toLocaleString(i18n.language)}</td>
                      <td data-label={t('cash.player', 'Jogador')}>
                        {r.player_id ? <Link to={`/jogadores/${r.player_id}`}>{r.player_name}</Link> : '—'}
                      </td>
                      <td data-label={t('fiado.operator', 'Operador')}>{r.operator_name || '—'}</td>
                      <td className="pd-num" data-label={t('fiado.chips', 'Fichas')}>{formatCurrency(r.chips_amount)}</td>
                      <td className="pd-num" data-label={t('fiado.expected', 'Proposto')}>{formatCurrency(r.expected)}</td>
                      <td className="pd-num" data-label={t('fiado.settled', 'Abatido')}>{formatCurrency(r.settled)}</td>
                      <td data-label={t('fiado.reason', 'Motivo')}>{r.reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : (
          cfg && (
            <form className="pd-history-card" onSubmit={salvarConfig}>
              <div className="form-group">
                <label htmlFor="fiado-prazo">{t('fiado.dueDays', 'Prazo para pagar (dias)')}</label>
                <input id="fiado-prazo" type="number" min="1" max="3650" required
                       value={cfg.due_days} onChange={(e) => setCfg({ ...cfg, due_days: e.target.value })} />
              </div>
              <label className="fiado-check">
                <input type="checkbox" checked={cfg.block_overdue}
                       onChange={(e) => setCfg({ ...cfg, block_overdue: e.target.checked })} />
                {t('fiado.blockOverdue', 'Bloquear venda nova no fiado para quem tem dívida vencida')}
              </label>
              <div className="form-group">
                <label htmlFor="fiado-limite-padrao">{t('fiado.defaultLimit', 'Limite sugerido ao liberar um jogador')}</label>
                <input id="fiado-limite-padrao" type="number" min="0" step="0.01"
                       value={cfg.default_limit} onChange={(e) => setCfg({ ...cfg, default_limit: e.target.value })} />
              </div>
              <p className="form-hint">
                {t('fiado.legalHint', 'Atenção: em vários países dívida de jogo não é cobrável na Justiça. Confirme as regras com o seu advogado.')}
              </p>
              <div className="modal-actions">
                <button type="submit" className="btn btn-primary" disabled={salvando}>
                  {salvando ? t('common.saving', 'Salvando...') : t('common.save', 'Salvar')}
                </button>
              </div>
            </form>
          )
        )}

        {recebendo && (
          <ReceberFiadoModal
            player={{ id: recebendo.player_id, name: recebendo.player_name }}
            conta={recebendo}
            ancora={ancora}
            onClose={() => setRecebendo(null)}
            onDone={() => carregar()}
          />
        )}
      </main>
    </div>
  );
};

export default Fiado;
