import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { usePaymentMethods } from '../contexts/PaymentMethodsContext';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { methodLabel } from '../utils/paymentMethodLabels';
import { novoId, round2, saldoDaComanda, somaPernas, validarPernas } from '../utils/barTotais';
import { avisarQueOCaixaMudou } from '../utils/eventosDoCaixa';
import './BarPaymentModal.css';

/**
 * Receber uma comanda: uma ou várias PERNAS numa baixa só.
 *
 *  - PARCIAL: a soma pode ser menor que o saldo; a comanda continua aberta.
 *  - DIVIDIDO: cada perna tem a sua forma (PIX, dinheiro, cartão...).
 *  - CRÉDITO: a perna de crédito só existe se o jogador tiver saldo, e é
 *    limitada a ele. Crédito é do PATROCINADOR — a tela diz isso.
 *
 * Um único POST, com `client_mutation_id`: duplo clique não cobra duas vezes.
 * Quando o saldo zera, o modal oferece fechar a comanda na hora.
 *
 * @param {object}   tab               a comanda (com total e paid_amount)
 * @param {number}   availableCredit   crédito do jogador (sem filtro de etapa)
 * @param {boolean}  cashboxBlocked    gaveta do operador fechada → só crédito
 * @param {function} onClose
 * @param {function} onPaid(detail)    chamado com o detalhe devolvido pelo servidor
 * @param {function} onCloseTab()      chamado quando o operador escolhe fechar
 */
const BarPaymentModal = ({ tab, availableCredit = 0, cashboxBlocked = false, onClose, onPaid, onCloseTab }) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();
  const { activeMethods } = usePaymentMethods();

  const saldo = saldoDaComanda(tab);
  const metodoPadrao = activeMethods[0]?.code || 'cash';
  const [legs, setLegs] = useState([{ payment_method: metodoPadrao, amount: String(saldo), payment_source: 'cash' }]);
  const [submitting, setSubmitting] = useState(false);
  const [quitado, setQuitado] = useState(null); // detalhe pós-pagamento com saldo zero

  useEscapeKey(true, () => { if (!submitting) onClose(); });

  const soma = useMemo(() => somaPernas(legs), [legs]);
  const restante = round2(saldo - soma);
  const temCredito = legs.some((l) => l.payment_source === 'credit');
  const problema = validarPernas(legs, saldo, availableCredit);
  const soCredito = cashboxBlocked && legs.some((l) => l.payment_source === 'cash' && (parseFloat(l.amount) || 0) > 0);

  const mudar = (i, campo, valor) => {
    setLegs((prev) => prev.map((l, idx) => (idx === i ? { ...l, [campo]: valor } : l)));
  };
  const remover = (i) => setLegs((prev) => prev.filter((_, idx) => idx !== i));
  const adicionarPerna = () => {
    setLegs((prev) => [...prev, {
      payment_method: metodoPadrao, amount: String(Math.max(restante, 0)), payment_source: 'cash',
    }]);
  };
  const usarCredito = () => {
    const valor = Math.min(round2(availableCredit), Math.max(restante, 0) || saldo);
    setLegs((prev) => [...prev, { payment_method: 'credit', amount: String(valor), payment_source: 'credit' }]);
  };

  const mensagemDoProblema = {
    pagamento_vazio: t('errors.pagamento_vazio', 'Informe ao menos uma forma de pagamento com valor.'),
    pagamento_acima_do_saldo: t('errors.pagamento_acima_do_saldo', 'O pagamento excede o saldo da comanda.'),
    credito_insuficiente: t('errors.credito_insuficiente', 'O jogador não tem crédito suficiente.'),
  }[problema];

  const pagar = async (e) => {
    e.preventDefault();
    if (problema || soCredito) return;
    setSubmitting(true);
    try {
      const corpo = {
        legs: legs
          .filter((l) => (parseFloat(l.amount) || 0) > 0)
          .map((l) => ({
            payment_method: l.payment_method,
            amount: round2(l.amount),
            payment_source: l.payment_source,
          })),
        client_mutation_id: novoId(),
      };
      const res = await api.post(`/bar/tabs/${tab.id}/payments`, corpo);
      avisarQueOCaixaMudou();
      toast.success(t('bar.paymentReceived', 'Pagamento recebido'));
      const detalhe = res.data;
      if (detalhe?.tab && saldoDaComanda(detalhe.tab) <= 0.005) {
        setQuitado(detalhe);
        onPaid?.(detalhe);
      } else {
        onPaid?.(detalhe);
        onClose();
      }
    } catch (err) {
      toast.error(err.userMessage || t('bar.paymentError', 'Não foi possível receber o pagamento'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !submitting) onClose(); }}>
      <div className="modal bpm" role="dialog" aria-modal="true" aria-labelledby="bpm-title">
        <h2 id="bpm-title">
          {t('bar.receiveTitle', 'Receber comanda #{{number}}', { number: tab.number })}
        </h2>

        {quitado ? (
          <div className="bpm-done">
            <p className="bpm-done__msg">{t('bar.tabSettled', 'Comanda quitada.')}</p>
            {quitado.tab.pending_count > 0 && (
              <p className="bar-muted">
                {t('bar.settledPendingHint', '{{count}} item(ns) ainda pendente(s) — fechar marca todos como entregues.', { count: quitado.tab.pending_count })}
              </p>
            )}
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose}>
                {t('bar.keepOpen', 'Manter aberta')}
              </button>
              <button type="button" className="btn btn-primary" onClick={() => onCloseTab?.()}>
                {t('bar.closeTab', 'Fechar comanda')}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={pagar}>
            <div className="bpm-summary">
              <div>
                <span className="bar-muted">{t('bar.total', 'Total')}</span>
                <strong>{formatCurrency(tab.total)}</strong>
              </div>
              <div>
                <span className="bar-muted">{t('bar.paid', 'Recebido')}</span>
                <strong>{formatCurrency(tab.paid_amount)}</strong>
              </div>
              <div className="bpm-summary__due">
                <span className="bar-muted">{t('bar.balanceDue', 'Saldo')}</span>
                <strong>{formatCurrency(saldo)}</strong>
              </div>
            </div>

            {cashboxBlocked && (
              <p className="bar-warning">
                {t('bar.cashboxClosedPayHint', 'Seu caixa está fechado: abra-o para receber em dinheiro, PIX ou cartão. Crédito do jogador continua disponível.')}
              </p>
            )}

            <div className="bpm-legs">
              {legs.map((leg, i) => (
                <div className="bpm-leg" key={i} data-testid="perna">
                  {leg.payment_source === 'credit' ? (
                    <div className="bpm-leg__method bpm-leg__credit">
                      {t('bar.playerCredit', 'Crédito do jogador')}
                      <small className="bar-muted">
                        {' '}{t('bar.creditAvailable', 'disponível {{value}}', { value: formatCurrency(availableCredit) })}
                      </small>
                    </div>
                  ) : (
                    <select
                      className="bpm-leg__method"
                      aria-label={t('bar.paymentMethod', 'Forma de pagamento')}
                      value={leg.payment_method}
                      onChange={(e) => mudar(i, 'payment_method', e.target.value)}
                    >
                      {activeMethods.length === 0 && <option value="cash">{t('cashRegister.cash', 'Dinheiro')}</option>}
                      {activeMethods.map((m) => (
                        <option key={m.code} value={m.code}>{methodLabel(t, m)}</option>
                      ))}
                    </select>
                  )}
                  <input
                    type="number" step="0.01" min="0.01"
                    aria-label={t('bar.amount', 'Valor')}
                    className="bpm-leg__amount"
                    value={leg.amount}
                    onChange={(e) => mudar(i, 'amount', e.target.value)}
                  />
                  {legs.length > 1 && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => remover(i)}
                            aria-label={t('common.remove', 'Remover')}>
                      ×
                    </button>
                  )}
                </div>
              ))}
            </div>

            <div className="bpm-add">
              <button type="button" className="btn btn-secondary btn-sm" onClick={adicionarPerna}>
                + {t('bar.addLeg', 'Outra forma')}
              </button>
              {availableCredit > 0 && !temCredito && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={usarCredito}>
                  {t('bar.useCredit', 'Usar crédito ({{value}})', { value: formatCurrency(availableCredit) })}
                </button>
              )}
            </div>
            {temCredito && (
              <p className="bar-muted">
                {t('bar.creditSponsorHint', 'O crédito é do patrocinador do jogador: usá-lo aqui cobra o patrocinador pela comanda.')}
              </p>
            )}

            <div className="bpm-footer">
              <span className={restante < -0.005 ? 'bpm-over' : ''}>
                {restante >= 0
                  ? t('bar.remainingAfter', 'Restará {{value}}', { value: formatCurrency(Math.max(restante, 0)) })
                  : t('bar.overBalance', 'Passa do saldo em {{value}}', { value: formatCurrency(-restante) })}
              </span>
              {mensagemDoProblema && <span className="bpm-problem" role="alert">{mensagemDoProblema}</span>}
            </div>

            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={submitting}>
                {t('common.cancel', 'Cancelar')}
              </button>
              <button type="submit" className="btn btn-primary" disabled={submitting || !!problema || soCredito}>
                {submitting ? t('common.saving', 'Salvando...') : t('bar.receive', 'Receber {{value}}', { value: formatCurrency(soma) })}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

export default BarPaymentModal;
