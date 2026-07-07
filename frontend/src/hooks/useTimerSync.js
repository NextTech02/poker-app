import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import api from '../config/api';
import { supabase } from '../config/supabase';

/**
 * Shared hook for timer synchronization between Control Panel and Broadcast Screen.
 *
 * This is the SINGLE SOURCE OF TRUTH for timer display on both screens.
 * Both screens poll the same enriched endpoint and display the same values.
 * The backend auto-advances levels when elapsed time exceeds level duration.
 *
 * Uses a monotonic guard to prevent timer from jumping backward due to
 * server/client timing differences (int truncation, network latency).
 *
 * Supports OFFLINE MODE: when the server is unreachable and `blinds` array
 * is provided, the hook auto-advances levels locally using the cached blind
 * structure. When the server becomes reachable again, it resyncs seamlessly.
 *
 * @param {string} dayId - Tournament day ID
 * @param {Array} blinds - Optional sorted blind structure for offline fallback
 * @returns {Object} { timerState, refetch, error, isLoading }
 */
export const useTimerSync = (dayId, blinds = null) => {
  const [timerState, setTimerState] = useState(null);
  const [localTick, setLocalTick] = useState(0);
  const [error, setError] = useState(null);
  const lastLevelRef = useRef(null);
  const localTickRef = useRef(0);
  const timerStateRef = useRef(null);
  const consecutiveFailsRef = useRef(0);
  const isOfflineRef = useRef(false);
  const blindsRef = useRef(blinds);
  const inFlightRef = useRef(false); // evita requisições sobrepostas sob latência
  const realtimeDebounceRef = useRef(null); // colapsa rajadas de eventos Realtime

  // Keep refs in sync with state
  useEffect(() => { localTickRef.current = localTick; }, [localTick]);
  useEffect(() => { timerStateRef.current = timerState; }, [timerState]);
  useEffect(() => { blindsRef.current = blinds; }, [blinds]);

  // Offline fallback: advance to next level using cached blinds
  const advanceLocally = useCallback(() => {
    const currentBlinds = blindsRef.current;
    const currentState = timerStateRef.current;
    if (!currentBlinds || currentBlinds.length === 0 || !currentState) return;

    const currentLevel = currentState.current_level;
    const currentIndex = currentBlinds.findIndex(b => b.level === currentLevel);

    // Last level or not found — stay at 00:00
    if (currentIndex === -1 || currentIndex >= currentBlinds.length - 1) return;

    const nextBlind = currentBlinds[currentIndex + 1];
    const afterNextBlind = currentIndex + 2 < currentBlinds.length
      ? currentBlinds[currentIndex + 2]
      : null;

    // Find next break by scanning forward from new level
    let nextBreakInfo = null;
    let timeUntilBreak = nextBlind.duration * 60;
    for (let i = currentIndex + 2; i < currentBlinds.length; i++) {
      if (currentBlinds[i].is_break) {
        nextBreakInfo = {
          level: currentBlinds[i].level,
          duration: currentBlinds[i].duration * 60,
          time_until_break: timeUntilBreak
        };
        break;
      }
      timeUntilBreak += currentBlinds[i].duration * 60;
    }

    // Synthesize new timerState matching the server response shape
    const newState = {
      ...currentState,
      current_level: nextBlind.level,
      time_remaining_current_level: nextBlind.duration * 60,
      current_blind: {
        level: nextBlind.level,
        small_blind: nextBlind.small_blind,
        big_blind: nextBlind.big_blind,
        ante: nextBlind.ante || 0,
        duration: nextBlind.duration,
        is_break: nextBlind.is_break || false,
      },
      next_blind: afterNextBlind ? {
        level: afterNextBlind.level,
        small_blind: afterNextBlind.small_blind,
        big_blind: afterNextBlind.big_blind,
        ante: afterNextBlind.ante || 0,
        duration: afterNextBlind.duration,
        is_break: afterNextBlind.is_break || false,
      } : null,
      next_break: nextBreakInfo,
    };

    setTimerState(newState);
    setLocalTick(0);
  }, []);

  // Fetch enriched status from server
  const fetchStatus = useCallback(async () => {
    if (!dayId) return null;
    // Guarda contra requisições sobrepostas: sob latência alta em produção, o
    // intervalo dispararia novas chamadas antes da anterior terminar, empilhando
    // requests e fazendo o estado "pular".
    if (inFlightRef.current) return null;
    inFlightRef.current = true;
    const requestStart = Date.now();

    try {
      const res = await api.get(`/tournament-days/${dayId}/timer/status-enriched`);
      const data = { ...res.data };

      // Compensação de latência: o servidor calcula time_remaining no instante em
      // que processa a chamada (~metade do round-trip atrás). Descontamos essa
      // idade para exibir o tempo "de agora" — assim Controle e Broadcast, mesmo
      // com latências diferentes, convergem para o mesmo valor.
      const ageSec = data.is_paused ? 0 : Math.round((Date.now() - requestStart) / 2000);
      if (ageSec > 0) {
        if (typeof data.time_remaining_current_level === 'number') {
          data.time_remaining_current_level = Math.max(0, data.time_remaining_current_level - ageSec);
        }
        if (data.next_break && typeof data.next_break.time_until_break === 'number') {
          data.next_break = {
            ...data.next_break,
            time_until_break: Math.max(0, data.next_break.time_until_break - ageSec),
          };
        }
      }

      // Successful fetch — reset offline tracking
      consecutiveFailsRef.current = 0;
      isOfflineRef.current = false;

      const prev = timerStateRef.current;
      const prevTick = localTickRef.current;

      // Monotonic guard: prevent small backward jumps from server rounding (1-3s).
      // Large jumps (>5s) indicate a reset or manual time adjustment — accept them.
      // Also skip guard on pause state transitions (prev paused, now running or vice-versa).
      if (prev && prev.current_level === data.current_level && !data.is_paused && !prev.is_paused) {
        const currentDisplay = Math.max(0, prev.time_remaining_current_level - prevTick);
        const drift = data.time_remaining_current_level - currentDisplay;
        if (drift > 1 && drift <= 5) {
          // Small rounding drift — absorb via localTick offset to avoid visual stutter
          setTimerState(data);
          setLocalTick(drift);
          setError(null);
          lastLevelRef.current = data.current_level;
          return data;
        }
      }

      // Normal update: level changed, paused, or server agrees/is ahead
      setTimerState(data);
      setLocalTick(0);
      setError(null);

      if (lastLevelRef.current !== null && data.current_level !== lastLevelRef.current) {
        // Level changed
      }
      lastLevelRef.current = data.current_level;

      return data;
    } catch (err) {
      consecutiveFailsRef.current += 1;
      if (consecutiveFailsRef.current >= 2) {
        isOfflineRef.current = true;
      }

      // Only set error if we have no existing state and no blinds for fallback
      if (!timerStateRef.current && !blindsRef.current) {
        setError(err.message);
      }
      return null;
    } finally {
      inFlightRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayId]);

  // Poll server a cada ~3s, mas SEM empilhar: só agenda a próxima chamada depois
  // que a anterior termina. Sob latência alta, o intervalo efetivo cresce
  // sozinho (latência + 3s) em vez de acumular requisições atrasadas.
  useEffect(() => {
    if (!dayId) return undefined;

    let stopped = false;
    let timeoutId = null;
    const loop = async () => {
      await fetchStatus();
      if (!stopped) timeoutId = setTimeout(loop, 3000);
    };
    loop();

    return () => {
      stopped = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [fetchStatus, dayId]);

  // Dispara um refetch com debounce curto: colapsa rajadas de eventos Realtime
  // (ex.: várias linhas de blinds atualizadas de uma vez) numa única chamada.
  // Se um fetch já estiver em andamento (provavelmente iniciado ANTES do commit
  // que gerou o evento), reagenda para capturar o estado mais recente.
  const triggerRefetch = useCallback(() => {
    if (realtimeDebounceRef.current) clearTimeout(realtimeDebounceRef.current);
    realtimeDebounceRef.current = setTimeout(() => {
      if (inFlightRef.current) {
        triggerRefetch();
        return;
      }
      fetchStatus();
    }, 120);
  }, [fetchStatus]);

  // Supabase Realtime: empurra mudanças de comando (pause/próximo nível/ajuste em
  // tournament_days, e edições da estrutura em blinds) para TODAS as telas ao vivo
  // — Controle (autenticado) e Broadcast (anon) — quase instantaneamente, em vez
  // de esperar até o próximo poll de 3s. O evento apenas DISPARA o refetch da
  // fonte da verdade (endpoint enriquecido); o polling continua como fallback e o
  // ticker local de 1s mantém a contagem regressiva fluida.
  useEffect(() => {
    if (!dayId) return undefined;

    const channel = supabase
      .channel(`timer-sync-${dayId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'tournament_days', filter: `id=eq.${dayId}` },
        () => triggerRefetch()
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'blinds', filter: `tournament_day_id=eq.${dayId}` },
        () => triggerRefetch()
      )
      .subscribe();

    return () => {
      if (realtimeDebounceRef.current) clearTimeout(realtimeDebounceRef.current);
      supabase.removeChannel(channel);
    };
  }, [dayId, triggerRefetch]);

  // Local tick every second for smooth countdown
  useEffect(() => {
    if (!timerState || timerState.is_paused) return;

    const ticker = setInterval(() => {
      setLocalTick(prev => {
        const next = prev + 1;
        const remaining = timerState.time_remaining_current_level - next;
        if (remaining <= 0) {
          if (isOfflineRef.current && blindsRef.current?.length > 0) {
            // OFFLINE: advance locally using cached blind structure
            advanceLocally();
            return 0;
          } else {
            // ONLINE: fetch from server to get authoritative next level
            fetchStatus();
          }
        }
        return next;
      });
    }, 1000);

    return () => clearInterval(ticker);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timerState?.is_paused, timerState?.current_level, timerState?.time_remaining_current_level]);

  // Resync when page becomes visible again
  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden) {
        fetchStatus();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener('visibilitychange', handleVisibility);
  }, [fetchStatus]);

  // Calculate display values with local tick adjustment
  const displayState = useMemo(() => {
    if (!timerState) return null;

    const timeRemainingAdjusted = Math.max(0, timerState.time_remaining_current_level - localTick);

    const nextBreakAdjusted = timerState.next_break ? {
      ...timerState.next_break,
      time_until_break: Math.max(0, timerState.next_break.time_until_break - localTick)
    } : null;

    return {
      ...timerState,
      time_remaining_current_level: timeRemainingAdjusted,
      next_break: nextBreakAdjusted
    };
  }, [timerState, localTick]);

  return {
    timerState: displayState,
    rawState: timerState,
    refetch: fetchStatus,
    error,
    isLoading: !timerState && !error
  };
};

/**
 * Format seconds to MM:SS
 */
export const formatTime = (seconds) => {
  if (seconds == null || seconds < 0) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

/**
 * Format seconds to human-readable (e.g., "1h 20m", "15m 30s", "45s")
 */
export const formatTimeHuman = (seconds) => {
  if (seconds == null || seconds < 0) return '0s';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  } else if (minutes > 0) {
    return `${minutes}m ${secs}s`;
  } else {
    return `${secs}s`;
  }
};
