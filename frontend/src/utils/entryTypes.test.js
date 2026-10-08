/**
 * Regras puras dos meios de entrada do TORNEIO.
 *
 * O que mais importa aqui: a linha nova nasce com rake 20% (pedido do cliente),
 * a carregada mantém o que está gravado, e as colunas antigas do dia seguem o
 * primeiro meio de cada categoria — com rebuy/add-on zerados virando NULO.
 */
import {
  RAKE_PADRAO,
  colunasDoDia,
  linhasDaApi,
  meiosPadrao,
  meiosParaApi,
  novaLinha,
  removerLinha,
  validarMeios,
} from './entryTypes';

const t = (chave, padrao) => padrao || chave;

describe('novaLinha', () => {
  it('a linha nova nasce com rake 20%, fichas padrão e valor em branco', () => {
    // O valor fica em branco de propósito: é o que o operador precisa digitar.
    const l = novaLinha({ category: 'rebuy' });
    expect(l.rake_percentage).toBe(String(RAKE_PADRAO));
    expect(l.rake_percentage).toBe('20');
    expect(l.chips).toBe('10000');
    expect(l.amount).toBe('');
    expect(l.id).toBeNull();
  });

  it('a linha carregada mantém o rake gravado — inclusive zero', () => {
    // Zero é decisão, não ausência: não pode virar 20 só por ser carregado.
    const l = novaLinha({ id: 'm1', name: 'Buy-in', amount: 250, rake_percentage: 0, chips: 30000 });
    expect(l.rake_percentage).toBe('0');
    expect(l.amount).toBe('250');
    expect(l.chips).toBe('30000');
  });

  it('cada linha ganha uma chave própria para o React', () => {
    expect(novaLinha().key).not.toBe(novaLinha().key);
  });
});

describe('meiosPadrao', () => {
  it('são Buy-in, Rebuy e Add-on, nessa ordem, todos com rake 20', () => {
    const linhas = meiosPadrao(t);
    expect(linhas.map((l) => l.category)).toEqual(['buy_in', 'rebuy', 'addon']);
    expect(linhas.map((l) => l.name)).toEqual(['Buy-in', 'Rebuy', 'Add-on']);
    expect(linhas.every((l) => l.rake_percentage === '20')).toBe(true);
  });
});

describe('linhasDaApi', () => {
  it('ordena os ativos pelo sort_order e separa os inativos', () => {
    const { ativos, inativos } = linhasDaApi([
      { id: 'b', name: 'Rebuy', category: 'rebuy', sort_order: 1, active: true, amount: 100, rake_percentage: 10, chips: 1 },
      { id: 'x', name: 'Velho', category: 'buy_in', sort_order: 9, active: false, amount: 50, rake_percentage: 5, chips: 1 },
      { id: 'a', name: 'Buy-in', category: 'buy_in', sort_order: 0, active: true, amount: 100, rake_percentage: 10, chips: 1 },
    ]);
    expect(ativos.map((l) => l.id)).toEqual(['a', 'b']);
    expect(inativos.map((m) => m.id)).toEqual(['x']);
  });

  it('resposta que não é lista vira lista vazia', () => {
    expect(linhasDaApi(null)).toEqual({ ativos: [], inativos: [] });
  });
});

describe('validarMeios', () => {
  it('meio sem nome é recusado', () => {
    expect(validarMeios([novaLinha({ name: '  ' })], t)).toBe('Dê um nome a cada meio de entrada.');
  });

  it('lista sem nenhum meio de Entrada é recusada', () => {
    expect(validarMeios([novaLinha({ name: 'Rebuy', category: 'rebuy' })], t)).toMatch(/ao menos um meio de entrada/);
  });

  it('lista válida passa em branco', () => {
    expect(validarMeios(meiosPadrao(t), t)).toBe('');
  });
});

describe('removerLinha', () => {
  it('não deixa remover o último meio de Entrada', () => {
    const linhas = meiosPadrao(t);
    const { linhas: depois, erro } = removerLinha(linhas, linhas[0].key, t);
    expect(depois).toBe(linhas);
    expect(erro).toMatch(/ao menos um meio de entrada/);
  });

  it('remove qualquer outro', () => {
    const linhas = meiosPadrao(t);
    const { linhas: depois, erro } = removerLinha(linhas, linhas[2].key, t);
    expect(depois.map((l) => l.category)).toEqual(['buy_in', 'rebuy']);
    expect(erro).toBe('');
  });
});

describe('meiosParaApi', () => {
  it('converte texto em número, apara o nome e usa a posição como sort_order', () => {
    const itens = meiosParaApi([
      novaLinha({ id: 'a', name: ' Buy-in ', amount: '250.5', rake_percentage: '15', chips: '30000' }),
      novaLinha({ name: 'Rebuy', category: 'rebuy', amount: '', rake_percentage: '20', chips: '10000' }),
    ]);
    expect(itens[0]).toMatchObject({ id: 'a', name: 'Buy-in', amount: 250.5, rake_percentage: 15, chips: 30000, active: true, sort_order: 0 });
    expect(itens[1]).toMatchObject({ id: null, amount: 0, sort_order: 1 });
  });

  it('os inativos voltam intocados, depois dos ativos', () => {
    // Vendas antigas apontam para eles; sumir com eles apagaria o rótulo do recibo.
    const inativo = { id: 'velho', name: 'Promo', category: 'buy_in', amount: 50, rake_percentage: 5, chips: 5000, active: false };
    const itens = meiosParaApi(meiosPadrao(t), [inativo]);
    expect(itens).toHaveLength(4);
    expect(itens[3]).toMatchObject({ id: 'velho', active: false, sort_order: 3, amount: 50 });
  });
});

describe('colunasDoDia', () => {
  it('o primeiro meio de cada categoria vira a coluna antiga do dia', () => {
    const colunas = colunasDoDia([
      novaLinha({ name: 'Buy-in', amount: '250', chips: '15000' }),
      novaLinha({ name: 'Buy-in turbo', amount: '400', chips: '40000' }),
      novaLinha({ name: 'Rebuy', category: 'rebuy', amount: '100', chips: '10000' }),
      novaLinha({ name: 'Add-on', category: 'addon', amount: '80', chips: '20000' }),
    ]);
    expect(colunas).toEqual({
      buy_in: 250, starting_chips: 15000,
      rebuy_amount: 100, rebuy_chips: 10000,
      addon_amount: 80, addon_chips: 20000,
    });
  });

  it('rebuy e add-on zerados ou ausentes viram NULO, não zero', () => {
    // "Rebuy de R$ 0,00" diria que o rebuy é de graça; nulo diz que não existe.
    const colunas = colunasDoDia([
      novaLinha({ name: 'Buy-in', amount: '100', chips: '10000' }),
      novaLinha({ name: 'Rebuy', category: 'rebuy', amount: '0', chips: '5000' }),
    ]);
    expect(colunas.rebuy_amount).toBeNull();
    expect(colunas.rebuy_chips).toBe(5000);
    expect(colunas.addon_amount).toBeNull();
    expect(colunas.addon_chips).toBe(0);
  });

  it('aceita as linhas como vêm da API (números, não texto)', () => {
    const colunas = colunasDoDia([{ name: 'Buy-in', category: 'buy_in', amount: 500, chips: 30000 }]);
    expect(colunas.buy_in).toBe(500);
    expect(colunas.starting_chips).toBe(30000);
  });
});
