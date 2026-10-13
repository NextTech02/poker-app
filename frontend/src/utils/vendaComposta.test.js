import {
  alternarItem, fichasDoTipo, linhasDaMesmaVenda, montarItens, totaisDosItens,
} from './vendaComposta';

const TIPOS = [
  { id: 'e', name: 'Entrada', category: 'buy_in', amount: 200, chips: 20000 },
  { id: 'r', name: 'Rebuy', category: 'rebuy', amount: 150, chips: 20000 },
  { id: 'd', name: 'Doble', category: 'rebuy', amount: 300, chips: 45000 },
  { id: 'a', name: 'Addon', category: 'addon', amount: 100, chips: 15000 },
  { id: 'b', name: 'Bono Dealer', category: 'addon', amount: 20, chips: 10000 },
];

describe('alternarItem — uma entrada por venda, extras à vontade', () => {
  it('marca e desmarca', () => {
    expect(alternarItem([], 'e', TIPOS)).toEqual(['e']);
    expect(alternarItem(['e'], 'e', TIPOS)).toEqual([]);
  });

  it('extras se somam à entrada', () => {
    expect(alternarItem(alternarItem(['e'], 'b', TIPOS), 'a', TIPOS)).toEqual(['e', 'b', 'a']);
  });

  it('marcar outra entrada troca a anterior e mantém os extras', () => {
    expect(alternarItem(['e', 'b'], 'd', TIPOS)).toEqual(['b', 'd']);
    expect(alternarItem(['r'], 'e', TIPOS)).toEqual(['e']);
  });

  it('id que não está na lista é ignorado', () => {
    expect(alternarItem(['e'], 'zz', TIPOS)).toEqual(['e']);
  });
});

describe('montarItens e totais', () => {
  it('entrada primeiro, extras na ordem da lista, com valor e fichas de cada um', () => {
    const itens = montarItens(['b', 'e'], TIPOS, null);
    expect(itens.map((i) => i.name)).toEqual(['Entrada', 'Bono Dealer']);
    expect(totaisDosItens(itens)).toEqual({ amount: 220, chips: 30000 });
  });

  it('meio sem preço próprio cobra o valor do dia', () => {
    const tipos = [{ id: 'x', name: 'Legado', category: 'addon', amount: null, chips: 5000 }];
    expect(montarItens(['x'], tipos, null, () => 400)[0].amount).toBe(400);
  });

  it('zero é preço legítimo, não cai no valor do dia', () => {
    const tipos = [{ id: 'x', name: 'Classificado', category: 'buy_in', amount: 0, chips: 0 }];
    expect(montarItens(['x'], tipos, null, () => 999)[0].amount).toBe(0);
  });

  it('fichas: as do meio; sem número nele, as do dia (rebuy/add-on caem em 10.000)', () => {
    const dia = { starting_chips: 25000, rebuy_chips: null, addon_chips: 12000 };
    expect(fichasDoTipo({ category: 'buy_in', chips: 30000 }, dia)).toBe(30000);
    expect(fichasDoTipo({ category: 'buy_in', chips: null }, dia)).toBe(25000);
    expect(fichasDoTipo({ category: 'rebuy', chips: null }, dia)).toBe(10000);
    expect(fichasDoTipo({ category: 'addon' }, dia)).toBe(12000);
  });

  it('soma sem erro de arredondamento de centavos', () => {
    expect(totaisDosItens([{ amount: 0.1, chips: 1 }, { amount: 0.2, chips: 2 }])).toEqual({ amount: 0.3, chips: 3 });
  });
});

describe('linhasDaMesmaVenda — reimpressão da venda inteira', () => {
  const linha = (x) => ({
    tournament_id: 't', player_id: 'p', tournament_player_id: 'tp', created_by: 'u', status: 'active', ...x,
  });
  const entrada = linha({ id: '1', type: 'buy_in', created_at: '2026-10-12T20:00:00Z' });

  it('junta a entrada e o add-on lançados juntos, entrada primeiro', () => {
    const bono = linha({ id: '2', type: 'addon', created_at: '2026-10-12T20:00:03Z' });
    expect(linhasDaMesmaVenda(entrada, [bono, entrada]).map((l) => l.id)).toEqual(['1', '2']);
  });

  it('deixa de fora: outro jogador, outro operador, estornada, fora da janela, outra entrada', () => {
    const outras = [
      linha({ id: 'j', type: 'addon', tournament_player_id: 'outro', created_at: '2026-10-12T20:00:01Z' }),
      linha({ id: 'o', type: 'addon', created_by: 'outro', created_at: '2026-10-12T20:00:01Z' }),
      linha({ id: 'c', type: 'addon', status: 'cancelled', created_at: '2026-10-12T20:00:01Z' }),
      linha({ id: 'h', type: 'addon', created_at: '2026-10-12T22:00:00Z' }),
      linha({ id: 'r', type: 'rebuy', created_at: '2026-10-12T20:01:00Z' }),
    ];
    expect(linhasDaMesmaVenda(entrada, [entrada, ...outras]).map((l) => l.id)).toEqual(['1']);
  });

  it('a própria linha entra mesmo fora da lista carregada', () => {
    expect(linhasDaMesmaVenda(entrada, []).map((l) => l.id)).toEqual(['1']);
  });
});
