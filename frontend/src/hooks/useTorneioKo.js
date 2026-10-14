import { useCallback, useEffect, useState } from 'react';
import api from '../config/api';
import { exigeEliminador, faseMysteryIniciada, formatoKo, temBountyPorJogador } from '../utils/ko';

/**
 * Configuração da premiação por eliminação do torneio (ver utils/ko).
 * Enquanto não sabe, `torneio` é null e `exige` é false — a tela não pede
 * eliminador por engano; o servidor recusa com o motivo se precisar.
 */
export function useTorneioKo(tournamentId) {
  const [torneio, setTorneio] = useState(null);

  const recarregar = useCallback(async () => {
    if (!tournamentId) return null;
    try {
      const res = await api.get(`/tournaments/${tournamentId}`, { _silentError: true });
      setTorneio(res?.data || null);
      return res?.data || null;
    } catch (_) {
      return null;
    }
  }, [tournamentId]);

  useEffect(() => { recarregar(); }, [recarregar]);

  return {
    torneio,
    formato: formatoKo(torneio),
    exige: exigeEliminador(torneio),
    mysteryIniciado: faseMysteryIniciada(torneio),
    comBounty: temBountyPorJogador(torneio),
    recarregar,
  };
}
