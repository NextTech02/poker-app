import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import api from '../config/api';
import { useModule, MODULO_BAR } from './ModuleContext';
import { invalidateCacheByPrefix } from '../utils/apiCache';

/**
 * O turno do bar aberto agora.
 *
 * Clone do CashDayContext, pelas mesmas razões: o turno viaja EXPLÍCITO na
 * URL (não num header), e NÃO é escolhido pelo usuário — só existe um aberto
 * por vez (o banco garante), então este contexto o DESCOBRE.
 */
const BarShiftContext = createContext({});

export const useBarShift = () => useContext(BarShiftContext);

export const BarShiftProvider = ({ children }) => {
  const { module } = useModule();
  const [shift, setShift] = useState(undefined); // undefined = ainda carregando
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    // O turno é a chave de quase toda leitura do módulo; servir o cache do
    // turno anterior mostraria as comandas de ontem como se fossem de agora.
    invalidateCacheByPrefix('/bar');
    try {
      const res = await api.get('/bar/shifts/current', { _silentError: true });
      setShift(res.data || null);
      return res.data || null;
    } catch {
      setShift(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (module !== MODULO_BAR) {
      setShift(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    reload();
  }, [module, reload]);

  const value = useMemo(
    () => ({
      shift: shift || null,
      barShiftId: shift?.id || null,
      isOpen: !!shift && shift.status === 'open',
      loading,
      reload,
      setShift,
    }),
    [shift, loading, reload],
  );

  return <BarShiftContext.Provider value={value}>{children}</BarShiftContext.Provider>;
};
