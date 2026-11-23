/**
 * Meios de entrada do período nos relatórios. O que estes testes prendem:
 * - um servidor que manda um meio POR TORNEIO ("Buy-in" 15 vezes) vira uma
 *   linha por (categoria, nome), somada — era o que estourava o PDF;
 * - maiúsculas não separam meios ("Bono Dealer" e "BONO DEALER");
 * - a ordem é Buy-in → Rebuy → Add-on → Taxa;
 * - o jogador soma as grafias do mesmo nome na coluna.
 */
import { agruparMeiosDoPeriodo, colunasDosJogadores, entradasDoJogador } from './meiosDoPeriodo';

describe('agruparMeiosDoPeriodo', () => {
  it('um meio repetido por torneio vira uma linha só, somada', () => {
    const linhas = agruparMeiosDoPeriodo([
      { name: 'Buy-in', category: 'buy_in', count: 127, amount: 63500 },
      { name: 'Buy-in', category: 'buy_in', count: 18, amount: 9000.1 },
      { name: 'Buy-in ', category: 'buy_in', count: 7, amount: 700.2 },
    ]);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ name: 'Buy-in', count: 152, amount: 73200.3 });
  });

  it('maiúsculas não separam; o nome que fica é o primeiro', () => {
    const linhas = agruparMeiosDoPeriodo([
      { name: 'Bono Dealer', category: 'fee', count: 1, amount: 50 },
      { name: 'BONO DEALER', category: 'fee', count: 2, amount: 100 },
    ]);
    expect(linhas.map((l) => [l.name, l.count])).toEqual([['Bono Dealer', 3]]);
  });

  it('o mesmo nome em categorias diferentes são meios diferentes', () => {
    const linhas = agruparMeiosDoPeriodo([
      { name: 'Doble', category: 'rebuy', count: 5, amount: 0 },
      { name: 'Doble', category: 'buy_in', count: 2, amount: 0 },
    ]);
    expect(linhas.map((l) => [l.name, l.category])).toEqual([['Doble', 'buy_in'], ['Doble', 'rebuy']]);
  });

  it('ordena por categoria e mantém a ordem de chegada dentro dela', () => {
    const linhas = agruparMeiosDoPeriodo([
      { name: 'Bono Dealer', category: 'fee', count: 1, amount: 0 },
      { name: 'Rebuy', category: 'rebuy', count: 1, amount: 0 },
      { name: 'Buy-in', category: 'buy_in', count: 1, amount: 0 },
      { name: 'Addon', category: 'addon', count: 1, amount: 0 },
      { name: 'Doble', category: 'rebuy', count: 1, amount: 0 },
      { name: 'Buy-in Promocion', category: 'buy_in', count: 1, amount: 0 },
    ]);
    expect(linhas.map((l) => l.name)).toEqual(['Buy-in', 'Buy-in Promocion', 'Rebuy', 'Doble', 'Addon', 'Bono Dealer']);
  });

  it('sem lista (servidor antigo) ou com nome vazio, fica de fora', () => {
    expect(agruparMeiosDoPeriodo(undefined)).toEqual([]);
    expect(agruparMeiosDoPeriodo([{ name: '  ', category: 'buy_in', count: 3 }])).toEqual([]);
  });
});

describe('colunas do quadro de jogadores', () => {
  const MEIOS = agruparMeiosDoPeriodo([
    { name: 'Buy-in', category: 'buy_in', count: 1, amount: 0 },
    { name: 'Doble', category: 'rebuy', count: 1, amount: 0 },
    { name: 'Doble', category: 'buy_in', count: 1, amount: 0 },
    { name: 'Bono Dealer', category: 'fee', count: 1, amount: 0 },
  ]);

  it('uma coluna por nome (o jogador não diz a categoria)', () => {
    expect(colunasDosJogadores(MEIOS).map((c) => c.nome)).toEqual(['Buy-in', 'Doble', 'Bono Dealer']);
  });

  it('o jogador soma as grafias do mesmo nome', () => {
    const jogador = { by_buy_type: { 'Bono Dealer': 1, 'BONO DEALER': 2, 'Buy-in': 4 } };
    const [buyIn, doble, bono] = colunasDosJogadores(MEIOS);
    expect(entradasDoJogador(jogador, buyIn.chave)).toBe(4);
    expect(entradasDoJogador(jogador, doble.chave)).toBe(0);
    expect(entradasDoJogador(jogador, bono.chave)).toBe(3);
  });

  it('jogador sem meios fica com zero', () => {
    expect(entradasDoJogador({}, 'buy-in')).toBe(0);
    expect(entradasDoJogador(undefined, 'buy-in')).toBe(0);
  });
});
