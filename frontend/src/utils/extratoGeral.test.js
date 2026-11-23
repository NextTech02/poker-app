/**
 * Extrato Geral: o filtro por meio real e o quadro de totais.
 *
 * O que estes testes prendem:
 * - **"Dinheiro" é só dinheiro.** Quase toda venda tem `payment_source =
 *   'cash'`; o meio de verdade (Yape, cartão) está em `payment_method`. O
 *   filtro antigo, pela origem, punha o Yape no total do dinheiro.
 * - **Venda dividida entra só com a parte do meio filtrado** — a mesma regra
 *   da gaveta.
 * - **Crédito, misto e ticket são origens**, fora de qualquer meio.
 * - **O quadro separa por tipo de venda e por meio de entrada**, com o prêmio
 *   como saída.
 */
import {
  lerFiltro, filtroDeMeio, filtroDeOrigem, centavosNoFiltro, meiosDoFiltro, resumirExtrato, tipoDaLinha,
} from './extratoGeral';

const DINHEIRO = { meio: 'cash' };

describe('lerFiltro', () => {
  it('distingue meio de origem pelo prefixo', () => {
    expect(lerFiltro(filtroDeMeio('yape'))).toEqual({ meio: 'yape' });
    expect(lerFiltro(filtroDeOrigem('credit'))).toEqual({ origem: 'credit' });
  });

  it('um meio personalizado com código "credit" não vira a origem crédito', () => {
    // slug de "Credit": o cadastro de meios não reserva esse código.
    expect(lerFiltro(filtroDeMeio('credit'))).toEqual({ meio: 'credit' });
  });

  it('vazio (ou valor sem prefixo) é "todas"', () => {
    expect(lerFiltro('')).toBeNull();
    expect(lerFiltro('cash')).toBeNull();
  });
});

describe('centavosNoFiltro', () => {
  it('sem filtro, a linha entra inteira', () => {
    expect(centavosNoFiltro({ amount: 400, payment_method: 'yape' }, null)).toBe(40000);
  });

  it('"Dinheiro" traz a venda em dinheiro e deixa o Yape e o cartão de fora', () => {
    expect(centavosNoFiltro({ amount: 400, payment_source: 'cash', payment_method: 'cash' }, DINHEIRO)).toBe(40000);
    expect(centavosNoFiltro({ amount: 400, payment_source: 'cash', payment_method: 'yape' }, DINHEIRO)).toBeNull();
    expect(centavosNoFiltro({ amount: 400, payment_source: 'cash', payment_method: 'card' }, DINHEIRO)).toBeNull();
  });

  it('linha sem meio gravado (antiga, ou o prêmio) é dinheiro, como na gaveta', () => {
    expect(centavosNoFiltro({ type: 'prize', amount: 30000, payment_source: 'cash' }, DINHEIRO)).toBe(3000000);
    expect(centavosNoFiltro({ amount: 50 }, DINHEIRO)).toBe(5000);
  });

  it('o filtro de um meio personalizado traz só esse meio', () => {
    expect(centavosNoFiltro({ amount: 80, payment_source: 'cash', payment_method: 'yape' }, { meio: 'yape' })).toBe(8000);
    expect(centavosNoFiltro({ amount: 80, payment_source: 'cash', payment_method: 'cash' }, { meio: 'yape' })).toBeNull();
  });

  it('venda dividida entra só com a parte do meio filtrado', () => {
    const dividida = {
      amount: 500,
      payment_source: 'cash',
      payment_method: 'split',
      payment_split: [{ payment_method: 'cash', amount: 300 }, { payment_method: 'transfer', amount: 200 }],
    };
    expect(centavosNoFiltro(dividida, DINHEIRO)).toBe(30000);
    expect(centavosNoFiltro(dividida, { meio: 'transfer' })).toBe(20000);
    expect(centavosNoFiltro(dividida, { meio: 'yape' })).toBeNull();
    expect(centavosNoFiltro(dividida, null)).toBe(50000);
  });

  it('as partes também valem quando chegam como texto JSON', () => {
    const dividida = {
      amount: 500,
      payment_source: 'cash',
      payment_method: 'split',
      payment_split: JSON.stringify([{ payment_method: 'cash', amount: 300 }, { payment_method: 'yape', amount: 200 }]),
    };
    expect(centavosNoFiltro(dividida, DINHEIRO)).toBe(30000);
  });

  it('crédito, misto e ticket não entram em meio nenhum', () => {
    // O método "cash" nessas linhas é o padrão do formulário, não dinheiro recebido.
    ['credit', 'mixed', 'ticket'].forEach((origem) => {
      expect(centavosNoFiltro({ amount: 300, payment_source: origem, payment_method: 'cash' }, DINHEIRO)).toBeNull();
    });
  });

  it('o filtro por origem traz a linha inteira, mesmo a de valor zero', () => {
    expect(centavosNoFiltro({ amount: 300, payment_source: 'credit' }, { origem: 'credit' })).toBe(30000);
    expect(centavosNoFiltro({ amount: 0, payment_source: 'ticket' }, { origem: 'ticket' })).toBe(0);
    expect(centavosNoFiltro({ amount: 300, payment_source: 'cash' }, { origem: 'credit' })).toBeNull();
  });
});

describe('meiosDoFiltro', () => {
  const CLUBE = [
    { code: 'cash', label: 'Efectivo', active: true },
    { code: 'yape', label: 'YAPE', active: true },
    { code: 'card', label: 'Tarjeta', active: true },
    { code: 'plin', label: 'PLIN', active: false },
  ];

  it('dinheiro primeiro, depois os meios ativos do clube na ordem do cadastro', () => {
    expect(meiosDoFiltro(CLUBE, [])).toEqual(['cash', 'yape', 'card']);
  });

  it('um meio desativado que aparece nas vendas continua filtrável', () => {
    const linhas = [{ amount: 10, payment_source: 'cash', payment_method: 'plin' }];
    expect(meiosDoFiltro(CLUBE, linhas)).toEqual(['cash', 'yape', 'card', 'plin']);
  });

  it('as partes da venda dividida contam; o código "split" nunca vira opção', () => {
    const linhas = [{
      amount: 10, payment_source: 'cash', payment_method: 'split',
      payment_split: [{ payment_method: 'cash', amount: 5 }, { payment_method: 'zelle', amount: 5 }],
    }];
    expect(meiosDoFiltro([], linhas)).toEqual(['cash', 'zelle']);
  });

  it('sem cadastro carregado, oferece o dinheiro e o que houver nas vendas', () => {
    const linhas = [
      { amount: 10, payment_source: 'cash', payment_method: 'yape' },
      { amount: 10, payment_source: 'credit', payment_method: 'boleto' },
    ];
    expect(meiosDoFiltro(undefined, linhas)).toEqual(['cash', 'yape']);
  });
});

describe('tipoDaLinha', () => {
  it('a taxa (add-on com is_fee) tem tipo próprio', () => {
    expect(tipoDaLinha({ type: 'addon', is_fee: true })).toBe('fee');
    expect(tipoDaLinha({ type: 'addon' })).toBe('addon');
    expect(tipoDaLinha({ type: 'rebuy' })).toBe('rebuy');
  });
});

describe('resumirExtrato', () => {
  const linha = (tx) => ({ tx, centavos: Math.round(tx.amount * 100) });

  it('separa por tipo de venda, na ordem do balcão, e põe o prêmio como saída', () => {
    const resumo = resumirExtrato([
      linha({ type: 'prize', amount: 1000 }),
      linha({ type: 'addon', is_fee: true, amount: 40, buy_type_name: 'Bono Dealer' }),
      linha({ type: 'rebuy', amount: 400 }),
      linha({ type: 'buy_in', amount: 400 }),
      linha({ type: 'buy_in', amount: 400 }),
      linha({ type: 'addon', amount: 200 }),
    ]);
    expect(resumo.entradas.map((g) => [g.tipo, g.quantidade, g.total])).toEqual([
      ['buy_in', 2, 800], ['rebuy', 1, 400], ['addon', 1, 200], ['fee', 1, 40],
    ]);
    expect(resumo.saidas.map((g) => [g.tipo, g.quantidade, g.total])).toEqual([['prize', 1, 1000]]);
    expect(resumo.recebido).toBe(1440);
    expect(resumo.pago).toBe(1000);
    expect(resumo.saldo).toBe(440);
    expect(resumo.quantidade).toBe(6);
  });

  it('dentro do tipo, abre por meio de entrada (o maior primeiro)', () => {
    const resumo = resumirExtrato([
      linha({ type: 'rebuy', amount: 400, buy_type_name: 'Rebuy' }),
      linha({ type: 'rebuy', amount: 1000, buy_type_name: 'Doble' }),
      linha({ type: 'rebuy', amount: 400, buy_type_name: 'Rebuy' }),
      linha({ type: 'rebuy', amount: 400 }),
    ]);
    expect(resumo.entradas[0].meios).toEqual([
      { nome: 'Doble', quantidade: 1, total: 1000 },
      { nome: 'Rebuy', quantidade: 2, total: 800 },
      { nome: null, quantidade: 1, total: 400 },
    ]);
  });

  it('um meio de entrada só não ganha detalhe: repetiria o tipo', () => {
    const resumo = resumirExtrato([
      linha({ type: 'buy_in', amount: 400, buy_type_name: 'Buy-in' }),
      linha({ type: 'buy_in', amount: 400, buy_type_name: 'Buy-in' }),
    ]);
    expect(resumo.entradas[0].meios).toEqual([]);
  });

  it('o rótulo do subgrupo é da tela (o KO do prêmio, por exemplo)', () => {
    const rotulo = (tx) => (tx.prize_kind === 'knockout' ? 'KO' : null);
    const resumo = resumirExtrato([
      linha({ type: 'prize', amount: 5000 }),
      linha({ type: 'prize', amount: 100, prize_kind: 'knockout' }),
    ], rotulo);
    expect(resumo.saidas[0].meios.map((m) => m.nome)).toEqual([null, 'KO']);
  });

  it('soma em centavos: 0,10 + 0,20 dá 0,30', () => {
    const resumo = resumirExtrato([
      linha({ type: 'addon', amount: 0.1 }),
      linha({ type: 'addon', amount: 0.2 }),
    ]);
    expect(resumo.recebido).toBe(0.3);
  });

  it('usa o valor que o filtro deixou (a parte da venda dividida), não o da linha', () => {
    const resumo = resumirExtrato([{ tx: { type: 'buy_in', amount: 500 }, centavos: 30000 }]);
    expect(resumo.recebido).toBe(300);
  });

  it('sem prêmio no filtro, não há saída', () => {
    const resumo = resumirExtrato([linha({ type: 'buy_in', amount: 400 })]);
    expect(resumo.saidas).toEqual([]);
    expect(resumo.saldo).toBe(400);
  });
});
