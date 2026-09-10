import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import api from '../config/api';
import { useModule, MODULO_CASH } from './ModuleContext';
import { invalidateCacheByPrefix } from '../utils/apiCache';

/**
 * O dia de operação aberto agora.
 *
 * É o análogo do StageContext para o cash game, com uma diferença deliberada:
 * a etapa viaja num HEADER (`X-Stage-ID`, posto pelo interceptor) e o dia viaja
 * EXPLÍCITO na URL. O header existe no torneio porque a etapa é um filtro de
 * visão aplicado a dezenas de rotas antigas; aqui não há nada a esconder atrás
 * de um cabeçalho, e um segundo header mágico só criaria mais um lugar onde o
 * escopo pode estar errado sem aparecer na chamada.
 *
 * A outra diferença: o dia NÃO é escolhido pelo usuário. Só existe um aberto
 * por vez (o banco garante), então este contexto o DESCOBRE — não há seletor.
 */
const CashDayContext = createContext({});

export const useCashDay = () => useContext(CashDayContext);

export const CashDayProvider = ({ children }) => {
  const { module } = useModule();
  const [day, setDay] = useState(undefined); // undefined = ainda carregando
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    // O dia é a chave de quase toda leitura do módulo; servir o cache do dia
    // anterior mostraria a operação de ontem como se fosse a de agora.
    invalidateCacheByPrefix('/cash-game');
    try {
      const res = await api.get('/cash-game/days/current', { _silentError: true });
      setDay(res.data || null);
      return res.data || null;
    } catch {
      // Falha de rede ou módulo não contratado: `null` é "não há operação
      // agora", que é o que a tela precisa para oferecer o botão de abrir.
      setDay(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (module !== MODULO_CASH) {
      // No módulo de torneio nem vale gastar a chamada.
      setDay(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    reload();
  }, [module, reload]);

  const value = useMemo(
    () => ({
      day: day || null,
      cashDayId: day?.id || null,
      isOpen: !!day && day.status === 'open',
      loading,
      reload,
      setDay,
    }),
    [day, loading, reload],
  );

  return <CashDayContext.Provider value={value}>{children}</CashDayContext.Provider>;
};
