/**
 * Meios de entrada nos quadros por torneio (pedido do NSOP: "não indica os
 * Dobles nem os Buy-in Promocionais"). O que estes testes prendem:
 * - uma coluna por (categoria, nome), na ordem Buy-in → Rebuy → Add-on → Taxa;
 * - o mesmo meio em torneios diferentes é UMA coluna (cada torneio tem o seu
 *   "Buy-in" com id próprio), sem diferenciar maiúsculas;
 * - o mesmo nome em duas categorias é marcado, para o rótulo dizer qual é;
 * - a contagem é de entradas e soma meios repetidos do mesmo torneio.
 */
import { meiosDosTorneios, entradasPorMeio, chaveDoMeio } from './meiosDosTorneios';

const MAIN = {
  tournament_name: 'MAIN EVET 100K',
  by_buy_type: [
    { name: 'Buy-in', category: 'buy_in', count: 127 },
    { name: 'Buy-in Promocion', category: 'buy_in', count: 32 },
    { name: 'Rebuy', category: 'rebuy', count: 35 },
    { name: 'Doble', category: 'rebuy', count: 33 },
    { name: 'Bono Dealer', category: 'fee', count: 188 },
    { name: 'Bono Doble', category: 'fee', count: 29 },
  ],
};
const PKO = {
  tournament_name: 'START UP PKO',
  by_buy_type: [
    { name: 'Buy-in', category: 'buy_in', count: 19 },
    { name: 'BONUS DEALER', category: 'fee', count: 19 },
  ],
};
const STARTUP = {
  tournament_name: 'START UP',
  by_buy_type: [
    { name: 'Addon', category: 'addon', count: 18 },
    { name: 'Bonus Dealer', category: 'fee', count: 25 },
    { name: 'Rebuy Doble', category: 'rebuy', count: 1 },
  ],
};

describe('meiosDosTorneios', () => {
  it('uma coluna por meio, na ordem das categorias', () => {
    const nomes = meiosDosTorneios([MAIN, PKO, STARTUP]).map((m) => m.nome);
    expect(nomes).toEqual([
      'Buy-in', 'Buy-in Promocion',
      'Rebuy', 'Doble', 'Rebuy Doble',
      'Addon',
      'Bono Dealer', 'Bono Doble', 'BONUS DEALER',
    ]);
  });

  it('o mesmo meio em outro torneio (e outra caixa) não vira outra coluna', () => {
    const colunas = meiosDosTorneios([PKO, STARTUP]);
    expect(colunas.filter((m) => m.categoria === 'fee')).toHaveLength(1);
    expect(colunas.filter((m) => m.categoria === 'buy_in')).toHaveLength(1);
  });

  it('o mesmo nome em duas categorias é marcado como repetido', () => {
    const colunas = meiosDosTorneios([{
      by_buy_type: [
        { name: 'Doble', category: 'buy_in', count: 2 },
        { name: 'Doble', category: 'rebuy', count: 5 },
        { name: 'Rebuy', category: 'rebuy', count: 1 },
      ],
    }]);
    expect(colunas.map((m) => [m.nome, m.categoria, m.repetido])).toEqual([
      ['Doble', 'buy_in', true], ['Doble', 'rebuy', true], ['Rebuy', 'rebuy', false],
    ]);
  });

  it('sem meios (servidor antigo ou período vazio), nenhuma coluna', () => {
    expect(meiosDosTorneios(undefined)).toEqual([]);
    expect(meiosDosTorneios([{ tournament_name: 'X' }])).toEqual([]);
    expect(meiosDosTorneios([{ by_buy_type: [{ name: '  ', category: 'buy_in', count: 3 }] }])).toEqual([]);
  });
});

describe('entradasPorMeio', () => {
  it('as entradas de um torneio por coluna', () => {
    const entradas = entradasPorMeio(MAIN);
    expect(entradas[chaveDoMeio({ name: 'Doble', category: 'rebuy' })]).toBe(33);
    expect(entradas[chaveDoMeio({ name: 'Buy-in Promocion', category: 'buy_in' })]).toBe(32);
  });

  it('casa com a coluna mesmo com outra caixa no nome', () => {
    const [coluna] = meiosDosTorneios([STARTUP]).filter((m) => m.categoria === 'fee');
    expect(entradasPorMeio(PKO)[coluna.chave]).toBe(19);
  });

  it('dois meios do mesmo torneio com o mesmo nome somam', () => {
    const entradas = entradasPorMeio({
      by_buy_type: [
        { name: 'Rebuy', category: 'rebuy', count: 4 },
        { name: 'rebuy ', category: 'rebuy', count: 2 },
      ],
    });
    expect(entradas['rebuy:rebuy']).toBe(6);
  });
});
