/**
 * Pagamento dividido ("pago mixto"): uma venda paga com vários meios — a
 * entrada de 500 paga com 300 em dinheiro + 200 em transferência.
 *
 * A venda continua sendo UMA linha por item no banco; as partes vão na linha
 * (`payment_split`) e o servidor grava `payment_method = 'split'`. Aqui mora a
 * aritmética, sem React, em CENTAVOS INTEIROS — somar 0,1 + 0,2 em ponto
 * flutuante não dá 0,3, e o servidor recusa partes que não fecham o valor.
 */
import { round2, somaPernas } from './barTotais';

export const METODO_DIVIDIDO = 'split';

const centavos = (v) => Math.round(round2(v) * 100);

/** Partes com valor (as linhas vazias do formulário ficam de fora). */
export const partesComValor = (partes) => (partes || []).filter((p) => (parseFloat(p.amount) || 0) > 0);

/**
 * Soma partes do mesmo meio, na ordem em que apareceram. É o que o servidor
 * faz antes de gravar; fazer aqui também deixa a repartição previsível.
 */
export const fundirPartes = (partes) => {
  const ordem = [];
  const porMeio = new Map();
  partesComValor(partes).forEach((p) => {
    if (!porMeio.has(p.payment_method)) {
      ordem.push(p.payment_method);
      porMeio.set(p.payment_method, 0);
    }
    porMeio.set(p.payment_method, porMeio.get(p.payment_method) + centavos(p.amount));
  });
  return ordem.map((m) => ({ payment_method: m, amount: porMeio.get(m) / 100 }));
};

/**
 * `null` quando as partes fecham o total; senão o problema, para a tela dizer:
 * `vazio` (nenhuma parte com valor), `falta` ou `sobra`.
 */
export const validarPartes = (partes, total) => {
  const validas = partesComValor(partes);
  if (validas.length === 0) return 'vazio';
  const diferenca = centavos(somaPernas(validas)) - centavos(total);
  if (diferenca < 0) return 'falta';
  if (diferenca > 0) return 'sobra';
  return null;
};

/** Quanto falta (positivo) ou sobra (negativo) para fechar o total. */
export const restanteDasPartes = (partes, total) => (
  (centavos(total) - centavos(somaPernas(partesComValor(partes)))) / 100
);

/**
 * O pagamento de UM item, pronto para a requisição.
 *
 * Com mais de uma parte, `payment_method` leva a MAIOR delas: é o que um
 * servidor ainda sem o pagamento dividido grava (ele ignora `payment_split`).
 * O servidor novo vê as partes e grava 'split'.
 */
export const pagamentoDoItem = (partes) => {
  const fundidas = fundirPartes(partes);
  if (fundidas.length === 0) return null;
  if (fundidas.length === 1) return { payment_method: fundidas[0].payment_method, payment_split: null };
  const maior = fundidas.reduce((a, b) => (b.amount > a.amount ? b : a));
  return { payment_method: maior.payment_method, payment_split: fundidas };
};

/**
 * Reparte o total pago entre os itens da venda, na ordem de envio (a entrada e
 * depois os extras), consumindo as partes na ordem em que o operador digitou.
 *
 *   entrada 500 + taxa 50, pago Dinheiro 300 + Transferência 250
 *   → entrada: Dinheiro 300 + Transferência 200 (dividida)
 *   → taxa:    Transferência 50 (um meio só)
 *
 * Devolve um pagamento por item (`pagamentoDoItem`), ou `null` se as partes
 * não fecham o total dos itens.
 */
export const repartirPagamento = (itens, partes) => {
  const fundidas = fundirPartes(partes);
  const totalItens = (itens || []).reduce((s, it) => s + centavos(it.amount), 0);
  const totalPartes = fundidas.reduce((s, p) => s + centavos(p.amount), 0);
  if (fundidas.length === 0 || totalItens !== totalPartes) return null;

  const restantes = fundidas.map((p) => ({ metodo: p.payment_method, saldo: centavos(p.amount) }));
  let atual = 0;
  return itens.map((item) => {
    let falta = centavos(item.amount);
    const pedacos = [];
    while (falta > 0 && atual < restantes.length) {
      const parte = restantes[atual];
      const usa = Math.min(falta, parte.saldo);
      pedacos.push({ payment_method: parte.metodo, amount: usa / 100 });
      parte.saldo -= usa;
      falta -= usa;
      if (parte.saldo === 0) atual += 1;
    }
    if (pedacos.length === 0) {
      // Item de valor zero: leva o meio da parte em curso, sem divisão.
      const metodo = restantes[Math.min(atual, restantes.length - 1)].metodo;
      return { payment_method: metodo, payment_split: null };
    }
    return pagamentoDoItem(pedacos);
  });
};

/** As partes de uma linha já gravada; linha simples = uma parte só. */
export const partesDaLinha = (tx) => {
  let partes = tx?.payment_split;
  if (typeof partes === 'string') {
    try {
      partes = JSON.parse(partes);
    } catch {
      partes = null;
    }
  }
  if (Array.isArray(partes) && partes.length > 0) {
    return partes.map((p) => ({ payment_method: p.payment_method, amount: Number(p.amount) || 0 }));
  }
  return [{ payment_method: tx?.payment_method ?? null, amount: Number(tx?.amount) || 0 }];
};

export const eDividido = (tx) => partesDaLinha(tx).length > 1 || tx?.payment_method === METODO_DIVIDIDO;

/**
 * Rótulo do pagamento de uma linha: "Dinheiro" ou, na dividida,
 * "Dinheiro R$ 300,00 · Transferência R$ 200,00". `rotuloDoMeio(code)` é o
 * de cada tela (os meios personalizados — Yape, Nequi — são por clube).
 */
export const rotuloDoPagamento = (tx, rotuloDoMeio, formatCurrency) => {
  const partes = partesDaLinha(tx);
  if (partes.length === 1) return rotuloDoMeio(partes[0].payment_method);
  return partes.map((p) => `${rotuloDoMeio(p.payment_method)} ${formatCurrency(p.amount)}`).join(' · ');
};

/** Partes iniciais do editor: o total inteiro no meio que já estava escolhido. */
export const partesIniciais = (metodo, total) => [
  { payment_method: metodo, amount: total ? String(round2(total)) : '' },
];
