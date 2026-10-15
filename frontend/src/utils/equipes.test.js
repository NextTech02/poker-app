/**
 * Torneio por equipes — o que a tela decide: formulário, prévia das mesas e
 * quem joga em cada nível da final por revezamento.
 */
import {
  equipesDoTorneio, equipesParaApi, formatarPontos, membroDaVez, mesasMinimas, nomeCurto,
  previaDasMesas, resumoDasMesas, revezamentoDaEquipe,
} from './equipes';

describe('formulário do torneio', () => {
  it('torneio comum não manda nada; desligar um torneio por equipes manda o modo desligado', () => {
    expect(equipesParaApi({ team_mode: false, team_finalists: '4' })).toEqual({});
    expect(equipesParaApi(null)).toEqual({});
    expect(equipesParaApi({ team_mode: false }, true)).toEqual({ team_mode: false });
  });

  it('por equipes leva finalistas (no máximo 8), desempate e reentrada', () => {
    expect(equipesParaApi({ team_mode: true, team_finalists: '12', team_tiebreak: 'manual', team_allow_reentry: true }))
      .toEqual({ team_mode: true, team_finalists: 8, team_tiebreak: 'manual', team_allow_reentry: true });
    expect(equipesParaApi({ team_mode: true, team_finalists: '', team_tiebreak: 'outro' }))
      .toEqual({ team_mode: true, team_finalists: null, team_tiebreak: 'best_individual', team_allow_reentry: false });
  });

  it('lê do torneio gravado', () => {
    expect(equipesDoTorneio({ team_mode: true, team_finalists: 6, team_tiebreak: 'manual' }))
      .toEqual({ team_mode: true, team_finalists: '6', team_tiebreak: 'manual', team_allow_reentry: false });
    expect(equipesDoTorneio(undefined).team_mode).toBe(false);
  });
});

describe('prévia das mesas da Fase 1', () => {
  it('no máximo 8 por mesa e no mínimo 4 mesas', () => {
    expect(mesasMinimas(36)).toBe(5);
    expect(mesasMinimas(12)).toBe(4);
    expect(mesasMinimas(0)).toBe(0);
    expect(previaDasMesas(36)).toEqual([8, 7, 7, 7, 7]);
    expect(previaDasMesas(12)).toEqual([3, 3, 3, 3]);
    expect(resumoDasMesas(previaDasMesas(36))).toBe('1×8, 4×7');
  });
});

describe('revezamento da final', () => {
  const membros = [{ name: 'Ana Souza' }, { name: 'Beto', nickname: 'Tiburón' }, { name: 'Caio' }, { name: 'Davi' }];

  it('a cada nível entra o próximo da ordem e a roda continua', () => {
    expect([1, 2, 3, 4, 5, 6].map((n) => membroDaVez(4, n))).toEqual([0, 1, 2, 3, 0, 1]);
    expect(membroDaVez(4, null)).toBe(0);
    expect(membroDaVez(4, 7, 5)).toBe(2);
  });

  it('quem joga agora e quem entra', () => {
    expect(revezamentoDaEquipe(membros, 4)).toEqual({ atual: membros[3], proximo: membros[0] });
    expect(revezamentoDaEquipe([], 2)).toEqual({ atual: null, proximo: null });
  });

  it('nome curto: apelido, senão o primeiro nome', () => {
    expect(nomeCurto(membros[0])).toBe('Ana');
    expect(nomeCurto(membros[1])).toBe('Tiburón');
    expect(nomeCurto('Já curto')).toBe('Já curto');
  });

  it('pontos com meio ponto só quando há empate dividido', () => {
    expect(formatarPontos(15)).toBe('15');
    expect(formatarPontos(7.5)).toBe('7.5');
    expect(formatarPontos(null)).toBe('—');
  });
});
