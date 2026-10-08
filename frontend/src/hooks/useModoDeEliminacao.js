import { useEffect, useState } from 'react';
import api from '../config/api';

/**
 * Modo de eliminação do torneio, escolhido na criação:
 *
 * - `table` (por posição nas mesas): o diretor elimina o jogador no assento.
 *   Mais organizado — o sistema sabe QUEM saiu, e a reentrada é daquele
 *   jogador.
 * - `bulk` (em massa): "Eliminar 1 / Eliminar N" no Controle. Mais prático —
 *   o contador não sabe quem saiu.
 *
 * Os dois seguem a mesma conta: ATIVOS = ENTRADAS − ELIMINAÇÕES, e toda
 * reentrada traz de volta um eliminado.
 */
export const MODO_MESA = 'table';
export const MODO_MASSA = 'bulk';

/** Qualquer coisa que não seja 'table' vale 'bulk', o padrão de antes. */
export const modoDoTorneio = (torneio) => (
  torneio?.elimination_mode === MODO_MESA ? MODO_MESA : MODO_MASSA
);

/**
 * Lê o modo do torneio. Devolve `null` enquanto não sabe — a tela não oferece
 * o botão do modo errado por um instante. Falhou a leitura? Vale 'bulk': o
 * servidor recusa a operação do modo errado de qualquer jeito.
 */
export function useModoDeEliminacao(tournamentId) {
  const [modo, setModo] = useState(null);

  useEffect(() => {
    if (!tournamentId) return undefined;
    let vivo = true;
    api.get(`/tournaments/${tournamentId}`, { _silentError: true })
      .then((res) => { if (vivo) setModo(modoDoTorneio(res?.data)); })
      .catch(() => { if (vivo) setModo(MODO_MASSA); });
    return () => { vivo = false; };
  }, [tournamentId]);

  return modo;
}
