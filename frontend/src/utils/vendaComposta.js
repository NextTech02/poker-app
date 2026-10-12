/**
 * Venda COMPOSTA do Caixa: vários meios de entrada numa ida só ao balcão.
 *
 * O jogador chega e pede "entrada + bono dealer" (ou "reentrada + add-on"). Antes
 * o caixa lançava cada um separado, saíam dois bilhetes, e o floor somava as
 * fichas de cabeça para entregar a pilha. Aqui a tela escolhe todos de uma vez,
 * mostra o total a cobrar e o total de fichas, e o bilhete sai UM só.
 *
 * Regra de composição (a mesma que o servidor aplicaria venda a venda):
 *
 * - no máximo UMA entrada por venda — buy-in OU reentrada. Duas entradas não
 *   existem: o jogador só se inscreve uma vez no dia, e cada reentrada exige
 *   uma eliminação antes. Marcar outra entrada TROCA a anterior, como um rádio;
 * - add-ons (bono dealer, add-on, etc.) entram quantos o clube tiver, cada um
 *   uma vez — vão para a pilha do mesmo jogador.
 *
 * Cada item continua sendo gravado como a transação que sempre foi (buy-in,
 * rebuy, add-on, com o rake e as fichas do seu meio de entrada). Relatórios,
 * premiação, estorno e ranking contam linhas por categoria e não mudam nada.
 */

export const CATEGORIAS_DE_ENTRADA = ['buy_in', 'rebuy'];

export const eEntrada = (categoria) => CATEGORIAS_DE_ENTRADA.includes(categoria);

/**
 * Marca ou desmarca um meio de entrada e devolve a NOVA lista de ids.
 * Marcar uma entrada tira a entrada anterior (só cabe uma por venda).
 */
export const alternarItem = (selecionados, id, tipos) => {
  const atual = Array.isArray(selecionados) ? selecionados : [];
  if (atual.includes(id)) return atual.filter((x) => x !== id);
  const tipo = (tipos || []).find((b) => b.id === id);
  if (!tipo) return atual;
  if (!eEntrada(tipo.category)) return [...atual, id];
  const categoriaDe = (x) => (tipos || []).find((b) => b.id === x)?.category;
  return [...atual.filter((x) => !eEntrada(categoriaDe(x))), id];
};

/**
 * Fichas que o item entrega — a MESMA regra do servidor
 * (`TournamentPlayerService._fichas_do_tipo`): as do meio de entrada; sem
 * número nele, as do dia (rebuy/add-on sem configuração caem em 10.000).
 */
export const fichasDoDia = (categoria, dia) => {
  if (!dia) return 0;
  if (categoria === 'rebuy') return Number(dia.rebuy_chips || 10000);
  if (categoria === 'addon') return Number(dia.addon_chips || 10000);
  return Number(dia.starting_chips || 0);
};

export const fichasDoTipo = (tipo, dia) => {
  if (tipo && tipo.chips !== null && tipo.chips !== undefined) return Number(tipo.chips) || 0;
  return fichasDoDia(tipo?.category, dia);
};

/**
 * Itens da venda, na ordem em que vão ao servidor: a ENTRADA primeiro (é ela
 * que inscreve ou traz o jogador de volta) e depois os add-ons, na ordem da
 * lista do torneio. `valorReserva(categoria)` dá o valor do dia para meio de
 * entrada sem preço próprio.
 */
export const montarItens = (ids, tipos, dia, valorReserva = () => 0) => {
  const escolhidos = (tipos || []).filter((b) => (ids || []).includes(b.id));
  const ordenados = [
    ...escolhidos.filter((b) => eEntrada(b.category)),
    ...escolhidos.filter((b) => !eEntrada(b.category)),
  ];
  return ordenados.map((b) => ({
    buy_type_id: b.id,
    name: b.name,
    category: b.category,
    // `??` e não `||`: zero é preço legítimo (dia final de classificados).
    amount: Number(b.amount ?? valorReserva(b.category)) || 0,
    chips: fichasDoTipo(b, dia),
  }));
};

export const totaisDosItens = (itens) => (itens || []).reduce(
  (acc, item) => ({
    amount: Math.round((acc.amount + (Number(item.amount) || 0)) * 100) / 100,
    chips: acc.chips + (Number(item.chips) || 0),
  }),
  { amount: 0, chips: 0 },
);

/** Janela em que linhas do mesmo jogador contam como a mesma ida ao caixa. */
export const JANELA_DA_VENDA_MS = 2 * 60 * 1000;

const mesmoInscrito = (a, b) => (
  a.tournament_player_id && b.tournament_player_id
    ? a.tournament_player_id === b.tournament_player_id
    : a.player_id === b.player_id && a.tournament_id === b.tournament_id
);

/**
 * Reimpressão: junta as linhas que saíram na MESMA venda composta que
 * `transacao`. A venda grava uma linha por item, sem um id de venda em comum,
 * então "mesma venda" é: mesmo inscrito, mesmo operador, ativa, e lançada até
 * dois minutos antes ou depois. Um add-on comprado horas depois é outra ida
 * ao caixa e fica fora.
 */
export const linhasDaMesmaVenda = (transacao, transacoes) => {
  const base = new Date(transacao.created_at).getTime();
  const juntas = (transacoes || []).filter((t) => (
    (t.status || 'active') === 'active'
    && t.type !== 'prize'
    && mesmoInscrito(t, transacao)
    && (!t.created_by || !transacao.created_by || t.created_by === transacao.created_by)
    && Math.abs(new Date(t.created_at).getTime() - base) <= JANELA_DA_VENDA_MS
    // Uma entrada por venda: outra entrada perto (reentrada logo depois de
    // cair) é OUTRA venda, com o seu próprio bilhete.
    && (!eEntrada(t.type) || !eEntrada(transacao.type) || t.id === transacao.id)
  ));
  if (!juntas.some((t) => t.id === transacao.id)) juntas.push(transacao);
  return juntas.sort((a, b) => {
    const ordem = (eEntrada(a.type) ? 0 : 1) - (eEntrada(b.type) ? 0 : 1);
    return ordem || new Date(a.created_at) - new Date(b.created_at);
  });
};
