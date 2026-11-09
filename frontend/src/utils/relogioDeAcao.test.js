/**
 * O relógio de ação: a lógica sem tela, com o tempo passado à mão.
 *
 * O sistema não acompanha a mão nem sabe quem está agindo. O dealer dá um toque
 * por ação, e só quando o tempo acaba diz de quem é o cartão. É isso que mantém
 * o trabalho dele em um toque, e é o que estes testes prendem.
 */
import {
  FASE, RUA, estadoInicial, relogioReducer, segundosRestantes, nivelDeAlerta,
} from './relogioDeAcao';

const CONFIG = {
  preflop_seconds: 20, postflop_seconds: 30, called_clock_seconds: 30, card_seconds: 30,
};
const aplicar = (estado, tipo, agora) => relogioReducer(estado, { tipo, agora, config: CONFIG });

describe('contar', () => {
  it('começa parado: nada conta antes do primeiro toque', () => {
    expect(estadoInicial.fase).toBe(FASE.PARADO);
    expect(segundosRestantes(estadoInicial, 5000)).toBe(0);
  });

  it('nova mão conta o tempo do pré-flop', () => {
    const estado = aplicar(estadoInicial, 'NOVA_MAO', 1000);
    expect(estado.fase).toBe(FASE.CONTANDO);
    expect(estado.rua).toBe(RUA.PRE);
    expect(segundosRestantes(estado, 1000)).toBe(20);
  });

  it('próxima ação zera e conta de novo na mesma rua', () => {
    let estado = aplicar(estadoInicial, 'NOVA_MAO', 0);
    estado = aplicar(estado, 'PROXIMA', 15000);
    expect(segundosRestantes(estado, 15000)).toBe(20);
  });

  it('flop passa para o tempo do pós-flop e ele vale até o fim da mão', () => {
    let estado = aplicar(estadoInicial, 'NOVA_MAO', 0);
    estado = aplicar(estado, 'FLOP', 1000);
    expect(estado.rua).toBe(RUA.POS);
    expect(segundosRestantes(estado, 1000)).toBe(30);
    estado = aplicar(estado, 'PROXIMA', 2000);
    expect(segundosRestantes(estado, 2000)).toBe(30);
  });

  it('nova mão volta para o pré-flop', () => {
    let estado = aplicar(estadoInicial, 'FLOP', 0);
    estado = aplicar(estado, 'NOVA_MAO', 1000);
    expect(segundosRestantes(estado, 1000)).toBe(20);
  });

  it('próxima ação com o relógio parado começa pelo tempo da rua atual', () => {
    const estado = aplicar(estadoInicial, 'PROXIMA', 0);
    expect(estado.fase).toBe(FASE.CONTANDO);
    expect(segundosRestantes(estado, 0)).toBe(20);
  });

  it('arredonda para cima: 19,2 s ainda mostram 20', () => {
    const estado = aplicar(estadoInicial, 'NOVA_MAO', 0);
    expect(segundosRestantes(estado, 800)).toBe(20);
    expect(segundosRestantes(estado, 1000)).toBe(19);
  });
});

describe('acabar o tempo', () => {
  it('o tique marca esgotado quando passa do fim', () => {
    const estado = aplicar(estadoInicial, 'NOVA_MAO', 0);
    expect(aplicar(estado, 'TIQUE', 19999).fase).toBe(FASE.CONTANDO);
    expect(aplicar(estado, 'TIQUE', 20000).fase).toBe(FASE.ESGOTADO);
  });

  it('esgotado mostra zero, nunca negativo', () => {
    let estado = aplicar(estadoInicial, 'NOVA_MAO', 0);
    estado = aplicar(estado, 'TIQUE', 25000);
    expect(segundosRestantes(estado, 26000)).toBe(0);
  });

  it('o tique não muda nada fora da contagem', () => {
    expect(aplicar(estadoInicial, 'TIQUE', 99999)).toBe(estadoInicial);
  });
});

describe('pausar', () => {
  it('guarda o que faltava e retoma de onde parou', () => {
    let estado = aplicar(estadoInicial, 'NOVA_MAO', 0);
    estado = aplicar(estado, 'PAUSAR', 5000);
    expect(estado.fase).toBe(FASE.PAUSADO);
    expect(segundosRestantes(estado, 60000)).toBe(15);
    estado = aplicar(estado, 'RETOMAR', 60000);
    expect(estado.fase).toBe(FASE.CONTANDO);
    expect(segundosRestantes(estado, 60000)).toBe(15);
  });

  it('pausado não esgota', () => {
    let estado = aplicar(estadoInicial, 'NOVA_MAO', 0);
    estado = aplicar(estado, 'PAUSAR', 5000);
    expect(aplicar(estado, 'TIQUE', 99999).fase).toBe(FASE.PAUSADO);
  });

  it('parar zera a contagem e mantém a rua', () => {
    let estado = aplicar(estadoInicial, 'FLOP', 0);
    estado = aplicar(estado, 'PARAR', 1000);
    expect(estado.fase).toBe(FASE.PARADO);
    expect(estado.rua).toBe(RUA.POS);
  });
});

describe('cartão do time bank', () => {
  it('depois de esgotar, conta do zero o tempo do cartão', () => {
    let estado = aplicar(estadoInicial, 'NOVA_MAO', 0);
    estado = aplicar(estado, 'TIQUE', 21000);
    estado = aplicar(estado, 'CARTAO', 22000);
    expect(estado.fase).toBe(FASE.CONTANDO);
    expect(segundosRestantes(estado, 22000)).toBe(30);
    expect(estado.cartoesNaDecisao).toBe(1);
  });

  it('antes de esgotar, soma ao que ainda falta', () => {
    let estado = aplicar(estadoInicial, 'NOVA_MAO', 0);
    estado = aplicar(estado, 'CARTAO', 5000);
    expect(segundosRestantes(estado, 5000)).toBe(45);
  });

  it('pausado, soma ao que estava guardado', () => {
    let estado = aplicar(estadoInicial, 'NOVA_MAO', 0);
    estado = aplicar(estado, 'PAUSAR', 5000);
    estado = aplicar(estado, 'CARTAO', 6000);
    expect(estado.fase).toBe(FASE.PAUSADO);
    expect(segundosRestantes(estado, 6000)).toBe(45);
  });

  it('a próxima ação zera a conta de cartões da decisão', () => {
    let estado = aplicar(estadoInicial, 'NOVA_MAO', 0);
    estado = aplicar(estado, 'CARTAO', 1000);
    estado = aplicar(estado, 'CARTAO', 2000);
    expect(estado.cartoesNaDecisao).toBe(2);
    expect(aplicar(estado, 'PROXIMA', 3000).cartoesNaDecisao).toBe(0);
  });

  it('desfazer tira o tempo do cartão', () => {
    let estado = aplicar(estadoInicial, 'NOVA_MAO', 0);
    estado = aplicar(estado, 'CARTAO', 5000);
    estado = aplicar(estado, 'DESFAZER_CARTAO', 6000);
    expect(segundosRestantes(estado, 6000)).toBe(14);
    expect(estado.cartoesNaDecisao).toBe(0);
  });

  it('desfazer quando o tempo já não sobra volta a esgotado', () => {
    let estado = aplicar(estadoInicial, 'NOVA_MAO', 0);
    estado = aplicar(estado, 'TIQUE', 21000);
    estado = aplicar(estado, 'CARTAO', 22000);
    estado = aplicar(estado, 'DESFAZER_CARTAO', 23000);
    expect(estado.fase).toBe(FASE.ESGOTADO);
  });

  it('desfazer depois da próxima ação não mexe no relógio', () => {
    let estado = aplicar(estadoInicial, 'NOVA_MAO', 0);
    estado = aplicar(estado, 'CARTAO', 1000);
    estado = aplicar(estado, 'PROXIMA', 2000);
    const depois = aplicar(estado, 'DESFAZER_CARTAO', 3000);
    expect(depois).toBe(estado);
  });
});

describe('relógio chamado', () => {
  it('conta o tempo próprio e diz que foi chamado', () => {
    const estado = aplicar(estadoInicial, 'CHAMAR', 0);
    expect(estado.chamado).toBe(true);
    expect(segundosRestantes(estado, 0)).toBe(30);
  });

  it('a próxima ação volta ao tempo normal', () => {
    let estado = aplicar(estadoInicial, 'CHAMAR', 0);
    estado = aplicar(estado, 'PROXIMA', 1000);
    expect(estado.chamado).toBe(false);
    expect(segundosRestantes(estado, 1000)).toBe(20);
  });
});

describe('alerta visual', () => {
  it('fica calmo, avisa nos 10 s finais e é urgente nos 5 s', () => {
    expect(nivelDeAlerta(FASE.CONTANDO, 11)).toBe('');
    expect(nivelDeAlerta(FASE.CONTANDO, 10)).toBe('aviso');
    expect(nivelDeAlerta(FASE.CONTANDO, 5)).toBe('urgente');
  });

  it('esgotado é urgente e parado não alerta', () => {
    expect(nivelDeAlerta(FASE.ESGOTADO, 0)).toBe('urgente');
    expect(nivelDeAlerta(FASE.PARADO, 0)).toBe('');
    expect(nivelDeAlerta(FASE.PAUSADO, 3)).toBe('');
  });
});
