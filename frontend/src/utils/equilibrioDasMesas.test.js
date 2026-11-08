/**
 * Equilíbrio das mesas: o que o painel sugere ao floor. Só sugere: quem escolhe
 * quem muda de mesa, e quando, é o floor.
 *
 * - **Mover** quando uma mesa tem dois ou mais jogadores a mais que outra.
 * - **Quebrar** a mesa com menos gente quando todos cabem nas outras. Nesse
 *   caso não sugere mover: quebrar já resolve, e as duas dicas juntas brigam.
 */
import { equilibrio } from './equilibrioDasMesas';

const mesa = (numero, jogadores, lugares = 9) => ({ id: `m${numero}`, numero, jogadores, lugares });

it('mesas iguais ou com um de diferença: nada a fazer', () => {
  expect(equilibrio([mesa(1, 8), mesa(2, 8)])).toEqual({ mover: null, quebrar: null });
  expect(equilibrio([mesa(1, 8), mesa(2, 7)])).toEqual({ mover: null, quebrar: null });
});

it('dois de diferença: mover da mais cheia para a mais vazia', () => {
  const { mover } = equilibrio([mesa(1, 9), mesa(2, 8), mesa(3, 7)]);
  expect(mover.de.numero).toBe(1);
  expect(mover.para.numero).toBe(3);
});

it('quando todos cabem nas outras mesas, sugere quebrar a com menos gente', () => {
  const { quebrar, mover } = equilibrio([mesa(1, 6), mesa(2, 6), mesa(3, 5)]);
  expect(quebrar.mesa.numero).toBe(3);
  expect(quebrar.jogadores).toBe(17);
  expect(mover).toBeNull();
});

it('não sugere quebrar se faltar lugar', () => {
  expect(equilibrio([mesa(1, 9), mesa(2, 9), mesa(3, 1)]).quebrar).toBeNull();
});

it('empate na menor: quebra a de número maior', () => {
  expect(equilibrio([mesa(1, 4), mesa(2, 4), mesa(3, 9)]).quebrar.mesa.numero).toBe(2);
});

it('conta só os lugares que recebem jogador', () => {
  // A mesa 2 tem 9 cadeiras, mas 4 bloqueadas pelo floor: 5 lugares.
  expect(equilibrio([mesa(1, 5, 5), mesa(2, 5, 5), mesa(3, 1)]).quebrar).toBeNull();
});

it('mesa sem nenhum lugar livre não entra na conta', () => {
  expect(equilibrio([mesa(1, 8), mesa(2, 0, 0)])).toEqual({ mover: null, quebrar: null });
});

it('uma mesa só, ou nenhum jogador sentado: nada a sugerir', () => {
  expect(equilibrio([mesa(1, 9)])).toEqual({ mover: null, quebrar: null });
  expect(equilibrio([mesa(1, 0), mesa(2, 0)])).toEqual({ mover: null, quebrar: null });
  expect(equilibrio([])).toEqual({ mover: null, quebrar: null });
});
