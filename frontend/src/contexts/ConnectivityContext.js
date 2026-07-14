import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import {
  isOnline as isOnlineNow,
  subscribe as subscribeConnectivity,
  startHeartbeat,
  recheck,
} from '../offline/connectivity';
import { getPendingCount } from '../offline/db';

/**
 * Expõe o estado de conectividade + contagem de mutações pendentes para a UI.
 * A fonte da verdade é o singleton `offline/connectivity.js` (heartbeat ao /health).
 * A fila (queue.js) dispara `OFFLINE_QUEUE_EVENT` no window quando muda, para
 * atualizarmos `pendingCount` sem polling.
 */
export const OFFLINE_QUEUE_EVENT = 'offline-queue-changed';

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
  const [lastSyncAt, setLastSyncAt] = useState(null);

  const refreshPending = useCallback(async () => {
    try {
      setPendingCount(await getPendingCount());
    } catch (e) {
      /* IndexedDB indisponível — ignora */
    }
  }, []);

  useEffect(() => {
    startHeartbeat();
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

  return (
    <ConnectivityContext.Provider
      value={{ isOnline: online, pendingCount, lastSyncAt, recheck }}
    >
      {children}
    </ConnectivityContext.Provider>
  );
};
