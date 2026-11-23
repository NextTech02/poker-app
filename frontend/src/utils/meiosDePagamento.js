/**
 * O quadro "por meio de pagamento" dos relatórios e o filtro que sai dele.
 *
 * O servidor manda `{ method }` (código do meio do clube) ou `{ source }`
 * (crédito, misto e ticket, que são origens e não meios). A chave de cada linha
 * é o valor do filtro, o mesmo do Extrato Geral: `meio:yape`, `origem:ticket`.
 */
import { filtroDeMeio, filtroDeOrigem, lerFiltro, MEIO_DINHEIRO } from './extratoGeral';
import { methodLabel } from './paymentMethodLabels';

const ROTULO_DA_ORIGEM = {
  credit: ['financial.paymentCredit', 'Crédito'],
  mixed: ['financial.paymentMixed', 'Misto'],
  ticket: ['financial.paymentTicket', 'Ticket'],
};

export const chaveDoMeio = (linha) => (
  linha.source ? filtroDeOrigem(linha.source) : filtroDeMeio(linha.method || MEIO_DINHEIRO)
);

/** Nome como o clube vê ("Efectivo", "YAPE"), a partir do valor do filtro. */
export const rotuloDoFiltro = (chave, t, labelFor) => {
  const filtro = lerFiltro(chave);
  if (!filtro) return '';
  if (filtro.origem) return ROTULO_DA_ORIGEM[filtro.origem] ? t(...ROTULO_DA_ORIGEM[filtro.origem]) : filtro.origem;
  return methodLabel(t, { code: filtro.meio, label: labelFor?.(filtro.meio) });
};

/**
 * O que o filtro oferece: dinheiro, os meios ativos do clube na ordem do
 * cadastro, os que aparecem nas vendas e não estão mais ativos e, por fim, as
 * origens que tiveram venda.
 */
export const opcoesDoFiltro = (meiosAtivos, linhas) => {
  const chaves = [filtroDeMeio(MEIO_DINHEIRO)];
  const incluir = (chave) => { if (!chaves.includes(chave)) chaves.push(chave); };
  (meiosAtivos || []).forEach((m) => incluir(filtroDeMeio(m.code)));
  (linhas || []).filter((l) => !l.source).forEach((l) => incluir(chaveDoMeio(l)));
  (linhas || []).filter((l) => l.source).forEach((l) => incluir(chaveDoMeio(l)));
  return chaves;
};
