import { useEffect, useState } from 'react';

/**
 * O valor, só depois que ele PARA de mudar por `ms` — para busca que vai ao
 * servidor não disparar uma requisição por tecla. Valor vazio passa na hora:
 * limpar a busca tem que voltar a lista inteira sem esperar.
 */
export const useDebouncedValue = (valor, ms = 300) => {
  const [atrasado, setAtrasado] = useState(valor);
  useEffect(() => {
    if (!valor) {
      setAtrasado(valor);
      return undefined;
    }
    const id = setTimeout(() => setAtrasado(valor), ms);
    return () => clearTimeout(id);
  }, [valor, ms]);
  return atrasado;
};

export default useDebouncedValue;
