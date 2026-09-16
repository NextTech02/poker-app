import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useEscapeKey } from '../hooks/useEscapeKey';
import BarPaymentModal from './BarPaymentModal';
import { saldoDaComanda } from '../utils/barTotais';
import { avisarQueOCaixaMudou } from '../utils/eventosDoCaixa';
import './BarTabPanel.css';

/**
 * A COMANDA por dentro: itens, totais e as ações sobre ela.
 *
 * Quem lança item é a grade de produtos (fora daqui); este painel é o que
 * o barman lê e onde ele entrega, recebe e fecha. As ações de GERENTE
 * (desconto, cortesia, estorno, reabrir, cancelar) só aparecem com `canAdmin`.
 *
 * O painel faz as chamadas e devolve o detalhe novo pelo `onChanged` — a
 * tela-mãe não precisa saber qual ação foi.
 *
 * @param {object}   detail         { tab, items, payments, player_available_credit }
 * @param {boolean}  canAdmin
 * @param {boolean}  cashboxBlocked gaveta do operador fechada (só trava RECEBER em dinheiro)
 * @param {function} onChanged(detail)
 * @param {function} [onClosed]     depois de fechar/cancelar (a POS tira a comanda da lista)
 */
const BarTabPanel = ({ detail, canAdmin = false, cashboxBlocked = false, onChanged, onClosed }) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();
  const [busy, setBusy] = useState(false);
  const [paying, setPaying] = useState(false);
  const [modal, setModal] = useState(null); // {kind:'discount'|'cancelItem'|'courtesy'|'cancelTab'|'refund', ...}
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');

  useEscapeKey(!!modal, () => { if (!busy) setModal(null); });

  const tab = detail?.tab;
  if (!tab) return null;
  const items = detail.items || [];
  const payments = detail.payments || [];
  const isOpen = tab.status === 'open';
  const saldo = saldoDaComanda(tab);
  const pendentes = items.filter((i) => i.status === 'pending');

  const chamar = async (fn, sucesso) => {
    setBusy(true);
    try {
      const res = await fn();
      if (sucesso) toast.success(sucesso);
      setModal(null);
      setReason('');
      setAmount('');
      const dados = res?.data;
      // Fechar/reabrir/cancelar devolvem a comanda; o resto devolve o detalhe.
      if (dados?.tab) onChanged?.(dados);
      else if (dados?.id) onChanged?.({ ...detail, tab: { ...tab, ...dados } });
      return dados;
    } catch (err) {
      toast.error(err.userMessage || t('bar.actionError', 'Não foi possível concluir'));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const entregar = (item) => chamar(() => api.post(`/bar/tabs/${tab.id}/items/${item.id}/deliver`));
  const entregarTodos = () => chamar(() => api.post(`/bar/tabs/${tab.id}/deliver-all`),
    t('bar.allDelivered', 'Itens entregues'));

  const cancelarItem = (e) => {
    e.preventDefault();
    return chamar(() => api.post(`/bar/tabs/${tab.id}/items/${modal.item.id}/cancel`, { reason }),
      t('bar.itemCancelled', 'Item cancelado'));
  };
  const cortesia = (e) => {
    e.preventDefault();
    return chamar(() => api.post(`/bar/tabs/${tab.id}/items/${modal.item.id}/courtesy`,
      { courtesy: true, reason }), t('bar.courtesyApplied', 'Cortesia aplicada'));
  };
  const tirarCortesia = (item) => chamar(() => api.post(`/bar/tabs/${tab.id}/items/${item.id}/courtesy`,
    { courtesy: false }));
  const desconto = (e) => {
    e.preventDefault();
    return chamar(() => api.post(`/bar/tabs/${tab.id}/discount`,
      { amount: parseFloat(amount || 0), reason }), t('bar.discountApplied', 'Desconto aplicado'));
  };
  const estornar = (e) => {
    e.preventDefault();
    return chamar(async () => {
      const res = await api.post(`/bar/tabs/${tab.id}/payments/${modal.payment.id}/cancel`, { reason });
      avisarQueOCaixaMudou();
      return res;
    }, t('bar.paymentRefunded', 'Pagamento estornado'));
  };
  const fechar = async () => {
    const dados = await chamar(() => api.post(`/bar/tabs/${tab.id}/close`, { deliver_pending: true }),
      t('bar.tabClosed', 'Comanda fechada'));
    if (dados) onClosed?.(dados);
  };
  const reabrir = () => chamar(() => api.post(`/bar/tabs/${tab.id}/reopen`), t('bar.tabReopened', 'Comanda reaberta'));
  const cancelarComanda = async (e) => {
    e.preventDefault();
    const dados = await chamar(() => api.post(`/bar/tabs/${tab.id}/cancel`, { reason }),
      t('bar.tabCancelled', 'Comanda cancelada'));
    if (dados) onClosed?.(dados);
  };

  const statusLabel = {
    pending: t('bar.itemPending', 'Pendente'),
    delivered: t('bar.itemDelivered', 'Entregue'),
    cancelled: t('bar.itemCancelledStatus', 'Cancelado'),
  };

  return (
    <div className="btp">
      <div className="btp-header">
        <div>
          <h2>#{tab.number} · {tab.player_name || '—'}</h2>
          {tab.player_nickname && <span className="bar-muted">{tab.player_nickname}</span>}
        </div>
        <span className={`bar-status-${tab.status}`}>
          {tab.status === 'open' ? t('bar.statusOpen', 'Aberta')
            : tab.status === 'closed' ? t('bar.statusClosed', 'Fechada')
              : t('bar.statusCancelled', 'Cancelada')}
        </span>
      </div>

      {items.length === 0 ? (
        <p className="bar-muted btp-empty">{t('bar.noItems', 'Nenhum item ainda. Toque num produto para lançar.')}</p>
      ) : (
        <ul className="btp-items">
          {items.map((item) => (
            <li key={item.id} className={`btp-item btp-item--${item.status} ${item.is_courtesy ? 'btp-item--courtesy' : ''}`}>
              <div className="btp-item__main">
                <span className="btp-item__qty">{item.quantity}×</span>
                <span className="btp-item__name">
                  {item.product_name}
                  {item.notes && <small className="bar-muted"> · {item.notes}</small>}
                </span>
                <span className="btp-item__total">
                  {item.is_courtesy
                    ? <em>{t('bar.courtesy', 'Cortesia')}</em>
                    : formatCurrency(item.line_total)}
                </span>
              </div>
              <div className="btp-item__meta">
                <span className={`bar-status-${item.status}`}>{statusLabel[item.status]}</span>
                {isOpen && item.status === 'pending' && (
                  <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => entregar(item)}>
                    {t('bar.deliver', 'Entregar')}
                  </button>
                )}
                {isOpen && item.status !== 'cancelled' && (item.status === 'pending' || canAdmin) && (
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                          onClick={() => { setReason(''); setModal({ kind: 'cancelItem', item }); }}>
                    {t('common.cancel', 'Cancelar')}
                  </button>
                )}
                {isOpen && canAdmin && item.status !== 'cancelled' && !item.is_courtesy && (
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                          onClick={() => { setReason(''); setModal({ kind: 'courtesy', item }); }}>
                    {t('bar.courtesy', 'Cortesia')}
                  </button>
                )}
                {isOpen && canAdmin && item.is_courtesy && (
                  <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => tirarCortesia(item)}>
                    {t('bar.removeCourtesy', 'Cobrar')}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="btp-totals">
        <div><span>{t('bar.subtotal', 'Subtotal')}</span><strong>{formatCurrency(tab.subtotal)}</strong></div>
        {tab.courtesy_amount > 0 && (
          <div><span>{t('bar.courtesy', 'Cortesia')}</span><strong>{formatCurrency(tab.courtesy_amount)}</strong></div>
        )}
        {tab.discount_amount > 0 && (
          <div>
            <span>{t('bar.discount', 'Desconto')}{tab.discount_reason ? ` · ${tab.discount_reason}` : ''}</span>
            <strong>− {formatCurrency(tab.discount_amount)}</strong>
          </div>
        )}
        <div><span>{t('bar.total', 'Total')}</span><strong>{formatCurrency(tab.total)}</strong></div>
        <div><span>{t('bar.paid', 'Recebido')}</span><strong>{formatCurrency(tab.paid_amount)}</strong></div>
        <div className="btp-totals__due"><span>{t('bar.balanceDue', 'Saldo')}</span><strong>{formatCurrency(saldo)}</strong></div>
      </div>

      {payments.length > 0 && (
        <ul className="btp-payments">
          {payments.map((p) => (
            <li key={p.id} className={p.status !== 'active' ? 'btp-payment--cancelled' : ''}>
              <span>
                {p.payment_source === 'credit' ? t('bar.playerCredit', 'Crédito do jogador') : p.payment_method}
                {p.status !== 'active' && <em> · {t('bar.refunded', 'estornado')}</em>}
              </span>
              <span>{formatCurrency(p.amount)}</span>
              {isOpen && canAdmin && p.status === 'active' && p.payment_source !== 'credit' && (
                <button type="button" className="btn btn-secondary btn-sm" disabled={busy}
                        onClick={() => { setReason(''); setModal({ kind: 'refund', payment: p }); }}>
                  {t('bar.refund', 'Estornar')}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="btp-actions">
        {isOpen && pendentes.length > 0 && (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={entregarTodos}>
            {t('bar.deliverAll', 'Entregar todos')} ({pendentes.length})
          </button>
        )}
        {isOpen && saldo > 0 && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => setPaying(true)}>
            {t('bar.receive', 'Receber {{value}}', { value: formatCurrency(saldo) })}
          </button>
        )}
        {isOpen && saldo <= 0.005 && items.length > 0 && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={fechar}>
            {t('bar.closeTab', 'Fechar comanda')}
          </button>
        )}
        {isOpen && canAdmin && (
          <button type="button" className="btn btn-secondary" disabled={busy}
                  onClick={() => { setReason(tab.discount_reason || ''); setAmount(String(tab.discount_amount || '')); setModal({ kind: 'discount' }); }}>
            {t('bar.discount', 'Desconto')}
          </button>
        )}
        {isOpen && canAdmin && tab.paid_amount <= 0.005 && (
          <button type="button" className="btn btn-danger" disabled={busy}
                  onClick={() => { setReason(''); setModal({ kind: 'cancelTab' }); }}>
            {t('bar.cancelTab', 'Cancelar comanda')}
          </button>
        )}
        {tab.status === 'closed' && canAdmin && (
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={reabrir}>
            {t('bar.reopen', 'Reabrir')}
          </button>
        )}
      </div>

      {paying && (
        <BarPaymentModal
          tab={tab}
          availableCredit={detail.player_available_credit || 0}
          cashboxBlocked={cashboxBlocked}
          onClose={() => setPaying(false)}
          onPaid={(d) => onChanged?.(d)}
          onCloseTab={async () => { setPaying(false); await fechar(); }}
        />
      )}

      {modal && (
        <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !busy) setModal(null); }}>
          <div className="modal" role="dialog" aria-modal="true">
            <h2>
              {modal.kind === 'cancelItem' && t('bar.cancelItemTitle', 'Cancelar {{name}}', { name: modal.item.product_name })}
              {modal.kind === 'courtesy' && t('bar.courtesyTitle', 'Cortesia: {{name}}', { name: modal.item.product_name })}
              {modal.kind === 'discount' && t('bar.discountTitle', 'Desconto na comanda')}
              {modal.kind === 'refund' && t('bar.refundTitle', 'Estornar pagamento de {{value}}', { value: formatCurrency(modal.payment.amount) })}
              {modal.kind === 'cancelTab' && t('bar.cancelTabTitle', 'Cancelar a comanda')}
            </h2>
            <form onSubmit={
              modal.kind === 'cancelItem' ? cancelarItem
                : modal.kind === 'courtesy' ? cortesia
                  : modal.kind === 'discount' ? desconto
                    : modal.kind === 'refund' ? estornar
                      : cancelarComanda
            }>
              {modal.kind === 'discount' && (
                <div className="form-group">
                  <label htmlFor="btp-discount">{t('bar.discountAmount', 'Valor do desconto')}</label>
                  <input id="btp-discount" type="number" step="0.01" min="0" max={tab.subtotal} required
                         value={amount} onChange={(e) => setAmount(e.target.value)} />
                  <small className="form-hint">
                    {t('bar.discountHint', 'Desconto total (100%) é como se fecha quem saiu sem pagar: a comanda fecha com total zero e o estoque continua consumido.')}
                  </small>
                </div>
              )}
              {modal.kind === 'cancelTab' && (
                <p className="bar-note">
                  {t('bar.cancelTabHint', 'Todos os itens serão cancelados e o estoque, devolvido. Use só para comanda lançada por engano.')}
                </p>
              )}
              <div className="form-group">
                <label htmlFor="btp-reason">{t('bar.reason', 'Motivo')}</label>
                <input id="btp-reason" type="text" value={reason} onChange={(e) => setReason(e.target.value)}
                       required={modal.kind !== 'discount' || parseFloat(amount || 0) > 0} />
              </div>
              <div className="modal-actions">
                <button type="button" className="btn btn-secondary" onClick={() => setModal(null)} disabled={busy}>
                  {t('common.cancel', 'Cancelar')}
                </button>
                <button type="submit" className="btn btn-primary" disabled={busy}>
                  {busy ? t('common.saving', 'Salvando...') : t('common.confirm', 'Confirmar')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

export default BarTabPanel;
