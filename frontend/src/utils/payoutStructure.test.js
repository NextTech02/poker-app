import { calculatePayoutAllocations, getPaidPositions } from './payoutStructure';

/**
 * Estrutura de premiação: quanto cada colocação recebe conforme o número de
 * entradas. É a divisão do dinheiro do torneio — um erro aqui paga a mais (o
 * clube cobre a diferença) ou a menos (o jogador sai lesado).
 */
describe('calculatePayoutAllocations', () => {
  describe('entradas ou pool inválidos', () => {
    it.each([
      ['sem entradas', 0, 1000],
      ['entradas negativas', -5, 1000],
      ['sem pool', 10, 0],
      ['pool negativo', 10, -100],
      ['ambos ausentes', null, null],
    ])('%s não gera premiação', (_rotulo, entradas, pool) => {
      expect(calculatePayoutAllocations(entradas, pool)).toEqual([]);
    });
  });

  describe('faixas da tabela', () => {
    it('até 5 jogadores paga 2 lugares (65/35)', () => {
      const r = calculatePayoutAllocations(5, 1000);
      expect(r).toHaveLength(2);
      expect(r[0]).toMatchObject({ position: 1, percentage: 65 });
      expect(r[1]).toMatchObject({ position: 2, percentage: 35 });
    });

    it('de 6 a 17 jogadores paga 3 lugares (50/30/20)', () => {
      const r = calculatePayoutAllocations(12, 1000);
      expect(r.map((a) => a.percentage)).toEqual([50, 30, 20]);
      expect(r.map((a) => a.prize_amount)).toEqual([500, 300, 200]);
    });

    it('de 18 a 26 jogadores paga 4 lugares', () => {
      expect(calculatePayoutAllocations(20, 1000)).toHaveLength(4);
    });

    it('a faixa muda exatamente no limite', () => {
      // 5 -> 2 lugares; 6 -> 3 lugares
      expect(calculatePayoutAllocations(5, 1000)).toHaveLength(2);
      expect(calculatePayoutAllocations(6, 1000)).toHaveLength(3);
      // 17 -> 3; 18 -> 4
      expect(calculatePayoutAllocations(17, 1000)).toHaveLength(3);
      expect(calculatePayoutAllocations(18, 1000)).toHaveLength(4);
    });

    it('faixas com intervalo expandem em uma linha por colocação', () => {
      // A partir de 63 jogadores ha faixas do tipo [10,11,x]: duas posicoes
      // com o mesmo percentual, e cada uma precisa virar uma linha.
      const r = calculatePayoutAllocations(70, 10000);
      const posicoes = r.map((a) => a.position);
      expect(posicoes).toEqual([...new Set(posicoes)]);          // sem repetidas
      expect(posicoes).toEqual([...posicoes].sort((a, b) => a - b)); // em ordem
      expect(r).toHaveLength(11);
    });
  });

  describe('fechamento do dinheiro', () => {
    it('a soma nunca ultrapassa o prize pool', () => {
      for (const entradas of [3, 12, 25, 40, 80, 150, 400]) {
        const pool = 12345;
        const total = calculatePayoutAllocations(entradas, pool)
          .reduce((s, a) => s + a.prize_amount, 0);
        expect(total).toBeLessThanOrEqual(Math.floor(pool));
      }
    });

    it('a sobra do arredondamento vai para o primeiro lugar', () => {
      // 1000 em 3 lugares (50/30/20) fecha exato; com 1001 sobra 1 real
      const r = calculatePayoutAllocations(12, 1001);
      const total = r.reduce((s, a) => s + a.prize_amount, 0);
      expect(total).toBe(1001);
      expect(r[0].prize_amount).toBe(501);   // 500 + a sobra
    });

    it('todos os valores são inteiros, sem centavos quebrados', () => {
      const r = calculatePayoutAllocations(70, 9999);
      r.forEach((a) => expect(Number.isInteger(a.prize_amount)).toBe(true));
    });

    it('nenhum prêmio fica negativo ao acertar o arredondamento', () => {
      const r = calculatePayoutAllocations(80, 101);
      r.forEach((a) => expect(a.prize_amount).toBeGreaterThanOrEqual(0));
    });

    it('pool pequeno ainda distribui sem estourar', () => {
      const r = calculatePayoutAllocations(12, 10);
      const total = r.reduce((s, a) => s + a.prize_amount, 0);
      expect(total).toBeLessThanOrEqual(10);
    });
  });
});

describe('getPaidPositions', () => {
  it.each([
    [3, 2],
    [12, 3],
    [20, 4],
    [30, 5],
  ])('%i jogadores pagam %i lugares', (entradas, esperado) => {
    expect(getPaidPositions(entradas)).toBe(esperado);
  });

  it('acima da última faixa usa a maior estrutura', () => {
    // Nao pode devolver 0: um torneio gigante ficaria sem premiacao.
    expect(getPaidPositions(99999)).toBeGreaterThan(0);
  });
});
