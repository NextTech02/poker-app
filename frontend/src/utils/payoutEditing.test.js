import {
  amountFromPercentage,
  percentageFromAmount,
  sumAmounts,
  sumPercentages,
  formatPercentage,
  isValidInput,
} from './payoutEditing';

/**
 * Percentual e valor são duas leituras do MESMO prêmio. O clube configura em
 * percentual ("o primeiro leva 40%") mas paga em dinheiro, e é o dinheiro que
 * fica gravado. Um erro de conversão aqui promete ao jogador um prêmio que o
 * caixa não vai entregar.
 */
describe('amountFromPercentage', () => {
  it('30% de 1000 são 300', () => {
    expect(amountFromPercentage(30, 1000)).toBe(300);
  });

  it('arredonda para 2 casas, como o DECIMAL(10,2) do banco', () => {
    // 33.33% de 1000 = 333.30 — mandar mais casas seria truncado na gravação.
    expect(amountFromPercentage(33.33, 1000)).toBe(333.3);
    expect(amountFromPercentage(33.333, 1000)).toBe(333.33);
  });

  it('aceita o percentual digitado como texto', () => {
    // O input do navegador entrega string; parseFloat mora aqui, não na tela.
    expect(amountFromPercentage('12.5', 2000)).toBe(250);
  });

  it.each([
    ['pool zerado', 30, 0],
    ['pool negativo', 30, -100],
    ['percentual zerado', 0, 1000],
    ['percentual negativo', -10, 1000],
    ['campo em branco', '', 1000],
    ['texto sem número', 'abc', 1000],
    ['pool ausente', 30, null],
  ])('%s não vira prêmio', (_rotulo, pct, pool) => {
    expect(amountFromPercentage(pct, pool)).toBe(0);
  });
});

describe('percentageFromAmount', () => {
  it('300 de 1000 são 30%', () => {
    expect(percentageFromAmount(300, 1000)).toBe(30);
  });

  it('devolve número, não texto — quem formata é a tela', () => {
    expect(typeof percentageFromAmount(300, 1000)).toBe('number');
  });

  it('pool zerado não vira divisão por zero', () => {
    expect(percentageFromAmount(300, 0)).toBe(0);
    expect(percentageFromAmount(300, null)).toBe(0);
  });

  it('valor em branco conta como zero', () => {
    expect(percentageFromAmount('', 1000)).toBe(0);
  });

  it('ida e volta valor → % → valor não muda o prêmio', () => {
    const pool = 38500;
    for (const valor of [20000, 10000, 5000, 1234.56]) {
      const pct = percentageFromAmount(valor, pool);
      expect(amountFromPercentage(pct, pool)).toBeCloseTo(valor, 2);
    }
  });
});

describe('somas das faixas', () => {
  const faixas = [
    { prize_amount: 20000 },
    { prize_amount: '10000' },
    { prize_amount: 5000 },
  ];

  it('soma os valores mesmo vindos como texto', () => {
    expect(sumAmounts(faixas)).toBe(35000);
  });

  it('faixa com campo em branco no meio da edição não zera a soma', () => {
    // Enquanto o operador apaga um campo para digitar outro número, o rodapé
    // não pode virar NaN — ele é o aviso de estouro.
    expect(sumAmounts([{ prize_amount: '' }, { prize_amount: 100 }])).toBe(100);
  });

  it('lista vazia soma zero', () => {
    expect(sumAmounts([])).toBe(0);
    expect(sumAmounts(undefined)).toBe(0);
  });

  it('o percentual total sai dos valores, não da soma dos percentuais', () => {
    // 35000 de 38500 pagáveis = 90.9%
    expect(sumPercentages(faixas, 38500)).toBeCloseTo(90.909, 2);
  });
});

describe('formatPercentage', () => {
  it('percentual redondo fica com 1 casa', () => {
    expect(formatPercentage(50)).toBe('50.0');
    expect(formatPercentage(35)).toBe('35.0');
  });

  it('mostra a 2ª casa quando ela muda o número', () => {
    // 20000 / 38500: "51.9" esconderia 19 reais de diferença.
    expect(formatPercentage(51.948)).toBe('51.95');
  });

  it('valor inválido vira zero, não NaN', () => {
    expect(formatPercentage('')).toBe('0.0');
    expect(formatPercentage(undefined)).toBe('0.0');
  });
});

describe('isValidInput', () => {
  it.each([[0], [10], ['12.5']])('%s pode ser gravado', (v) => {
    expect(isValidInput(v)).toBe(true);
  });

  it.each([[''], ['abc'], [null], [undefined], [-1]])('%s não pode', (v) => {
    expect(isValidInput(v)).toBe(false);
  });
});
