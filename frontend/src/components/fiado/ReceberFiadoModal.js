import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../config/api';
import { useToast } from '../../contexts/ToastContext';
import { useCurrency } from '../../contexts/CurrencyContext';
import { usePaymentMethods } from '../../contexts/PaymentMethodsContext';
import { usePermissions } from '../../contexts/PermissionContext';
import { useEscapeKey } from '../../hooks/useEscapeKey';
import { methodLabel } from '../../utils/paymentMethodLabels';
import { avisarQueOCaixaMudou } from '../../utils/eventosDoCaixa';
import { imprimirCupomDeFiado, novoIdDeOperacao } from '../../utils/fiado';

/**
 * Receber fiado numa gaveta. A gaveta é a da ÂNCORA que a tela passa — o dia
 * do cash ou o turno do bar —, nunca adivinhada: o operador pode ter as duas
 * abertas, e o dinheiro precisa cair na que ele está atendendo.
 *
 * Recebimento não é venda: entra na gaveta como "Recebimento de fiado", não
 * soma no faturamento do dia nem do turno.
 */
const ReceberFiadoModal = ({ player, conta, ancora, onClose, onDone }) => {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { formatCurrency } = useCurrency();
  const { activeMethods } = usePaymentMethods();
  const { staffName, organizationName } = usePermissions();

  const devido = Number(conta?.balance || 0);
  const [valor, setValor] = useState(devido ? String(devido) : '');
  const [metodo, setMetodo] = useState(activeMethods[0]?.code || 'cash');
  const [notas, setNotas] = useState('');
  const [enviando, setEnviando] = useState(false);
  const [feito, setFeito] = useState(null);
  // Um id por abertura do modal: o retry depois de uma resposta perdida
  // devolve o mesmo recebimento em vez de baixar a dívida duas vezes.
  const cmid = useMemo(() => novoIdDeOperacao(), []);

  useEscapeKey(true, () => { if (!enviando) onClose(); });

  const numero = parseFloat(valor || 0);
  const acimaDaDivida = numero > devido + 0.004;
  const semAncora = !ancora?.cash_day_id && !ancora?.bar_shift_id;

  const receber = async (e) => {
    e.preventDefault();
    setEnviando(true);
    try {
      const { data } = await api.post(`/house-credit/players/${player.id}/payments`, {
        amount: numero,
        payment_method: metodo,
        client_mutation_id: cmid,
        notes: notas || null,
        ...ancora,
      });
      toast.success(t('fiado.received', 'Fiado recebido'));
      avisarQueOCaixaMudou();
      setFeito(data);
      onDone?.(data);
    } catch (err) {
      toast.error(err.userMessage || t('fiado.receiveError', 'Não foi possível receber o fiado'));
    } finally {
      setEnviando(false);
    }
  };

  const imprimir = () => {
    const quando = new Date(feito?.entry?.created_at || Date.now());
    imprimirCupomDeFiado({
      titulo: t('fiado.receiptTitle', 'COMPROVANTE DE PAGAMENTO DE FIADO'),
      clube: organizationName,
      jogador: player.name,
      valor: formatCurrency(feito?.entry?.amount || numero),
      linhas: [
        { rotulo: t('fiado.method', 'Meio'), valor: methodLabel(t, activeMethods.find((m) => m.code === metodo) || { code: metodo }) },
        { rotulo: t('fiado.balanceAfter', 'Saldo devedor após'), valor: formatCurrency(feito?.account?.balance ?? 0) },
      ],
      atendente: staffName ? { rotulo: t('fiado.attendant', 'Atendente'), valor: staffName } : null,
      quando: { rotulo: t('fiado.when', 'Data'), valor: quando.toLocaleString() },
    });
  };

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget && !enviando) onClose(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="fiado-receber-titulo">
        <h2 id="fiado-receber-titulo">
          {t('fiado.receiveFor', 'Receber fiado — {{name}}', { name: player.name })}
        </h2>
        {feito ? (
          <>
            <p>
              {t('fiado.receivedSummary', 'Recebido {{value}}. Saldo devedor: {{balance}}.', {
                value: formatCurrency(feito.entry?.amount || 0),
                balance: formatCurrency(feito.account?.balance || 0),
              })}
            </p>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={imprimir}>
                {t('fiado.printReceipt', 'Imprimir comprovante')}
              </button>
              <button type="button" className="btn btn-primary" onClick={onClose}>
                {t('common.close', 'Fechar')}
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={receber}>
            <p className="form-hint">
              {t('fiado.owes', 'Deve {{value}}', { value: formatCurrency(devido) })}
            </p>
            {semAncora && (
              <p className="form-hint form-hint--danger" role="alert">
                {t('fiado.noDrawerHere', 'Para receber, abra o dia do cash (ou o turno do bar) e a sua gaveta.')}
              </p>
            )}
            <div className="form-group">
              <label htmlFor="fiado-valor">{t('fiado.amount', 'Valor recebido')}</label>
              <input
                id="fiado-valor" type="number" step="0.01" min="0.01" max={devido || undefined}
                value={valor} onChange={(e) => setValor(e.target.value)} required autoFocus
              />
              {acimaDaDivida && (
                <small className="form-hint form-hint--danger" role="alert">
                  {t('fiado.overDebt', 'O valor passa do que o jogador deve.')}
                </small>
              )}
            </div>
            <div className="form-group">
              <label htmlFor="fiado-metodo">{t('cash.paymentMethod', 'Meio de pagamento')}</label>
              <select id="fiado-metodo" value={metodo} onChange={(e) => setMetodo(e.target.value)}>
                {activeMethods.map((m) => (
                  <option key={m.code} value={m.code}>{methodLabel(t, m)}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="fiado-notas">{t('cash.notes', 'Observação')}</label>
              <input id="fiado-notas" type="text" value={notas} onChange={(e) => setNotas(e.target.value)} />
            </div>
            <div className="modal-actions">
              <button type="button" className="btn btn-secondary" onClick={onClose} disabled={enviando}>
                {t('common.cancel', 'Cancelar')}
              </button>
              <button
                type="submit" className="btn btn-primary"
                disabled={enviando || semAncora || acimaDaDivida || !(numero > 0)}
              >
                {enviando ? t('common.saving', 'Salvando...') : t('fiado.receive', 'Receber')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

export default ReceberFiadoModal;
