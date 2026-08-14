import { useEffect } from 'react';

/**
 * Fecha um modal com a tecla Esc.
 *
 * O backdrop de um modal fecha no clique, mas clique é gesto de mouse: quem
 * opera só pelo teclado (o caso do operador de caixa no clube) precisa do Esc.
 * Por isso o backdrop fica como `role="presentation"` e o caminho de teclado
 * mora aqui, num listener global — assim não importa onde o foco esteja
 * dentro do modal.
 *
 * @param {boolean} ativo se o modal está aberto
 * @param {Function} aoFechar callback de fechamento
 */
export function useEscapeKey(ativo, aoFechar) {
  useEffect(() => {
    if (!ativo || typeof aoFechar !== 'function') return undefined;

    const aoTeclar = (evento) => {
      if (evento.key === 'Escape') {
        evento.stopPropagation();
        aoFechar();
      }
    };

    document.addEventListener('keydown', aoTeclar);
    return () => document.removeEventListener('keydown', aoTeclar);
  }, [ativo, aoFechar]);
}

export default useEscapeKey;
