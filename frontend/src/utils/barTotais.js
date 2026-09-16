/**
 * A aritmética da comanda, em um lugar só e sem React — para o modal de
 * pagamento e a POS somarem do mesmo jeito que o servidor.
 */
export const round2 = (v) => Math.round(((Number(v) || 0) + Number.EPSILON) * 100) / 100;

export const saldoDaComanda = (tab) => round2((tab?.total || 0) - (tab?.paid_amount || 0));

export const somaPernas = (legs) => round2((legs || []).reduce((s, l) => s + (parseFloat(l.amount) || 0), 0));

/**
 * Valida as pernas de um pagamento contra o saldo e o crédito disponível.
 * Devolve `null` quando está tudo certo, ou o código do problema — a tela
 * traduz. Os mesmos códigos que o backend usa, para a mensagem ser uma só.
 */
export const validarPernas = (legs, saldo, creditoDisponivel = 0) => {
  const validas = (legs || []).filter((l) => (parseFloat(l.amount) || 0) > 0);
  if (validas.length === 0) return 'pagamento_vazio';
  if (somaPernas(validas) > round2(saldo) + 0.005) return 'pagamento_acima_do_saldo';
  const credito = somaPernas(validas.filter((l) => l.payment_source === 'credit'));
  if (credito > round2(creditoDisponivel) + 0.005) return 'credito_insuficiente';
  return null;
};

export const novoId = () => (
  window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`
);
