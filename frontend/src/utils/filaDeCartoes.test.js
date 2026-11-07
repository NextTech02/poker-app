/**
 * A fila de cartões do tablet: o toque do dealer não pode se perder quando a
 * rede do salão cai. Fica no aparelho até o servidor confirmar, e reenviar é
 * seguro porque o id é gerado aqui, uma vez só.
 */
import {
  adicionarNaFila, lerFila, novoEventoDeCartao, pendentesDoJogador, removerDaFila,
} from './filaDeCartoes';

const ITEM = { client_event_id: 'e1', table_id: 'm1', tournament_player_id: 'tp1' };

beforeEach(() => localStorage.clear());

it('começa vazia', () => {
  expect(lerFila()).toEqual([]);
});

it('guarda o toque e sobrevive a recarregar a tela', () => {
  adicionarNaFila(ITEM);
  expect(lerFila()).toEqual([ITEM]);
});

it('o mesmo toque não entra duas vezes', () => {
  adicionarNaFila(ITEM);
  adicionarNaFila(ITEM);
  expect(lerFila()).toHaveLength(1);
});

it('sai da fila quando o servidor confirma', () => {
  adicionarNaFila(ITEM);
  adicionarNaFila({ ...ITEM, client_event_id: 'e2' });
  removerDaFila('e1');
  expect(lerFila().map((i) => i.client_event_id)).toEqual(['e2']);
});

it('conta o que falta enviar de cada jogador', () => {
  const fila = [ITEM, { ...ITEM, client_event_id: 'e2' }, { ...ITEM, client_event_id: 'e3', tournament_player_id: 'tp2' }];
  expect(pendentesDoJogador(fila, 'tp1')).toBe(2);
  expect(pendentesDoJogador(fila, 'tp9')).toBe(0);
});

it('dado corrompido não derruba o tablet', () => {
  localStorage.setItem('relogio_cartoes_pendentes', '{quebrado');
  expect(lerFila()).toEqual([]);
});

it('cada toque ganha um id próprio', () => {
  const a = novoEventoDeCartao('m1', 'tp1');
  const b = novoEventoDeCartao('m1', 'tp1');
  expect(a.client_event_id).not.toBe(b.client_event_id);
  expect(a).toMatchObject({ table_id: 'm1', tournament_player_id: 'tp1' });
});
