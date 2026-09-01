/**
 * Aviso de "o saldo do caixa mudou".
 *
 * O saldo aparece no `CashboxBanner`, mas quem o altera é outra tela: a venda
 * acontece no formulário do Caixa, o estorno na lista de transações, a sangria
 * no painel do Financeiro, e o sync offline em código que nem é React. Nenhum
 * deles é pai do banner, então não há prop para descer nem estado para
 * compartilhar — antes disso o banner só recarregava ao montar, e o operador
 * vendia a noite inteira olhando o saldo da abertura.
 *
 * Um evento no `window` resolve sem acoplar as telas umas às outras, e é o
 * mesmo mecanismo que a fila offline já usa (`OFFLINE_QUEUE_EVENT`).
 *
 * O evento diz apenas QUE mudou, não QUANTO: quem escuta vai perguntar o saldo
 * ao servidor. Mandar o valor junto seria convidar a tela a calcular saldo por
 * conta própria — e saldo de caixa é a última coisa que deve ter duas fontes.
 */
export const CAIXA_MUDOU = 'aceblind:caixa-mudou';

export const avisarQueOCaixaMudou = () => {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(CAIXA_MUDOU));
  }
};

/** Assina o aviso e devolve a função que cancela — para usar no `useEffect`. */
export const aoMudarOCaixa = (ouvinte) => {
  if (typeof window === 'undefined') return () => {};
  window.addEventListener(CAIXA_MUDOU, ouvinte);
  return () => window.removeEventListener(CAIXA_MUDOU, ouvinte);
};
