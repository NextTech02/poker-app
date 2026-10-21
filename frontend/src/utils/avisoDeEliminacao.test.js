import { MAX_AVISOS_POR_LEITURA, detectarNovasEliminacoes } from './avisoDeEliminacao';

/**
 * O telão descobre quem caiu comparando duas leituras da lista de inscritos.
 * Errar aqui vira ruído na frente do salão: avisar quem caiu horas atrás ao
 * abrir a TV, ou nunca avisar a segunda queda de quem voltou ao jogo.
 */
const p = (id, status, extra = {}) => ({ id, player_name: `Jogador ${id}`, status, ...extra });

it('primeira leitura não avisa ninguém: quem já caiu não é notícia', () => {
  const { eliminados, novos } = detectarNovasEliminacoes(null, [p('a', 'eliminated'), p('b', 'active')]);
  expect(novos).toEqual([]);
  expect([...eliminados]).toEqual(['a']);
});

it('quem caiu desde a leitura anterior vira aviso, na ordem da queda', () => {
  const antes = new Set(['a']);
  const { novos } = detectarNovasEliminacoes(antes, [
    p('a', 'eliminated'),
    p('c', 'eliminated', { eliminated_at: '2026-10-21T22:05:00Z' }),
    p('b', 'eliminated', { eliminated_at: '2026-10-21T22:01:00Z' }),
    p('d', 'active'),
  ]);
  expect(novos).toEqual([{ id: 'b', nome: 'Jogador b' }, { id: 'c', nome: 'Jogador c' }]);
});

it('eliminação desfeita e refeita avisa de novo', () => {
  let { eliminados } = detectarNovasEliminacoes(null, [p('a', 'eliminated')]);
  ({ eliminados } = detectarNovasEliminacoes(eliminados, [p('a', 'active')]));
  const { novos } = detectarNovasEliminacoes(eliminados, [p('a', 'eliminated')]);
  expect(novos.map((n) => n.id)).toEqual(['a']);
});

it('operação em lote (muitos de uma vez) não vira desfile', () => {
  const lista = Array.from({ length: MAX_AVISOS_POR_LEITURA + 1 }, (_, i) => p(`x${i}`, 'eliminated'));
  const { novos, eliminados } = detectarNovasEliminacoes(new Set(), lista);
  expect(novos).toEqual([]);
  expect(eliminados.size).toBe(MAX_AVISOS_POR_LEITURA + 1);   // e não avisa depois
});

it('sem nome não há o que mostrar; lista ausente não quebra', () => {
  expect(detectarNovasEliminacoes(new Set(), [{ id: 'z', status: 'eliminated' }]).novos).toEqual([]);
  expect(detectarNovasEliminacoes(new Set(), null).novos).toEqual([]);
});
