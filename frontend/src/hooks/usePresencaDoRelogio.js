import { useEffect, useState } from 'react';
import { supabase } from '../config/supabase';

/**
 * Quais mesas estão com o relógio aberto agora. Presence do Realtime: nada vai
 * ao banco, e um tablet que cai some da lista sozinho.
 *
 * Com `tableId`, esta tela se anuncia; sem ele, só observa (o painel do floor).
 *
 * @returns {string[]} ids das mesas com o relógio aberto.
 */
export function usePresencaDoRelogio(dayId, tableId = null) {
  const [mesas, setMesas] = useState([]);

  useEffect(() => {
    if (!dayId) return undefined;
    const canal = supabase.channel(
      `relogio-dia-${dayId}`,
      tableId ? { config: { presence: { key: tableId } } } : undefined,
    );
    canal.on('presence', { event: 'sync' }, () => setMesas(Object.keys(canal.presenceState())));
    canal.subscribe((situacao) => {
      if (situacao === 'SUBSCRIBED' && tableId) canal.track({ table_id: tableId });
    });
    return () => { supabase.removeChannel(canal); };
  }, [dayId, tableId]);

  return mesas;
}
