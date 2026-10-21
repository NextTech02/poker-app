import { useEffect, useRef, useState } from 'react';
import { detectarNovasEliminacoes } from '../utils/avisoDeEliminacao';

/** Quanto tempo cada aviso fica na tela (entrada + leitura + saída). */
export const DURACAO_DO_AVISO_MS = 6500;
/** Fila curta: avisos velhos demais já não dizem nada ao salão. */
const MAX_FILA = 6;

/**
 * Fila de avisos de eliminação do telão. Recebe a lista de inscritos (a cada
 * nova leitura) e devolve o aviso da vez — { id, nome } — ou null. Lista
 * `null` = ainda não carregou: a primeira lista de verdade é a base.
 *
 * Com o aviso desligado nas Configurações, continua acompanhando quem caiu
 * (sem mostrar): ligar no meio do dia não despeja as eliminações antigas.
 */
export function useAvisoDeEliminacao(inscritos, ligado, duracaoMs = DURACAO_DO_AVISO_MS) {
  const anteriores = useRef(null);
  const [fila, setFila] = useState([]);

  useEffect(() => {
    if (!Array.isArray(inscritos)) return;
    const { eliminados, novos } = detectarNovasEliminacoes(anteriores.current, inscritos);
    anteriores.current = eliminados;
    if (ligado && novos.length) setFila((f) => [...f, ...novos].slice(-MAX_FILA));
  }, [inscritos, ligado]);

  // Desligou no meio de uma fila: some na hora.
  useEffect(() => {
    if (!ligado) setFila([]);
  }, [ligado]);

  const atual = fila[0] || null;
  useEffect(() => {
    if (!atual) return undefined;
    const id = setTimeout(() => setFila((f) => f.slice(1)), duracaoMs);
    return () => clearTimeout(id);
  }, [atual, duracaoMs]);

  return atual;
}
