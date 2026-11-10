/**
 * Rótulos do BAR que vêm do banco como código ou como dado padrão.
 *
 * O bar grava o meio de pagamento pelo código (`cash`, `pix`, `card`) e o
 * crédito do jogador como `credit`. Mostrar o código cru deixava "cash" e
 * "credit" na tela, também nos clubes em português.
 */
import { methodLabel } from './paymentMethodLabels';

/**
 * Nome do meio de pagamento de um recebimento do bar.
 *
 * `metodos` é a lista completa do clube (com os inativos), para um relatório
 * antigo não perder o nome de um meio que foi desativado depois.
 */
export const rotuloDoMeioDoBar = (t, codigo, metodos = []) => {
  if (!codigo) return '—';
  if (codigo === 'credit') return t('bar.playerCredit', 'Crédito do jogador');
  const cadastrado = (metodos || []).find((m) => m.code === codigo);
  return methodLabel(t, cadastrado || { code: codigo });
};
