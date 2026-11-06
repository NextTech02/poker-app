import {
  eDividido,
  fundirPartes,
  pagamentoDoItem,
  partesDaLinha,
  repartirPagamento,
  restanteDasPartes,
  rotuloDoPagamento,
  validarPartes,
} from './pagamentoDividido';

const P = (payment_method, amount) => ({ payment_method, amount });

describe('repartir o total pago entre os itens da venda', () => {
  it('entrada 500 + taxa 50 paga com 300 em dinheiro + 250 em transferência', () => {
    const r = repartirPagamento([{ amount: 500 }, { amount: 50 }], [P('cash', '300'), P('transfer', '250')]);
    expect(r).toEqual([
      // A entrada fica dividida; a maior parte vai no meio de reserva.
      {
        payment_method: 'cash',
        payment_split: [P('cash', 300), P('transfer', 200)],
      },
      // A taxa cai inteira na transferência: vira venda de um meio só.
      { payment_method: 'transfer', payment_split: null },
    ]);
  });

  it('o pedido do cliente: entrada de 500 com 300 + 200', () => {
    const [entrada] = repartirPagamento([{ amount: 500 }], [P('cash', 300), P('transfer', 200)]);
    expect(entrada.payment_split).toEqual([P('cash', 300), P('transfer', 200)]);
  });

  it('em centavos: 0,10 + 0,20 fecha 0,30 sem erro de arredondamento', () => {
    const [item] = repartirPagamento([{ amount: 0.3 }], [P('cash', '0.1'), P('pix', '0.2')]);
    expect(item.payment_split).toEqual([P('cash', 0.1), P('pix', 0.2)]);
  });

  it('partes que não fecham o total devolvem null', () => {
    expect(repartirPagamento([{ amount: 500 }], [P('cash', 300), P('pix', 100)])).toBeNull();
    expect(repartirPagamento([{ amount: 500 }], [])).toBeNull();
  });

  it('item de valor zero leva o meio da parte em curso, sem divisão', () => {
    const r = repartirPagamento([{ amount: 0 }, { amount: 100 }], [P('cash', 60), P('pix', 40)]);
    expect(r[0]).toEqual({ payment_method: 'cash', payment_split: null });
    expect(r[1].payment_split).toEqual([P('cash', 60), P('pix', 40)]);
  });

  it('cada item fecha o seu valor e o total por meio bate com o digitado', () => {
    const itens = [{ amount: 120.5 }, { amount: 30 }, { amount: 49.5 }];
    const r = repartirPagamento(itens, [P('cash', 99.99), P('yape', 100.01)]);
    const porMeio = {};
    r.forEach((pag, i) => {
      const partes = pag.payment_split || [{ payment_method: pag.payment_method, amount: itens[i].amount }];
      const soma = partes.reduce((s, p) => s + Math.round(p.amount * 100), 0);
      expect(soma).toBe(Math.round(itens[i].amount * 100));
      partes.forEach((p) => { porMeio[p.payment_method] = (porMeio[p.payment_method] || 0) + Math.round(p.amount * 100); });
    });
    expect(porMeio).toEqual({ cash: 9999, yape: 10001 });
  });
});

describe('as partes do formulário', () => {
  it('soma meios repetidos na ordem em que apareceram e ignora linhas vazias', () => {
    expect(fundirPartes([P('pix', '200'), P('cash', ''), P('cash', '100'), P('pix', '50')]))
      .toEqual([P('pix', 250), P('cash', 100)]);
  });

  it('diz se falta, se sobra ou se fecha', () => {
    expect(validarPartes([P('cash', '300'), P('pix', '200')], 500)).toBeNull();
    expect(validarPartes([P('cash', '300')], 500)).toBe('falta');
    expect(validarPartes([P('cash', '600')], 500)).toBe('sobra');
    expect(validarPartes([P('cash', '')], 500)).toBe('vazio');
    expect(restanteDasPartes([P('cash', '300')], 500)).toBe(200);
  });

  it('um meio só não é divisão; vários levam a maior parte como reserva', () => {
    expect(pagamentoDoItem([P('pix', '250'), P('pix', '250')])).toEqual({ payment_method: 'pix', payment_split: null });
    expect(pagamentoDoItem([P('cash', '100'), P('transfer', '400')]).payment_method).toBe('transfer');
  });
});

describe('as partes de uma venda gravada', () => {
  const dividida = {
    payment_method: 'split',
    amount: 500,
    payment_split: [P('cash', 300), P('transfer', 200)],
  };

  it('lê as partes, inclusive em texto JSON', () => {
    expect(partesDaLinha(dividida)).toEqual([P('cash', 300), P('transfer', 200)]);
    expect(partesDaLinha({ ...dividida, payment_split: JSON.stringify(dividida.payment_split) }))
      .toEqual([P('cash', 300), P('transfer', 200)]);
    expect(partesDaLinha({ payment_method: 'pix', amount: '80' })).toEqual([P('pix', 80)]);
  });

  it('sabe quando é dividida', () => {
    expect(eDividido(dividida)).toBe(true);
    expect(eDividido({ payment_method: 'cash', amount: 1 })).toBe(false);
  });

  it('monta o rótulo com cada meio e o seu valor', () => {
    const rotulo = (code) => ({ cash: 'Dinheiro', transfer: 'Transferência', pix: 'PIX' }[code]);
    const moeda = (v) => `R$ ${v}`;
    expect(rotuloDoPagamento(dividida, rotulo, moeda)).toBe('Dinheiro R$ 300 · Transferência R$ 200');
    expect(rotuloDoPagamento({ payment_method: 'pix', amount: 10 }, rotulo, moeda)).toBe('PIX');
  });
});
