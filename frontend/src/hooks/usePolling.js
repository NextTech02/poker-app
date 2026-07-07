import { useEffect, useRef } from 'react';

/**
 * Executa `callback` a cada `intervalMs`, mas PAUSA enquanto a aba está oculta
 * (document.hidden). Operadores deixam telas abertas; sem isso, cada tela fica
 * martelando a API a cada poucos segundos em segundo plano — uma das maiores
 * fontes de carga/lentidão em produção.
 *
 * Ao voltar a ficar visível, dispara um refresh imediato e retoma o intervalo.
 * `intervalMs` falsy desliga o polling.
 */
export function usePolling(callback, intervalMs) {
  const savedCallback = useRef(callback);

  useEffect(() => {
    savedCallback.current = callback;
  });

  useEffect(() => {
    if (!intervalMs) return undefined;

    let id = null;
    const tick = () => {
      if (!document.hidden) savedCallback.current();
    };
    const start = () => {
      if (id == null) id = setInterval(tick, intervalMs);
    };
    const stop = () => {
      if (id != null) {
        clearInterval(id);
        id = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        savedCallback.current(); // refresh imediato ao voltar
        start();
      }
    };

    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [intervalMs]);
}

export default usePolling;
