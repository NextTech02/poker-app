/**
 * Premiação por eliminação — o que a TELA decide: quando perguntar "quem
 * eliminou?", o que mandar ao servidor e em que ordem mostrar os jogadores.
 * A conta do dinheiro é do servidor (ko_regras.py).
 */
import {
  candidatosAEliminador, codigoDaRecusa, corpoDaEliminacao, ehTorneioKo, exigeEliminador,
  faseMysteryIniciada, formatoKo, koParaApi, temBountyPorJogador,
} from './ko';

describe('formato do torneio', () => {
  it('qualquer valor desconhecido vale "sem KO"', () => {
    expect(formatoKo(null)).toBe('none');
    expect(formatoKo({ ko_format: 'bounty' })).toBe('none');
    expect(formatoKo({ ko_format: 'pko' })).toBe('pko');
    expect(ehTorneioKo({ ko_format: 'none' })).toBe(false);
    expect(ehTorneioKo({ ko_format: 'mystery' })).toBe(true);
  });

  it('KO fixo e PKO sempre pedem o eliminador; Mystery só depois de iniciada a fase', () => {
    expect(exigeEliminador({ ko_format: 'ko' })).toBe(true);
    expect(exigeEliminador({ ko_format: 'pko' })).toBe(true);
    expect(exigeEliminador({ ko_format: 'mystery' })).toBe(false);
    expect(exigeEliminador({ ko_format: 'mystery', mystery_started_at: '2026-10-14T22:00:00Z' })).toBe(true);
    expect(exigeEliminador({ ko_format: 'none' })).toBe(false);
    expect(faseMysteryIniciada({ ko_format: 'pko', mystery_started_at: 'x' })).toBe(false);
  });

  it('bounty na cabeça de cada jogador só existe no KO fixo e no PKO', () => {
    expect(temBountyPorJogador({ ko_format: 'ko' })).toBe(true);
    expect(temBountyPorJogador({ ko_format: 'pko' })).toBe(true);
    expect(temBountyPorJogador({ ko_format: 'mystery' })).toBe(false);
  });
});

describe('formulário → API', () => {
  it('sem KO manda só o formato', () => {
    expect(koParaApi({ ko_format: 'none', ko_percentage: '40' })).toEqual({ ko_format: 'none' });
    expect(koParaApi({})).toEqual({ ko_format: 'none' });
  });

  it('PKO leva a parte em dinheiro; KO fixo e Mystery pagam 100%', () => {
    expect(koParaApi({ ko_format: 'pko', ko_percentage: '40', ko_cash_share: '50' }))
      .toEqual({ ko_format: 'pko', ko_percentage: 40, ko_cash_share: 50 });
    expect(koParaApi({ ko_format: 'ko', ko_percentage: '30', ko_cash_share: '50' }))
      .toEqual({ ko_format: 'ko', ko_percentage: 30, ko_cash_share: 100 });
    expect(koParaApi({ ko_format: 'mystery', ko_percentage: '25' }))
      .toEqual({ ko_format: 'mystery', ko_percentage: 25, ko_cash_share: 100 });
  });
});

describe('quem pode ter eliminado', () => {
  const inscritos = [
    { id: 'v', nome: 'Vítima', status: 'active' },
    { id: 'b', nome: 'Bruno', status: 'active' },
    { id: 'a', nome: 'Ana', status: 'active' },
    { id: 'c', nome: 'Carla', status: 'active' },
    { id: 'z', nome: 'Zeca', status: 'eliminated' },
  ];

  it('tira a vítima e quem já caiu; a mesma mesa da vítima vem primeiro', () => {
    const mesas = new Map([['v', 3], ['b', 1], ['a', 1], ['c', 3]]);
    const lista = candidatosAEliminador(inscritos, 'v', mesas, 3);
    expect(lista.map((c) => c.id)).toEqual(['c', 'a', 'b']);
    expect(lista[0].mesa).toBe(3);
  });

  it('sem mesas, a ordem é pelo nome', () => {
    expect(candidatosAEliminador(inscritos, 'v').map((c) => c.nome)).toEqual(['Ana', 'Bruno', 'Carla']);
  });
});

describe('corpo da eliminação', () => {
  it('leva sempre o id da mutação, para o reenvio não criar outro KO', () => {
    expect(corpoDaEliminacao('tp1', 'cm1')).toEqual({ tournament_player_id: 'tp1', client_mutation_id: 'cm1' });
  });

  it('com a resposta do "quem eliminou?"', () => {
    expect(corpoDaEliminacao('tp1', 'cm1', { eliminated_by: ['a', 'b'], no_eliminator: false })).toEqual({
      tournament_player_id: 'tp1', client_mutation_id: 'cm1', eliminated_by: ['a', 'b'], no_eliminator: false,
    });
    expect(corpoDaEliminacao('tp1', 'cm1', { no_eliminator: true })).toEqual({
      tournament_player_id: 'tp1', client_mutation_id: 'cm1', eliminated_by: [], no_eliminator: true,
    });
  });
});

it('lê o código da recusa do servidor', () => {
  expect(codigoDaRecusa({ response: { data: { detail: { code: 'eliminador_obrigatorio', message: 'x' } } } }))
    .toBe('eliminador_obrigatorio');
  expect(codigoDaRecusa({ response: { data: { detail: 'texto' } } })).toBeNull();
  expect(codigoDaRecusa({ response: { data: { detail: [{ msg: 'x' }] } } })).toBeNull();
  expect(codigoDaRecusa(new Error('rede'))).toBeNull();
});
