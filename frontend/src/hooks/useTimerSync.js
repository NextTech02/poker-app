import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import api from '../config/api';
import { supabase } from '../config/supabase';

/**
 * Shared hook for timer synchronization between Control Panel and Broadcast Screen.
 *
 * This is the SINGLE SOURCE OF TRUTH for timer display on both screens.
 *
 * TIMING MODEL — anchor-based clock:
 * The displayed countdown is derived from an ANCHOR `{ remaining, at, paused, level }`
 * as `remaining - (Date.now() - at)`. A 250ms interval only forces re-renders; it
 * never drives the value, so throttled/background tabs stay accurate and the tick
 * cadence never resets. Server fetches RE-ANCHOR only on a meaningful change (new
 * level, pause toggle, first data, or a large drift > THRESHOLD). Small per-poll
 * differences are ignored, so the clock ticks evenly instead of jumping on every
 * fetch (which, under variable network latency, caused the "sometimes fast /
 * sometimes slow" stutter).
 *
 * Supports OFFLINE MODE: when the server is unreachable and `blinds` array is
 * provided, the hook auto-advances levels locally using the cached blind structure.
 *
 * @param {string} dayId - Tournament day ID
 * @param {Array} blinds - Optional sorted blind structure for offline fallback
 * @returns {Object} { timerState, refetch, triggerRefetch, applyOptimistic, error, isLoading }
 */

const REANCHOR_DRIFT = 2.5; // segundos de divergência que forçam re-ancoragem (snap)

// Pure helpers (module scope so they're stable and dependency-free).
//
// Anchor shapes:
//  - ABSOLUTE (running, server sent current_level_ends_at): { endsAt, breakEndsAt,
//    level, paused:false } — endsAt/breakEndsAt são epoch SEGUNDOS. Todas as telas
//    derivam do MESMO instante absoluto → sincronia exata, sem jitter.
//  - RELATIVE/FROZEN (pausado, otimista, ou backend sem ends_at): { at, remaining,
//    breakRemaining, level, paused }.
const anchorFromData = (data) => {
  const paused = !!data.is_paused;
  if (!paused && typeof data.current_level_ends_at === 'number') {
    return {
      endsAt: data.current_level_ends_at,
      breakEndsAt: typeof data.next_break_starts_at === 'number' ? data.next_break_starts_at : null,
      level: data.current_level,
      paused: false,
    };
  }
  return {
    at: Date.now(),
    paused,
    level: data.current_level,
    remaining: typeof data.time_remaining_current_level === 'number'
      ? Math.max(0, data.time_remaining_current_level) : 0,
    breakRemaining: data.next_break && typeof data.next_break.time_until_break === 'number'
      ? Math.max(0, data.next_break.time_until_break) : null,
  };
};

// Current smooth values derived from an anchor. Absolute anchors derive from the
// wall clock (Date.now); relative/paused anchors tick from `at` (frozen if paused).
const anchorNow = (a) => {
  if (!a) return { remaining: null, breakRemaining: null };
  if (a.endsAt != null) {
    const now = Date.now() / 1000;
    return {
      remaining: Math.max(0, a.endsAt - now),
      breakRemaining: a.breakEndsAt != null ? Math.max(0, a.breakEndsAt - now) : null,
    };
  }
  const elapsed = a.paused ? 0 : (Date.now() - a.at) / 1000;
  return {
    remaining: Math.max(0, a.remaining - elapsed),
    breakRemaining: a.breakRemaining == null ? null : Math.max(0, a.breakRemaining - elapsed),
  };
};

export const useTimerSync = (dayId, blinds = null) => {
  const [timerState, setTimerState] = useState(null); // server metadata (blinds, players, is_paused, level…)
  const [renderTick, setRenderTick] = useState(0);     // forces the smooth countdown to recompute
  const [error, setError] = useState(null);

  const timerStateRef = useRef(null);
  const consecutiveFailsRef = useRef(0);
  const isOfflineRef = useRef(false);
  const blindsRef = useRef(blinds);
  const inFlightRef = useRef(false);          // evita requisições sobrepostas sob latência
  const realtimeDebounceRef = useRef(null);   // colapsa rajadas de eventos Realtime
  const optimisticRef = useRef(null);         // override otimista de is_paused até o servidor confirmar
  const anchorRef = useRef(null);             // { at, paused, level, remaining, breakRemaining }
  const lastEndFetchRef = useRef(0);          // throttle do fetch de fim-de-nível
  const channelRef = useRef(null);            // canal Realtime (p/ enviar comandos broadcast)

  // Keep refs in sync with state
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

    anchorRef.current = anchorFromData(newState);
    setTimerState(newState);
  }, []);

  // Atualização OTIMISTA: reflete um comando (play/pause) na hora, sem esperar o
  // round-trip. Re-ancora a partir do valor ATUALMENTE exibido (sem salto): pause
  // congela nele; play faz o relógio arrancar dele. optimisticRef segura o
  // is_paused para um poll atrasado não reverter o comando.
  const applyOptimistic = useCallback((patch) => {
    if (patch && typeof patch.is_paused === 'boolean') {
      optimisticRef.current = { is_paused: patch.is_paused, until: Date.now() + 6000 };
      const a = anchorRef.current;
      if (a) {
        const { remaining, breakRemaining } = anchorNow(a);
        anchorRef.current = {
          at: Date.now(),
          paused: patch.is_paused,
          level: a.level,
          remaining,
          breakRemaining,
        };
      }
    }
    setTimerState((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  // Fetch enriched status from server
  const fetchStatus = useCallback(async () => {
    if (!dayId) return null;
    // Guarda contra requisições sobrepostas sob latência alta.
    if (inFlightRef.current) return null;
    inFlightRef.current = true;
    const requestStart = Date.now();

    try {
      const res = await api.get(`/tournament-days/${dayId}/timer/status-enriched`);
      const data = { ...res.data };

      // Compensação de latência: o servidor calcula time_remaining ~metade do
      // round-trip atrás. Descontamos essa idade para ancorar no tempo "de agora".
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

      // Override otimista: segura o is_paused do comando até o servidor concordar.
      const opt = optimisticRef.current;
      if (opt) {
        if (Date.now() > opt.until || data.is_paused === opt.is_paused) {
          optimisticRef.current = null;
        } else {
          data.is_paused = opt.is_paused;
        }
      }

      // Successful fetch — reset offline tracking
      consecutiveFailsRef.current = 0;
      isOfflineRef.current = false;

      const a = anchorRef.current;
      const paused = !!data.is_paused;
      const hasAbs = !paused && typeof data.current_level_ends_at === 'number';
      if (hasAbs) {
        // Absoluto: valor estável e IDÊNTICO entre telas — adota sempre. Não causa
        // jitter porque endsAt é constante enquanto nível/elapsed não mudam.
        anchorRef.current = anchorFromData(data);
      } else {
        // Fallback relativo/pausado.
        let reanchor = !a || a.endsAt != null || a.level !== data.current_level || a.paused !== paused;
        if (!reanchor) {
          if (paused) {
            // PAUSADO: adota SEMPRE o valor autoritativo do servidor (não há tick, logo
            // sem risco de jitter) para que Controle e Broadcast mostrem exatamente o
            // MESMO tempo congelado — some o desvio residual de ~1s causado pelo atraso
            // de propagação (a tela espectadora conta um pouco a mais antes de congelar).
            reanchor = true;
          } else if (typeof data.time_remaining_current_level === 'number') {
            // RODANDO (sem abs): re-ancora só em desvio grande, para não introduzir jitter.
            const { remaining: displayed } = anchorNow(a);
            if (displayed == null || Math.abs(data.time_remaining_current_level - displayed) > REANCHOR_DRIFT) {
              reanchor = true;
            }
          }
        }
        if (reanchor) anchorRef.current = anchorFromData(data);
      }

      setTimerState(data);
      setError(null);
      return data;
    } catch (err) {
      consecutiveFailsRef.current += 1;
      if (consecutiveFailsRef.current >= 2) {
        isOfflineRef.current = true;
      }
      if (!timerStateRef.current && !blindsRef.current) {
        setError(err.message);
      }
      return null;
    } finally {
      inFlightRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dayId]);

  // Poll server a cada ~3s, SEM empilhar: só agenda a próxima após a anterior terminar.
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

  // Refetch com debounce curto: colapsa rajadas de eventos Realtime numa chamada.
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

  // Supabase Realtime: empurra mudanças de comando/blinds para todas as telas ao
  // vivo (Controle + Broadcast) quase instantaneamente.
  //
  // O evento de tournament_days JÁ TRAZ a linha nova (payload.new) — então a tela
  // de visualização (que não tem UI otimista, pois não emite o comando) reflete o
  // pause/start IMEDIATAMENTE a partir do payload (congela/retoma o relógio), sem
  // esperar o GET enriquecido. O refetch roda em seguida só para reconciliar
  // tempo/nível/blinds. Polling continua como fallback.
  useEffect(() => {
    if (!dayId) return undefined;

    const channel = supabase
      .channel(`timer-sync-${dayId}`, { config: { broadcast: { self: false } } })
      // Comando EFÊMERO cliente→cliente (não passa pelo backend/DB): quando o
      // operador clica pause/start, o Controle envia isto e TODAS as telas de
      // visualização reagem em ~100ms — muito antes do round-trip backend→DB→
      // postgres_changes. O postgres_changes abaixo ainda chega depois para
      // persistir/reconciliar o tempo exato.
      .on('broadcast', { event: 'timer-cmd' }, ({ payload }) => {
        if (payload && typeof payload.is_paused === 'boolean') {
          const cur = timerStateRef.current;
          if (!cur || cur.is_paused !== payload.is_paused) {
            applyOptimistic({ is_paused: payload.is_paused });
          }
        }
      })
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'tournament_days', filter: `id=eq.${dayId}` },
        (payload) => {
          const row = payload?.new;
          if (row && typeof row.is_paused === 'boolean') {
            const cur = timerStateRef.current;
            if (!cur || cur.is_paused !== row.is_paused) {
              // reflete pause/start (payload é a verdade do banco)
              applyOptimistic({ is_paused: row.is_paused });
            }
          }
          triggerRefetch();
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'blinds', filter: `tournament_day_id=eq.${dayId}` },
        () => triggerRefetch()
      )
      .subscribe();

    channelRef.current = channel;

    return () => {
      if (realtimeDebounceRef.current) clearTimeout(realtimeDebounceRef.current);
      channelRef.current = null;
      supabase.removeChannel(channel);
    };
  }, [dayId, triggerRefetch, applyOptimistic]);

  // Envia um comando EFÊMERO (pause/start) para as outras telas via Realtime
  // broadcast — reação quase instantânea, independente da latência do backend.
  const broadcastCommand = useCallback((patch) => {
    const ch = channelRef.current;
    if (ch) {
      try {
        ch.send({ type: 'broadcast', event: 'timer-cmd', payload: patch });
      } catch (e) {
        /* canal ainda não pronto — o caminho postgres_changes cobre depois */
      }
    }
  }, []);

  // Ticker AUTO-AGENDADO: em vez de amostrar a cada 250ms (o que deixava a virada
  // do segundo cair fora da grade → cadência irregular, "acelera e atrasa"), cada
  // atualização é agendada EXATAMENTE para a próxima virada de segundo do valor
  // exibido (ceil). Como recomputa o restante de Date.now() a cada disparo e
  // reagenda pela virada seguinte, não acumula drift. Só roda enquanto NÃO pausado
  // e reinicia apenas em pause/nível (nunca por atualização de valor → sem jitter).
  useEffect(() => {
    if (!timerState || timerState.is_paused) return undefined;

    let stopped = false;
    let timeoutId = null;

    const tick = () => {
      if (stopped) return;
      setRenderTick((t) => (t + 1) % 1000000); // força recomputar o display (ceil)

      const { remaining } = anchorNow(anchorRef.current);
      if (remaining == null) { timeoutId = setTimeout(tick, 250); return; }

      if (remaining <= 0) {
        // Fim do nível: avança local (offline) ou busca o próximo (throttled).
        if (isOfflineRef.current && blindsRef.current?.length > 0) {
          advanceLocally();
        } else {
          const now = Date.now();
          if (!inFlightRef.current && now - lastEndFetchRef.current > 1500) {
            lastEndFetchRef.current = now;
            fetchStatus();
          }
        }
        timeoutId = setTimeout(tick, 250); // aguarda o próximo nível chegar
        return;
      }

      // Agenda para logo após a próxima virada de segundo (com ceil, o display muda
      // quando `remaining` cruza um inteiro): frac até lá = remaining - ceil(remaining) + 1.
      const msToNextSecond = (remaining - Math.ceil(remaining) + 1) * 1000;
      timeoutId = setTimeout(tick, Math.max(20, msToNextSecond + 15));
    };

    tick();

    return () => { stopped = true; if (timeoutId) clearTimeout(timeoutId); };
  // Restart SÓ em pause/nível — nunca por atualização de valor (evita o jitter).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timerState?.is_paused, timerState?.current_level, advanceLocally, fetchStatus]);

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

  // Display values: metadata from timerState, live countdown from the anchor.
  const displayState = useMemo(() => {
    if (!timerState) return null;

    const a = anchorRef.current;
    let remaining = typeof timerState.time_remaining_current_level === 'number'
      ? timerState.time_remaining_current_level : 0;
    let breakRemaining = timerState.next_break ? timerState.next_break.time_until_break : null;

    if (a) {
      const r = anchorNow(a);
      remaining = r.remaining;
      if (r.breakRemaining != null) breakRemaining = r.breakRemaining;
    }

    return {
      ...timerState,
      // ceil = comportamento natural de contagem regressiva (cada segundo aparece
      // pelo intervalo cheio; "15:00" some só quando falta menos de 15:00).
      time_remaining_current_level: Math.ceil(remaining),
      next_break: timerState.next_break
        ? {
            ...timerState.next_break,
            time_until_break: breakRemaining == null
              ? timerState.next_break.time_until_break
              : Math.ceil(breakRemaining),
          }
        : null,
    };
  // renderTick força a recomputação do countdown ao vivo
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timerState, renderTick]);

  return {
    timerState: displayState,
    rawState: timerState,
    refetch: fetchStatus,
    triggerRefetch,
    applyOptimistic,
    broadcastCommand,
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
