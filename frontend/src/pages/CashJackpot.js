import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import Sidebar from '../components/Sidebar';
import EmptyState from '../components/EmptyState';
import PlayerSelect from '../components/PlayerSelect';
import { SkeletonBlock } from '../components/SkeletonLoader';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useCashDay } from '../contexts/CashDayContext';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { avisarQueOCaixaMudou } from '../utils/eventosDoCaixa';
import './CashFloor.css';
import './CashJackpot.css';

/**
 * O JACKPOT.
 *
 * A tela existe para dizer uma coisa que o número sozinho não diz: este
 * dinheiro NÃO é do clube. É dos jogadores, retido para pagamento futuro — um
 * passivo. Se ele aparecesse junto do faturamento, o dono contabilizaria como
 * lucro algo que vai devolver, e a conta só apareceria no dia em que alguém
 * levasse o prêmio.
 *
 * Pagar SAI DA GAVETA: o operador entrega o dinheiro de verdade, e por isso o
 * pagamento passa pelo caixa e entra na conferência do fim da noite.
 */
const TIPOS = ['bad_beat', 'high_hand', 'promo', 'other'];

const CashJackpot = () => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();
  const { cashDayId, isOpen } = useCashDay();

  const [fund, setFund] = useState(null);
  const [payouts, setPayouts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ player_id: '', amount: '', kind: 'bad_beat', description: '' });

  useEscapeKey(modal, () => { if (!submitting) setModal(false); });

  const load = useCallback(async () => {
    const [f, p] = await Promise.all([
      api.get('/cash-game/jackpot', { _silentError: true }).catch(() => ({ data: null })),
      api.get('/cash-game/jackpot/payouts', { _silentError: true }).catch(() => ({ data: [] })),
    ]);
    setFund(f.data || null);
    setPayouts(p.data || []);
    setLoading(false);
  }, []);

  useEffect(() => { setLoading(true); load(); }, [load]);

  const pagar = async (e) => {
    e.preventDefault();
    if (!form.player_id) {
      toast.warning(t('cash.pickPlayer', 'Escolha o jogador'));
      return;
    }
    setSubmitting(true);
    try {
      await api.post('/cash-game/jackpot/payouts', {
        cash_day_id: cashDayId,
        player_id: form.player_id,
        amount: parseFloat(form.amount),
        kind: form.kind,
        description: form.description || null,
      });
      toast.success(t('cashJackpot.paid', 'Jackpot pago'));
      setModal(false);
      setForm({ player_id: '', amount: '', kind: 'bad_beat', description: '' });
      await load();
      // O pagamento SAI da gaveta: o banner do caixa precisa recarregar.
      avisarQueOCaixaMudou();
    } catch (err) {
      toast.error(err.userMessage || t('cashJackpot.payError', 'Não foi possível pagar o jackpot'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="app-container">
      <Sidebar />
      <main className="main-content">
        <div className="page-header">
          <div>
            <h1>{t('cash.jackpot', 'Jackpot')}</h1>
            <p className="subtitle">
              {t('cashJackpot.subtitle', 'Fundo acumulado com a parcela dos potes. É dinheiro dos jogadores retido para pagamento — não entra no faturamento do clube.')}
            </p>
          </div>
          <button type="button" className="btn btn-primary"
                  onClick={() => setModal(true)}
                  disabled={!isOpen || !(fund?.current_balance > 0)}
                  title={!isOpen
                    ? t('cashJackpot.needDay', 'Abra o dia de operação para pagar')
                    : undefined}>
            {t('cashJackpot.pay', 'Pagar jackpot')}
          </button>
        </div>

        {loading ? (
          <SkeletonBlock height="8rem" />
        ) : (
          <>
            <div className="stats-grid">
              <div className="stat-card cj-fund">
                <span className="stat-label">{t('cashJackpot.balance', 'Acumulado agora')}</span>
                <span className="stat-value">{formatCurrency(fund?.current_balance || 0)}</span>
                {/* A legenda é a razão de a tela existir. */}
                <span className="stat-hint">{t('cashJackpot.liability', 'Passivo — dinheiro dos jogadores')}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">{t('cashJackpot.collected', 'Já arrecadado')}</span>
                <span className="stat-value">{formatCurrency(fund?.total_collected || 0)}</span>
              </div>
              <div className="stat-card">
                <span className="stat-label">{t('cashJackpot.paidTotal', 'Já pago')}</span>
                <span className="stat-value">{formatCurrency(fund?.total_paid || 0)}</span>
              </div>
            </div>

            <h2 className="cj-title">{t('cashJackpot.history', 'Pagamentos')}</h2>
            {payouts.length === 0 ? (
              <EmptyState
                icon={null}
                title={t('cashJackpot.noPayouts', 'Nenhum jackpot pago ainda')}
                subtitle={t('cashJackpot.noPayoutsHint', 'O fundo acumula a cada apuração de mesa e sai quando um prêmio é pago.')}
              />
            ) : (
              <div className="table-container">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>{t('cashJackpot.paidAt', 'Quando')}</th>
                      <th>{t('cash.player', 'Jogador')}</th>
                      <th>{t('cashJackpot.kind', 'Tipo')}</th>
                      <th>{t('cash.amount', 'Valor')}</th>
                      <th>{t('cashJackpot.description', 'Descrição')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {payouts.map((p) => (
                      <tr key={p.id}>
                        <td>{String(p.paid_at || '').slice(0, 10)}</td>
                        <td>{p.player_name || '—'}</td>
                        <td>{t(`cashJackpot.kind_${p.kind}`, p.kind)}</td>
                        <td>{formatCurrency(p.amount)}</td>
                        <td>{p.description || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {modal && (
          <div className="modal-overlay"
               onClick={(e) => { if (e.target === e.currentTarget && !submitting) setModal(false); }}>
            <div className="modal" role="dialog" aria-modal="true">
              <h2>{t('cashJackpot.pay', 'Pagar jackpot')}</h2>
              <form onSubmit={pagar}>
                {/* Sem este aviso o operador pode achar que é só um registro,
                    e não conferir o dinheiro que está entregando. */}
                <p className="ctd-close-hint">
                  {t('cashJackpot.payHint', 'O valor SAI do caixa: entra na conferência do fim da noite como qualquer outra saída. Disponível no fundo: {{saldo}}.', {
                    saldo: formatCurrency(fund?.current_balance || 0),
                  })}
                </p>
                <div className="form-group">
                  <label htmlFor="cj-player">{t('cash.player', 'Jogador')}</label>
                  <PlayerSelect
                    value={form.player_id}
                    onChange={(e) => setForm({ ...form, player_id: e.target.value })}
                    required
                  />
                </div>
                <div className="form-group">
                  <label htmlFor="cj-amount">{t('cash.amount', 'Valor')}</label>
                  <input id="cj-amount" type="number" step="0.01" min="0.01"
                         max={fund?.current_balance || undefined}
                         value={form.amount} required
                         onChange={(e) => setForm({ ...form, amount: e.target.value })} />
                </div>
                <div className="form-group">
                  <label htmlFor="cj-kind">{t('cashJackpot.kind', 'Tipo')}</label>
                  <select id="cj-kind" value={form.kind}
                          onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                    {TIPOS.map((k) => (
                      <option key={k} value={k}>{t(`cashJackpot.kind_${k}`, k)}</option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label htmlFor="cj-desc">{t('cashJackpot.description', 'Descrição')}</label>
                  <input id="cj-desc" type="text" value={form.description}
                         placeholder={t('cashJackpot.descPlaceholder', 'Ex.: Quadra de 8 perdeu para straight flush')}
                         onChange={(e) => setForm({ ...form, description: e.target.value })} />
                </div>
                <div className="modal-actions">
                  <button type="button" className="btn btn-secondary"
                          onClick={() => setModal(false)} disabled={submitting}>
                    {t('common.cancel', 'Cancelar')}
                  </button>
                  <button type="submit" className="btn btn-primary" disabled={submitting}>
                    {submitting ? t('common.saving', 'Salvando...') : t('cashJackpot.pay', 'Pagar jackpot')}
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

export default CashJackpot;
