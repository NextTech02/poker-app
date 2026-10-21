import { LINHAS_POR_COLUNA, ordenarAssentos, paginarAssentos } from './quadroDeMesas';

/**
 * O quadro de mesas é onde o jogador procura o próprio nome na TV do salão:
 * a ordem tem de ser a alfabética que ele espera, e nenhuma linha pode sumir
 * entre colunas e páginas.
 */
const assento = (name, table_number = 1, seat_number = 1) => ({ name, table_number, seat_number });
const nomes = (n) => Array.from({ length: n }, (_, i) => assento(`Jogador ${String(i).padStart(3, '0')}`));

describe('ordenarAssentos', () => {
  it('ignora maiúscula e acento', () => {
    const r = ordenarAssentos([assento('zeca'), assento('Ángel'), assento('andrés'), assento('Bruno')], 'es-ES');
    expect(r.map((a) => a.name)).toEqual(['andrés', 'Ángel', 'Bruno', 'zeca']);
  });

  it('nome repetido desempata por mesa e assento', () => {
    const r = ordenarAssentos([assento('Ana', 3, 2), assento('Ana', 1, 9), assento('Ana', 1, 4)]);
    expect(r.map((a) => [a.table_number, a.seat_number])).toEqual([[1, 4], [1, 9], [3, 2]]);
  });

  it('não altera a lista original e aguenta lista ausente', () => {
    const original = [assento('B'), assento('A')];
    ordenarAssentos(original);
    expect(original.map((a) => a.name)).toEqual(['B', 'A']);
    expect(ordenarAssentos(null)).toEqual([]);
  });

  it('idioma inválido não quebra a ordenação', () => {
    expect(ordenarAssentos([assento('B'), assento('A')], 'xx_invalido!!').map((a) => a.name)).toEqual(['A', 'B']);
  });
});

describe('paginarAssentos', () => {
  it('poucos jogadores: 1 coluna, 1 página', () => {
    const { colunas, paginas } = paginarAssentos(nomes(12));
    expect(colunas).toBe(1);
    expect(paginas).toHaveLength(1);
    expect(paginas[0][0]).toHaveLength(12);
  });

  it('dia final de 27: 2 colunas equilibradas (14 + 13)', () => {
    const { colunas, paginas } = paginarAssentos(nomes(27));
    expect(colunas).toBe(2);
    expect(paginas).toHaveLength(1);
    expect(paginas[0].map((c) => c.length)).toEqual([14, 13]);
  });

  it('acima de 3 colunas cheias vira páginas, sem perder ninguém', () => {
    const lista = nomes(100);
    const { colunas, paginas } = paginarAssentos(lista);
    expect(colunas).toBe(3);
    expect(paginas).toHaveLength(Math.ceil(100 / (3 * LINHAS_POR_COLUNA)));
    expect(paginas.flat(2)).toEqual(lista);   // mesma ordem, todos presentes
    paginas.forEach((p) => p.forEach((c) => expect(c.length).toBeLessThanOrEqual(LINHAS_POR_COLUNA)));
  });

  it('colunas lidas de cima para baixo', () => {
    const { paginas } = paginarAssentos(nomes(20));
    expect(paginas[0][0][0].name).toBe('Jogador 000');
    expect(paginas[0][1][0].name).toBe('Jogador 010');
  });

  it('lista vazia: nenhuma página', () => {
    expect(paginarAssentos([])).toEqual({ colunas: 1, paginas: [] });
    expect(paginarAssentos(undefined).paginas).toEqual([]);
  });
});
