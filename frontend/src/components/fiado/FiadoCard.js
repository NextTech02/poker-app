import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../config/api';
import { useToast } from '../../contexts/ToastContext';
import { useCurrency } from '../../contexts/CurrencyContext';
import { usePermissions } from '../../contexts/PermissionContext';
import { useCashDay } from '../../contexts/CashDayContext';
import { useBarShift } from '../../contexts/BarShiftContext';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import ReceberFiadoModal from './ReceberFiadoModal';
import { buscarContaFiado } from '../../utils/fiado';
import './Fiado.css';

const TIPOS = {
  charge: ['fiado.typeCharge', 'Fichas no fiado'],
  charge_reversal: ['fiado.typeChargeReversal', 'Estorno de venda fiada'],
  cashout_offset: ['fiado.typeCashoutOffset', 'Abatido no cash-out'],
  payment: ['fiado.typePayment', 'Pagamento recebido'],
  payment_reversal: ['fiado.typePaymentReversal', 'Estorno de pagamento'],
  write_off: ['fiado.typeWriteOff', 'Baixa'],
  prize_offset: ['fiado.typePrizeOffset', 'Descontado do prêmio'],
};

/**
 * O FIADO do jogador na ficha dele: quanto deve, até quanto pode levar, há
 * quanto tempo a dívida está aberta, o extrato — e, para o gerente, liberar,
 * mudar o limite, estornar um recebimento e dar baixa.
 *
 * Receber cai na gaveta do módulo em que a pessoa está (o dia do cash ou o
 * turno do bar). Fora deles não há gaveta, e o botão explica o porquê.
 */
const FiadoCard = ({ playerId, playerName }) => {
  const { t, i18n } = useTranslation();
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();
  const { hasPermission } = usePermissions();
  const { cashDayId } = useCashDay() || {};
  const { barShiftId } = useBarShift() || {};
  const gerente = hasPermission('fiado.manage');

  const [conta, setConta] = useState(null);
  const [extrato, setExtrato] = useState([]);
  const [modal, setModal] = useState(null); // 'limite' | 'receber' | 'baixa' | {estornar: entry}
  const [form, setForm] = useState({});
  const [enviando, setEnviando] = useState(false);

  const ancora = cashDayId ? { cash_day_id: cashDayId } : barShiftId ? { bar_shift_id: barShiftId } : null;

  const carregar = useCallback(async () => {
    const [c, e] = await Promise.all([
      buscarContaFiado(playerId),
      api.get(`/house-credit/players/${playerId}/entries`, { _silentError: true }).catch(() => ({ data: [] })),
    ]);
    setConta(c);
    setExtrato(e.data || []);
  }, [playerId]);

  useEffect(() => { carregar(); }, [carregar]);
  useEscapeKey(!!modal && modal !== 'receber', () => { if (!enviando) setModal(null); });

  // Sem conta e sem poder liberar: não há o que mostrar.
  if (!conta || (!conta.exists && !gerente)) return null;

  const abrir = (qual) => {
    setForm({
      enabled: conta.exists ? conta.enabled : true,
      credit_limit: String(conta.exists ? conta.credit_limit : ''),
      notes: conta.notes || '',
      amount: String(conta.balance || ''),
      reason: '',
    });
    setModal(qual);
  };

  const enviar = async (fn, sucesso) => {
    setEnviando(true);
    try {
      await fn();
      toast.success(sucesso);
      setModal(null);
      await carregar();
    } catch (err) {
      toast.error(err.userMessage || t('fiado.saveError', 'Não foi possível salvar'));
    } finally {
      setEnviando(false);
    }
  };

  const salvarLimite = (e) => {
    e.preventDefault();
    enviar(() => api.put(`/house-credit/players/${playerId}`, {
      enabled: !!form.enabled,
      credit_limit: parseFloat(form.credit_limit || 0),
      notes: form.notes || null,
    }), t('fiado.limitSaved', 'Fiado atualizado'));
  };

  const darBaixa = (e) => {
    e.preventDefault();
    enviar(() => api.post(`/house-credit/players/${playerId}/write-offs`, {
      amount: parseFloat(form.amount || 0),
      reason: form.reason,
    }), t('fiado.writtenOff', 'Baixa registrada'));
  };

  const estornar = (e) => {
    e.preventDefault();
    enviar(() => api.post(`/house-credit/entries/${modal.estornar.id}/reverse`, { reason: form.reason }),
      t('fiado.reversed', 'Recebimento estornado'));
  };

  const quando = (iso) => (iso ? new Date(iso).toLocaleString(i18n.language) : '—');
  const deve = Number(conta.balance || 0);

  return (
    <div className="pd-history-card fiado-card">
      <div className="pd-history-header">
        <h2>{t('fiado.title', 'Fiado')}</h2>
        <span className={`fiado-status ${!conta.enabled ? 'off' : conta.blocked ? 'blocked' : 'on'}`}>
          {!conta.exists || !conta.enabled
            ? t('fiado.statusOff', 'Não liberado')
            : conta.blocked
              ? t('fiado.statusBlocked', 'Bloqueado (vencido)')
              : t('fiado.statusOn', 'Liberado')}
        </span>
      </div>

      <div className="pd-finance fiado-numbers">
        <div className="pd-finance-box">
          <span className="pd-finance-label">{t('fiado.balance', 'Deve')}</span>
          <span className={`pd-finance-value ${deve > 0 ? 'pd-negative' : ''}`}>{formatCurrency(deve)}</span>
        </div>
        <div className="pd-finance-box">
          <span className="pd-finance-label">{t('fiado.limit', 'Limite')}</span>
          <span className="pd-finance-value">{formatCurrency(conta.credit_limit || 0)}</span>
        </div>
        <div className="pd-finance-box">
          <span className="pd-finance-label">{t('fiado.availableShort', 'Disponível')}</span>
          <span className="pd-finance-value">{formatCurrency(conta.available || 0)}</span>
        </div>
        {conta.days_open !== null && conta.days_open !== undefined && (
          <div className="pd-finance-box">
            <span className="pd-finance-label">{t('fiado.daysOpen', 'Em aberto há')}</span>
            <span className={`pd-finance-value ${conta.overdue ? 'pd-negative' : ''}`}>
              {t('fiado.days', '{{count}} dias', { count: conta.days_open })}
            </span>
          </div>
        )}
      </div>

      <div className="fiado-actions">
        {deve > 0 && (
          <button
            type="button" className="btn btn-primary btn-sm"
            onClick={() => setModal('receber')} disabled={!ancora}
            title={!ancora ? t('fiado.noDrawerHere', 'Para receber, abra o dia do cash (ou o turno do bar) e a sua gaveta.') : undefined}
          >
            {t('fiado.receive', 'Receber')}
          </button>
        )}
        {gerente && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => abrir('limite')}>
            {conta.exists ? t('fiado.editLimit', 'Liberar / limite') : t('fiado.enable', 'Liberar fiado')}
          </button>
        )}
        {gerente && deve > 0 && (
          <button type="button" className="btn btn-danger btn-sm" onClick={() => abrir('baixa')}>
            {t('fiado.writeOff', 'Dar baixa')}
          </button>
        )}
      </div>

      {extrato.length > 0 && (
        <div className="pd-table-wrap">
          <table className="pd-table">
            <thead>
              <tr>
                <th>{t('playerDetail.colDate', 'Data')}</th>
                <th>{t('fiado.colType', 'Lançamento')}</th>
                <th className="pd-num">{t('fiado.colAmount', 'Valor')}</th>
                <th className="pd-num">{t('fiado.colBalance', 'Saldo')}</th>
                <th>{t('fiado.colBy', 'Por')}</th>
                <th aria-label={t('fiado.colActions', 'Ações')} />
              </tr>
            </thead>
            <tbody>
              {extrato.map((l) => {
                const [chave, padrao] = TIPOS[l.type] || [`fiado.type_${l.type}`, l.type];
                return (
                  <tr key={l.id}>
                    <td data-label={t('playerDetail.colDate', 'Data')}>{quando(l.created_at)}</td>
                    <td data-label={t('fiado.colType', 'Lançamento')}>
                      {t(chave, padrao)}
                      {l.reason && <small className="fiado-reason"> — {l.reason}</small>}
                    </td>
                    <td className={`pd-num ${l.signed_amount > 0 ? 'pd-negative' : 'pd-positive'}`} data-label={t('fiado.colAmount', 'Valor')}>
                      {l.signed_amount > 0 ? '+' : '−'}{formatCurrency(Math.abs(l.signed_amount || l.amount))}
                    </td>
                    <td className="pd-num" data-label={t('fiado.colBalance', 'Saldo')}>{formatCurrency(l.balance_after || 0)}</td>
                    <td data-label={t('fiado.colBy', 'Por')}>{l.created_by_name || '—'}</td>
                    <td>
                      {gerente && l.type === 'payment' && !l.reversed && (
                        <button
                          type="button" className="btn btn-secondary btn-sm"
                          onClick={() => { setForm({ reason: '' }); setModal({ estornar: l }); }}
                        >
                          {t('fiado.reverse', 'Estornar')}
                        </button>
                      )}
                      {l.type === 'payment' && l.reversed && (
                        <small className="fiado-reason">{t('fiado.reversedTag', 'estornado')}</small>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {modal === 'receber' && (
        <ReceberFiadoModal
          player={{ id: playerId, name: playerName }}
          conta={conta}
          ancora={ancora}
          onClose={() => setModal(null)}
          onDone={() => carregar()}
        />
      )}

      {modal && modal !== 'receber' && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !enviando) setModal(null); }}>
          <div className="modal" role="dialog" aria-modal="true">
            {modal === 'limite' && (
              <form onSubmit={salvarLimite}>
                <h2>{t('fiado.editLimitTitle', 'Fiado de {{name}}', { name: playerName })}</h2>
                <label className="fiado-check">
                  <input
                    type="checkbox" checked={!!form.enabled}
                    onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                  />
                  {t('fiado.enabledLabel', 'Fiado liberado para este jogador')}
                </label>
                <div className="form-group">
                  <label htmlFor="fiado-limite">{t('fiado.limit', 'Limite')}</label>
                  <input
                    id="fiado-limite" type="number" step="0.01" min="0" required
                    value={form.credit_limit}
                    onChange={(e) => setForm({ ...form, credit_limit: e.target.value })}
                  />
                  <small className="form-hint">
                    {t('fiado.limitHint', 'O máximo que o jogador pode dever ao clube. Baixar o limite não cobra nada: só impede venda nova acima dele.')}
                  </small>
                </div>
                <div className="form-group">
                  <label htmlFor="fiado-notas">{t('cash.notes', 'Observação')}</label>
                  <input id="fiado-notas" type="text" value={form.notes}
                         onChange={(e) => setForm({ ...form, notes: e.target.value })} />
                </div>
                {Acoes({ t, enviando, fechar: () => setModal(null), rotulo: t('common.save', 'Salvar') })}
              </form>
            )}
            {modal === 'baixa' && (
              <form onSubmit={darBaixa}>
                <h2>{t('fiado.writeOffTitle', 'Dar baixa no fiado de {{name}}', { name: playerName })}</h2>
                <p className="form-hint form-hint--danger">
                  {t('fiado.writeOffHint', 'A baixa perdoa a dívida e entra no DRE como perda. Não volta atrás.')}
                </p>
                <div className="form-group">
                  <label htmlFor="fiado-baixa">{t('fiado.colAmount', 'Valor')}</label>
                  <input id="fiado-baixa" type="number" step="0.01" min="0.01" max={deve} required
                         value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
                </div>
                <div className="form-group">
                  <label htmlFor="fiado-motivo">{t('fiado.reason', 'Motivo')}</label>
                  <input id="fiado-motivo" type="text" required minLength={3}
                         value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
                </div>
                {Acoes({ t, enviando, fechar: () => setModal(null), rotulo: t('fiado.writeOff', 'Dar baixa'), perigo: true })}
              </form>
            )}
            {modal.estornar && (
              <form onSubmit={estornar}>
                <h2>{t('fiado.reverseTitle', 'Estornar recebimento de {{value}}', { value: formatCurrency(modal.estornar.amount) })}</h2>
                <p className="form-hint">
                  {t('fiado.reverseHint', 'O dinheiro sai da mesma gaveta que recebeu, e só enquanto ela estiver aberta na mesma sessão. A dívida volta.')}
                </p>
                <div className="form-group">
                  <label htmlFor="fiado-estorno">{t('fiado.reason', 'Motivo')}</label>
                  <input id="fiado-estorno" type="text" required minLength={3}
                         value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
                </div>
                {Acoes({ t, enviando, fechar: () => setModal(null), rotulo: t('fiado.reverse', 'Estornar'), perigo: true })}
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

function Acoes({ t, enviando, fechar, rotulo, perigo = false }) {
  return (
    <div className="modal-actions">
      <button type="button" className="btn btn-secondary" onClick={fechar} disabled={enviando}>
        {t('common.cancel', 'Cancelar')}
      </button>
      <button type="submit" className={`btn ${perigo ? 'btn-danger' : 'btn-primary'}`} disabled={enviando}>
        {enviando ? t('common.saving', 'Salvando...') : rotulo}
      </button>
    </div>
  );
}

export default FiadoCard;
