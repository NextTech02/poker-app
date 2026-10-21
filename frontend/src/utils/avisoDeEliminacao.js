/**
 * Aviso de JOGADOR ELIMINADO no telão (pedido do NSOP): o floor elimina na
 * mesa e, na TV, sobe um texto animado na parte de baixo — "JUGADOR
 * ELIMINADO · Carlos Montea".
 *
 * O telão não recebe evento de eliminação: ele já relê a lista de inscritos do
 * dia a cada 10 s. Daqui sai a comparação entre duas leituras — quem passou a
 * constar como eliminado desde a anterior.
 */

/**
 * Mais do que isto numa leitura só não é mão jogada, é operação em lote
 * (encerrar o dia, avançar classificados): o telão não vira um desfile.
 */
export const MAX_AVISOS_POR_LEITURA = 6;

/**
 * Compara a leitura atual com o conjunto de eliminados da anterior.
 *
 * `anteriores` nulo = primeira leitura: quem JÁ estava eliminado quando a TV
 * abriu não é notícia, só entra no conjunto. Quem volta ao jogo (eliminação
 * desfeita) sai do conjunto, e uma nova eliminação dele avisa de novo.
 *
 * Devolve { eliminados: Set de ids, novos: [{ id, nome }] em ordem de queda }.
 */
export function detectarNovasEliminacoes(anteriores, inscritos) {
  const lista = Array.isArray(inscritos) ? inscritos : [];
  const caidos = lista.filter((p) => p && p.id && p.status === 'eliminated');
  const eliminados = new Set(caidos.map((p) => String(p.id)));
  if (!anteriores) return { eliminados, novos: [] };

  const novos = caidos
    .filter((p) => !anteriores.has(String(p.id)))
    .sort((a, b) => String(a.eliminated_at || '').localeCompare(String(b.eliminated_at || '')))
    .map((p) => ({ id: String(p.id), nome: p.player_name || p.player_nickname || '' }))
    .filter((p) => p.nome);
  return { eliminados, novos: novos.length > MAX_AVISOS_POR_LEITURA ? [] : novos };
}
