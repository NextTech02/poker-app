import React from 'react';
import { useTranslation } from 'react-i18next';
import { useCurrency } from '../contexts/CurrencyContext';
import { usePaymentMethods } from '../contexts/PaymentMethodsContext';
import './CashboxNonCash.css';

// Meios que o app conhece de fábrica; os do clube (Yape, Zelle...) vêm do
// cadastro de meios de pagamento.
const ROTULOS_PADRAO = {
  card: 'financial.paymentCard',
  pix: 'financial.paymentPix',
  transfer: 'financial.paymentTransfer',
};

/**
 * O que entrou na gaveta do operador por cartão, PIX e afins. Não está na
 * gaveta para contar: o esperado do fechamento é só o dinheiro vivo, e estes
 * meios aparecem à parte para o operador conferir com a maquininha e o extrato.
 */
const CashboxNonCash = ({ items }) => {
  const { t } = useTranslation();
  const { formatCurrency } = useCurrency();
  const { labelFor } = usePaymentMethods() || {};
  if (!items || items.length === 0) return null;
  const rotulo = (codigo) =>
    (labelFor && labelFor(codigo)) || (ROTULOS_PADRAO[codigo] ? t(ROTULOS_PADRAO[codigo]) : codigo);
  return (
    <div className="cashbox-non-cash">
      <div className="cashbox-non-cash__title">{t('cashbox.nonCashTitle')}</div>
      <ul>
        {items.map((m) => (
          <li key={m.method}>
            <span>{rotulo(m.method)}</span>
            <strong>{formatCurrency(m.amount)}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default CashboxNonCash;
