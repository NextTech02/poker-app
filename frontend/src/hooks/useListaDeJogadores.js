import { useEffect, useState } from 'react';
import api from '../config/api';
import { cachedGet, cachedValue } from '../utils/apiCache';

/**
 * Lista de jogadores do clube para os seletores (<PlayerSelect>,
 * <PlayerMultiSelect>).
 *
 * Antes, CADA seletor baixava `/players` inteiro ao montar — dois na mesma
 * tela eram dois downloads, e o campo ficava desabilitado até chegar. Agora é
 * uma lista só em memória (a mesma da tela de Jogadores): o seletor abre na
 * hora com ela e confere com o servidor ao abrir, no máximo uma vez a cada
 * FRESCOR_DA_LISTA_MS. A conferência existe por causa do salão: a recepção
 * cadastra o jogador num computador e o caixa precisa achá-lo logo em seguida
 * no outro.
 */
export const FRESCOR_DA_LISTA_MS = 10000;

/** Quantos jogadores um seletor mostra de uma vez; o resto, digitando. */
export const MAX_OPCOES = 50;

export const useListaDeJogadores = () => {
  const [players, setPlayers] = useState(() => cachedValue('/players') || []);
  const [loading, setLoading] = useState(() => !cachedValue('/players'));

  useEffect(() => {
    let vivo = true;
    cachedGet(api, '/players', FRESCOR_DA_LISTA_MS)
      .then((data) => { if (vivo) setPlayers(data || []); })
      .catch(() => { /* fica a lista que já havia; o seletor continua utilizável */ })
      .finally(() => { if (vivo) setLoading(false); });
    return () => { vivo = false; };
  }, []);

  return { players, loading };
};

export default useListaDeJogadores;
