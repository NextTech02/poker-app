import { createContext, useContext, useEffect, useMemo, useState, useCallback } from 'react';
import {
  isOnline as isOnlineNow,
  subscribe as subscribeConnectivity,
  startHeartbeat,
  recheck,
  OFFLINE_QUEUE_EVENT,
} from '../offline/connectivity';
import { getPendingCount, getConflicts } from '../offline/db';
import { startSyncEngine } from '../offline/syncEngine';

/**
 * Expõe o estado de conectividade + contagem de mutações pendentes para a UI.
 * A fonte da verdade é o singleton `offline/connectivity.js` (heartbeat ao /health).
 * A fila (queue.js) dispara `OFFLINE_QUEUE_EVENT` no window quando muda, para
 * atualizarmos `pendingCount` sem polling.
 */
export { OFFLINE_QUEUE_EVENT };

const ConnectivityContext = createContext({
  isOnline: true,
  pendingCount: 0,
  lastSyncAt: null,
  recheck: () => {},
});

export const useConnectivity = () => useContext(ConnectivityContext);

export const ConnectivityProvider = ({ children }) => {
  const [online, setOnline] = useState(isOnlineNow());
  const [pendingCount, setPendingCount] = useState(0);
  const [conflictCount, setConflictCount] = useState(0);
  const [lastSyncAt, setLastSyncAt] = useState(null);

  const refreshPending = useCallback(async () => {
    try {
      setPendingCount(await getPendingCount());
      setConflictCount((await getConflicts()).length);
    } catch (e) {
      /* IndexedDB indisponível — ignora */
    }
  }, []);

  useEffect(() => {
    startHeartbeat();
    startSyncEngine();
    const unsub = subscribeConnectivity((v) => {
      setOnline(v);
      if (v) setLastSyncAt(Date.now());
    });
    refreshPending();

    const onQueueChange = () => refreshPending();
    window.addEventListener(OFFLINE_QUEUE_EVENT, onQueueChange);

    return () => {
      unsub();
      window.removeEventListener(OFFLINE_QUEUE_EVENT, onQueueChange);
    };
  }, [refreshPending]);

  // Este provider e o mais externo E o que mais muda de estado: heartbeat de
  // conectividade e cada mudanca na fila offline batem aqui. Sem memo, cada um
  // desses eventos repintava a aplicacao inteira.
  const value = useMemo(
    () => ({ isOnline: online, pendingCount, conflictCount, lastSyncAt, recheck }),
    [online, pendingCount, conflictCount, lastSyncAt],
  );

  return (
    <ConnectivityContext.Provider value={value}>
      {children}
    </ConnectivityContext.Provider>
  );
};
