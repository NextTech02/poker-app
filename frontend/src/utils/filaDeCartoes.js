/* Cartões usados que ainda não chegaram ao servidor.

   O toque do dealer não pode se perder quando a rede do salão cai, então ele
   fica no aparelho até o servidor confirmar. Reenviar é seguro: o id nasce aqui,
   uma vez só, e o servidor não desconta duas vezes o mesmo id. */

const CHAVE = 'relogio_cartoes_pendentes';

const novoId = () => (typeof crypto !== 'undefined' && crypto.randomUUID
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export const novoEventoDeCartao = (tableId, tournamentPlayerId) => ({
  client_event_id: novoId(),
  table_id: tableId,
  tournament_player_id: tournamentPlayerId,
});

export const lerFila = () => {
  try {
    const itens = JSON.parse(localStorage.getItem(CHAVE));
    return Array.isArray(itens) ? itens : [];
  } catch {
    return [];
  }
};

const gravarFila = (itens) => {
  try {
    localStorage.setItem(CHAVE, JSON.stringify(itens));
  } catch (erro) {
    console.warn('[Relógio] não deu para guardar o cartão no aparelho:', erro);
  }
};

export const adicionarNaFila = (item) => {
  const fila = lerFila();
  if (fila.some((i) => i.client_event_id === item.client_event_id)) return;
  gravarFila([...fila, item]);
};

export const removerDaFila = (clientEventId) => {
  gravarFila(lerFila().filter((i) => i.client_event_id !== clientEventId));
};

export const pendentesDoJogador = (fila, tournamentPlayerId) => (
  fila.filter((i) => i.tournament_player_id === tournamentPlayerId).length
);
