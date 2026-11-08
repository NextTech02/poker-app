/**
 * A mesa desenhada no tablet: onde fica cada assento e quanto falta no nível.
 *
 * O dealer fica embaixo, no meio. O assento 1 é o primeiro à esquerda dele, e a
 * numeração segue no sentido horário, como na mesa de verdade.
 */
import {
  assentosDaMesa, formatarTempo, posicaoDoAssento, segundosDoNivel,
} from './mesaDesenhada';

describe('posição dos assentos', () => {
  it('o assento 1 fica embaixo, à esquerda do dealer', () => {
    const { x, y } = posicaoDoAssento(0, 9);
    expect(x).toBeLessThan(50);
    expect(y).toBeGreaterThan(70);
  });

  it('o último fica embaixo, à direita do dealer', () => {
    const { x, y } = posicaoDoAssento(8, 9);
    expect(x).toBeGreaterThan(50);
    expect(y).toBeGreaterThan(70);
  });

  it('segue no sentido horário: sobe pela esquerda e desce pela direita', () => {
    const lugares = Array.from({ length: 9 }, (_, i) => posicaoDoAssento(i, 9));
    const meio = lugares[4];
    expect(meio.x).toBeCloseTo(50, 0);
    expect(meio.y).toBeLessThan(15);
    expect(lugares[2].x).toBeLessThan(meio.x);
    expect(lugares[6].x).toBeGreaterThan(meio.x);
  });

  it('o lugar do dealer fica livre', () => {
    const primeiro = posicaoDoAssento(0, 10);
    const ultimo = posicaoDoAssento(9, 10);
    expect(ultimo.x - primeiro.x).toBeGreaterThan(20);
  });

  it('mesa de um lugar só fica no alto', () => {
    expect(posicaoDoAssento(0, 1)).toEqual({ x: 50, y: expect.any(Number) });
    expect(posicaoDoAssento(0, 1).y).toBeLessThan(15);
  });

  it('nenhum assento sai da área desenhada', () => {
    for (let total = 2; total <= 10; total += 1) {
      for (let i = 0; i < total; i += 1) {
        const { x, y } = posicaoDoAssento(i, total);
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(100);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('assentos da mesa', () => {
  const ANA = { seat_number: 3, name: 'Ana' };

  it('lista todos os lugares, com quem está sentado em cada um', () => {
    const assentos = assentosDaMesa(4, [ANA]);
    expect(assentos.map((a) => a.numero)).toEqual([1, 2, 3, 4]);
    expect(assentos[2].jogador).toBe(ANA);
    expect(assentos[0].jogador).toBeNull();
  });

  it('marca os bloqueados pelo floor', () => {
    const assentos = assentosDaMesa(4, [], [2]);
    expect(assentos.map((a) => a.bloqueado)).toEqual([false, true, false, false]);
  });

  it('jogador num lugar além do tamanho da mesa ainda aparece', () => {
    const assentos = assentosDaMesa(4, [{ seat_number: 6, name: 'Beto' }]);
    expect(assentos).toHaveLength(6);
    expect(assentos[5].jogador.name).toBe('Beto');
  });

  it('sem tamanho da mesa, desenha só o que tem gente', () => {
    expect(assentosDaMesa(null, [ANA])).toHaveLength(3);
    expect(assentosDaMesa(undefined, [])).toEqual([]);
  });
});

describe('tempo do nível', () => {
  it('conta pelo relógio do servidor, não pelo do aparelho', () => {
    // Servidor 100 s adiantado: o nível termina em 578 s pelo relógio dele.
    const timer = { level_ends_at: 10678, server_time: 10100 };
    expect(segundosDoNivel(timer, 100, 10000 * 1000)).toBe(578);
  });

  it('nunca fica negativo', () => {
    expect(segundosDoNivel({ level_ends_at: 100 }, 0, 500 * 1000)).toBe(0);
  });

  it('pausado usa o tempo que restava', () => {
    expect(segundosDoNivel({ level_ends_at: null, time_remaining: 300 }, 0, 0)).toBe(300);
  });

  it('sem nenhum dos dois não inventa número', () => {
    expect(segundosDoNivel({}, 0, 0)).toBeNull();
    expect(segundosDoNivel(null, 0, 0)).toBeNull();
  });
});

describe('formato', () => {
  it('minutos e segundos', () => {
    expect(formatarTempo(578)).toBe('9:38');
    expect(formatarTempo(5)).toBe('0:05');
  });

  it('com hora quando passa de 60 minutos', () => {
    expect(formatarTempo(3725)).toBe('1:02:05');
  });

  it('sem tempo, traços', () => {
    expect(formatarTempo(null)).toBe('--:--');
  });
});
