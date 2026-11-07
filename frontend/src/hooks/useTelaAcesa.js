import { useEffect } from 'react';

/**
 * Mantém a tela do aparelho acesa enquanto o componente estiver montado.
 *
 * O tablet do dealer fica parado na mesa: sem isso ele apaga no meio da mão. O
 * sistema solta a trava quando a aba sai de vista, então ela é pedida de novo
 * na volta. Aparelho sem o recurso segue funcionando, só apaga como sempre.
 */
export function useTelaAcesa() {
  useEffect(() => {
    if (!navigator.wakeLock) return undefined;
    let trava = null;
    let montado = true;

    const pedir = async () => {
      try {
        const nova = await navigator.wakeLock.request('screen');
        if (montado) trava = nova;
        else nova.release();
      } catch (erro) {
        console.warn('[Relógio] a tela não ficou travada acesa:', erro);
      }
    };
    const aoVoltar = () => {
      if (document.visibilityState === 'visible') pedir();
    };

    pedir();
    document.addEventListener('visibilitychange', aoVoltar);
    return () => {
      montado = false;
      document.removeEventListener('visibilitychange', aoVoltar);
      if (trava) trava.release();
    };
  }, []);
}
