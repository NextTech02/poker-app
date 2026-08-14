/**
 * Conversões entre PERCENTUAL e VALOR de uma faixa de premiação.
 *
 * O banco só guarda o valor em dinheiro (prize_allocations.prize_amount). O
 * percentual é um MODO DE ENTRADA: o operador do clube pensa "o primeiro leva
 * 40% do bolo", mas o que fica gravado — e o que o jogador recebe na mão — é o
 * valor. Por isso estes helpers são puros e não falam com a API: eles só
 * traduzem entre as duas leituras da mesma quantia.
 *
 * A BASE do percentual é sempre o POOL PAGÁVEL (o pool já descontada a
 * premiação reservada), a mesma base do card "Saldo restante". Usar o pool
 * bruto faria a coluna de % e o saldo contarem histórias diferentes quando o
 * torneio tem reserva configurada.
 */

/** Número finito ou `null` — string vazia e NaN não podem virar dinheiro. */
const numero = (valor) => {
  const n = typeof valor === 'number' ? valor : Number.parseFloat(valor);
  return Number.isFinite(n) ? n : null;
};

/**
 * Valor em dinheiro de `pct`% do `pool`, arredondado a 2 casas.
 * prize_amount é DECIMAL(10,2) no banco: mandar mais casas seria truncado lá.
 */
export function amountFromPercentage(pct, pool) {
  const p = numero(pct);
  const base = numero(pool);
  if (p === null || base === null || base <= 0 || p <= 0) return 0;
  return Math.round(base * p) / 100;
}

/** Quanto `amount` representa do `pool`, em percentual (número, não texto). */
export function percentageFromAmount(amount, pool) {
  const valor = numero(amount);
  const base = numero(pool);
  if (valor === null || base === null || base <= 0) return 0;
  return (valor / base) * 100;
}

/** Soma dos valores das faixas, ignorando campos ainda em branco na edição. */
export function sumAmounts(rows) {
  return (rows || []).reduce((soma, r) => soma + (numero(r?.prize_amount) || 0), 0);
}

/** Soma dos percentuais das faixas — derivada dos valores, para não divergir. */
export function sumPercentages(rows, pool) {
  return percentageFromAmount(sumAmounts(rows), pool);
}

/**
 * Texto do percentual. Mostra 2 casas quando arredondar para 1 esconderia
 * diferença: em pool quebrado, "51.9%" e "51.95%" são prêmios diferentes e o
 * operador precisa enxergar isso antes de gravar.
 */
export function formatPercentage(valor) {
  const n = numero(valor);
  if (n === null) return '0.0';
  const umaCasa = n.toFixed(1);
  const duasCasas = n.toFixed(2);
  return Number(umaCasa) === Number(duasCasas) ? umaCasa : duasCasas;
}

/** O campo pode ser gravado? (vazio/NaN/negativo não vira prêmio.) */
export function isValidInput(valor) {
  const n = numero(valor);
  return n !== null && n >= 0;
}
