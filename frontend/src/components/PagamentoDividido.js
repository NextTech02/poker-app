import React from 'react';
import { useTranslation } from 'react-i18next';
import { useCurrency } from '../contexts/CurrencyContext';
import { methodLabel } from '../utils/paymentMethodLabels';
import { restanteDasPartes, validarPartes } from '../utils/pagamentoDividido';
import './PagamentoDividido.css';

/**
 * Editor das partes de um pagamento dividido: meio + valor por linha,
 * "+ Outra forma" já com o que falta, e o rodapé dizendo quanto falta ou
 * sobra para fechar o total. Controlado: quem usa guarda as partes e decide
 * quando a venda pode sair (`validarPartes(partes, total) === null`).
 *
 * Mesmo visual das pernas do Bar (`BarPaymentModal`), sem crédito: dividir
 * é só entre meios de dinheiro de verdade.
 *
 * @param {number}   total    valor que as partes têm de fechar
 * @param {Array}    partes   [{ payment_method, amount }] (amount em texto do campo)
 * @param {function} onChange recebe a lista nova
 * @param {Array}    metodos  meios ativos do clube ({ code, label })
 */
const PagamentoDividido = ({ total, partes, onChange, metodos = [], idPrefix = 'pd' }) => {
  const { t } = useTranslation();
  const { formatCurrency } = useCurrency();

  const metodoPadrao = metodos[0]?.code || 'cash';
  const restante = restanteDasPartes(partes, total);
  const problema = validarPartes(partes, total);

  const mudar = (i, campo, valor) => {
    onChange(partes.map((p, idx) => (idx === i ? { ...p, [campo]: valor } : p)));
  };
  const remover = (i) => onChange(partes.filter((_, idx) => idx !== i));
  const adicionar = () => {
    // A próxima parte nasce num meio ainda não usado, com o que falta.
    const usados = new Set(partes.map((p) => p.payment_method));
    const livre = metodos.find((m) => !usados.has(m.code))?.code || metodoPadrao;
    onChange([...partes, { payment_method: livre, amount: restante > 0 ? String(restante) : '' }]);
  };

  return (
    <div className="pd" data-testid="pagamento-dividido">
      <div className="pd-partes">
        {partes.map((parte, i) => (
          <div className="pd-parte" key={i} data-testid="parte-do-pagamento">
            <select
              id={`${idPrefix}-meio-${i}`}
              className="pd-parte__meio"
              aria-label={t('splitPayment.method', 'Meio da parte {{n}}', { n: i + 1 })}
              value={parte.payment_method}
              onChange={(e) => mudar(i, 'payment_method', e.target.value)}
            >
              {metodos.length === 0 && <option value="cash">{t('cashRegister.cash', 'Dinheiro')}</option>}
              {metodos.map((m) => (
                <option key={m.code} value={m.code}>{methodLabel(t, m)}</option>
              ))}
            </select>
            <input
              id={`${idPrefix}-valor-${i}`}
              type="number" step="0.01" min="0.01" inputMode="decimal"
              className="pd-parte__valor"
              aria-label={t('splitPayment.amount', 'Valor da parte {{n}}', { n: i + 1 })}
              value={parte.amount}
              onChange={(e) => mudar(i, 'amount', e.target.value)}
            />
            {partes.length > 1 && (
              <button
                type="button"
                className="btn btn-secondary btn-small"
                onClick={() => remover(i)}
                aria-label={t('splitPayment.remove', 'Remover parte {{n}}', { n: i + 1 })}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>

      <div className="pd-rodape">
        <button type="button" className="btn btn-secondary btn-small" onClick={adicionar}>
          + {t('splitPayment.addPart', 'Outra forma')}
        </button>
        <span
          className={problema && problema !== 'vazio' ? 'pd-rodape__problema' : 'pd-rodape__ok'}
          role={problema ? 'status' : undefined}
        >
          {problema === 'falta' && t('splitPayment.missing', 'Falta {{value}}', { value: formatCurrency(restante) })}
          {problema === 'sobra' && t('splitPayment.over', 'Passa {{value}}', { value: formatCurrency(-restante) })}
          {problema === 'vazio' && t('splitPayment.empty', 'Informe quanto foi pago em cada meio.')}
          {!problema && t('splitPayment.closes', 'Fecha {{value}}', { value: formatCurrency(total) })}
        </span>
      </div>
    </div>
  );
};

export default PagamentoDividido;
