import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import api from '../config/api';
import { supabase } from '../config/supabase';
import { isOnline as redeOnline, subscribe as assinarConectividade } from '../offline/connectivity';

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
 * Além do fim de nível automático, `applyLocalCommand` aplica na TELA um comando
 * do operador (virar blind, ajustar tempo, reiniciar) que não conseguiu chegar ao
 * servidor — a fila offline reexecuta depois. Sem isso o relógio do telão ficava
 * ignorando o clique até a rede voltar, que é a pior hora para a mesa duvidar do
 * relógio.
 *
 * @param {string} dayId - Tournament day ID
 * @param {Array} blinds - Optional sorted blind structure for offline fallback
 * @returns {Object} { timerState, refetch, triggerRefetch, applyOptimistic, applyLocalCommand, isOffline, error, isLoading }
 */

const REANCHOR_DRIFT = 2.5; // segundos de divergência que forçam re-ancoragem (snap)

// Por quanto tempo a tela segura o nível aplicado localmente enquanto o servidor
// ainda responde o nível ANTIGO (o comando está na fila de sincronização). Sem
// essa trava o telão "pisca" de volta para o blind anterior por alguns segundos
// assim que a internet volta — exatamente na frente da mesa.
const OPTIMISTIC_LEVEL_HOLD_MS = 15000;

// Quantas falhas SEGUIDAS do poll DESTE relógio ligam o modo local. O sinal
// global de conectividade não liga o modo local sozinho — ele só ANTECIPA a
// decisão quando este relógio já falhou pelo menos uma vez. Motivo: uma
// requisição de outra tela marcando a rede como offline colocaria este telão
// para avançar de nível por conta própria enquanto /timer responde normal, e
// dois telões avançando sozinhos mostram HORAS DIFERENTES na mesma sala. Um
// relógio parado todo mundo percebe; dois discordando vira discussão na mesa.
const FALHAS_PARA_MODO_LOCAL = 2;
const FALHAS_PARA_MODO_LOCAL_COM_SINAL_GLOBAL = 1;

// Pure helpers (module scope so they're stable and dependency-free).
//
// Anchor shapes:
//  - ABSOLUTE (running, server sent current_level_ends_at): { endsAt, breakEndsAt,
//    level, paused:false } — endsAt/breakEndsAt são epoch SEGUNDOS. Todas as telas
//    derivam do MESMO instante absoluto → sincronia exata, sem jitter.
//  - RELATIVE/FROZEN (pausado, otimista, ou backend sem ends_at): { at, remaining,
//    breakRemaining, level, paused }.
// Varre a estrutura para frente a partir de `indiceDoAlvo` e devolve o próximo
// intervalo já com quanto tempo falta para ele. null = não há intervalo à frente.
const acharProximoIntervalo = (blinds, indiceDoAlvo, segundosDoAlvo) => {
  let faltaParaOIntervalo = segundosDoAlvo;
  for (let i = indiceDoAlvo + 1; i < blinds.length; i++) {
    if (blinds[i].is_break) {
      return {
        level: blinds[i].level,
        duration: blinds[i].duration * 60,
        time_until_break: faltaParaOIntervalo,
      };
    }
    faltaParaOIntervalo += blinds[i].duration * 60;
  }
  return null;
};

// Formato de blind que o estado do relógio (e as telas) esperam. null vira null.
const blindDoEstado = (b) => (b ? {
  level: b.level,
  small_blind: b.small_blind,
  big_blind: b.big_blind,
  ante: b.ante || 0,
  duration: b.duration,
  is_break: b.is_break || false,
} : null);

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
  const [isOffline, setIsOffline] = useState(false);   // aviso visível: o relógio está rodando local

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
  const optimisticLevelRef = useRef(null);    // { level, until } nível aplicado localmente

  // Keep refs in sync with state
  useEffect(() => { timerStateRef.current = timerState; }, [timerState]);
  useEffect(() => { blindsRef.current = blinds; }, [blinds]);

  // Modo offline num lugar só: o ref é lido pelo ticker (sem re-render) e o state
  // acende o aviso na tela. O operador PRECISA ver que está sem rede — um relógio
  // que não obedece, sem explicação, vira "o sistema quebrou" no meio do torneio.
  const marcarOffline = useCallback((offline) => {
    if (isOfflineRef.current === offline) return;
    isOfflineRef.current = offline;
    setIsOffline(offline);
  }, []);

  // Decide o modo local pela EVIDÊNCIA DESTE relógio (falhas do nosso próprio
  // poll). O sinal global só baixa o limiar de 2 para 1 falha: ele complementa
  // a evidência local, nunca a substitui. A saída do modo local continua sendo
  // um fetch bem-sucedido deste relógio.
  const avaliarModoLocal = useCallback(() => {
    const limite = redeOnline()
      ? FALHAS_PARA_MODO_LOCAL
      : FALHAS_PARA_MODO_LOCAL_COM_SINAL_GLOBAL;
    if (consecutiveFailsRef.current >= limite) marcarOffline(true);
  }, [marcarOffline]);

  // Monta localmente o estado de um nível VIZINHO, sem servidor (+1 próximo,
  // -1 anterior). Usado no fim do nível offline e quando o operador muda o blind
  // à mão sem internet. Devolve true se conseguiu mudar.
  //
  // `segurarNivel` só vale para o COMANDO do operador: aí existe uma escrita na
  // fila e o servidor ainda vai responder o nível antigo por um tempo. A virada
  // automática de fim de nível não segura nada — ali o servidor é a verdade e
  // deve poder corrigir a tela assim que a rede voltar.
  const shiftLevelLocally = useCallback((delta, segurarNivel = false) => {
    const currentState = timerStateRef.current;
    if (!currentState) return false;

    const currentBlinds = blindsRef.current;
    const currentLevel = currentState.current_level;
    const temEstrutura = Array.isArray(currentBlinds) && currentBlinds.length > 0;
    const currentIndex = temEstrutura
      ? currentBlinds.findIndex(b => b.level === currentLevel)
      : -1;
    const targetIndex = currentIndex + delta;

    let alvo = null;
    let depoisDoAlvo = null;
    let nextBreakInfo = null;

    if (currentIndex !== -1 && targetIndex >= 0 && targetIndex < currentBlinds.length) {
      alvo = currentBlinds[targetIndex];
      depoisDoAlvo = targetIndex + 1 < currentBlinds.length ? currentBlinds[targetIndex + 1] : null;

      nextBreakInfo = acharProximoIntervalo(currentBlinds, targetIndex, alvo.duration * 60);
    } else if (delta === 1 && currentState.next_blind
      && typeof currentState.next_blind.duration === 'number') {
      // Sem a estrutura em cache ainda dá para avançar UM nível: o próprio estado
      // enriquecido já traz o próximo blind. O que vem depois dele é desconhecido.
      alvo = currentState.next_blind;
      const agora = anchorNow(anchorRef.current);
      if (agora.breakRemaining != null) {
        // Pular o resto do nível também aproxima o intervalo na mesma medida.
        nextBreakInfo = {
          ...currentState.next_break,
          time_until_break: Math.max(0, agora.breakRemaining - (agora.remaining || 0)),
        };
      }
    } else {
      return false; // sem dados para o nível vizinho — melhor não inventar na tela
    }

    // Synthesize new timerState matching the server response shape
    const newState = {
      ...currentState,
      current_level: typeof alvo.level === 'number' ? alvo.level : currentLevel + delta,
      time_remaining_current_level: alvo.duration * 60,
      // Os instantes ABSOLUTOS vieram do servidor para o nível ANTIGO. Herdá-los
      // faria a âncora ler um fim já vencido e o telão travar em 00:00 no nível
      // novo — o "relógio travado" que o cliente viu ao mudar o blind sem rede.
      current_level_ends_at: null,
      next_break_starts_at: null,
      current_blind: blindDoEstado(alvo),
      next_blind: blindDoEstado(depoisDoAlvo),
      next_break: nextBreakInfo,
    };

    anchorRef.current = anchorFromData(newState);
    if (segurarNivel) {
      optimisticLevelRef.current = {
        level: newState.current_level,
        until: Date.now() + OPTIMISTIC_LEVEL_HOLD_MS,
      };
    }
    setTimerState(newState);
    return true;
  }, []);

  // Aplica na TELA um comando que não chegou ao servidor (sem rede). A fila
  // offline reexecuta quando a conexão voltar; até lá o telão mostra o que o
  // operador mandou, em vez de ignorar o clique em silêncio.
  const applyLocalCommand = useCallback((action, extra = {}) => {
    const currentState = timerStateRef.current;
    if (!currentState) return false;

    if (action === 'next-level') return shiftLevelLocally(1, true);
    if (action === 'prev-level') return shiftLevelLocally(-1, true);

    const agora = anchorNow(anchorRef.current);
    // Sem âncora local, cai no que o servidor disse por último; se nem isso for
    // número, começa do zero em vez de propagar undefined para a tela.
    const restanteDoServidor = typeof currentState.time_remaining_current_level === 'number'
      ? currentState.time_remaining_current_level
      : 0;
    const restanteAtual = agora.remaining != null ? agora.remaining : restanteDoServidor;

    let novoRestante = null;
    if (action === 'adjust' && typeof extra.seconds === 'number') {
      novoRestante = Math.max(0, restanteAtual + extra.seconds);
    } else if (action === 'reset') {
      const duracao = currentState.current_blind?.duration;
      if (typeof duracao !== 'number') return false;
      novoRestante = duracao * 60;
    } else {
      return false; // comando desconhecido — deixa para o servidor
    }

    // O intervalo anda junto: adiar/adiantar o nível adia/adianta o break.
    const deslocamento = novoRestante - restanteAtual;
    anchorRef.current = {
      at: Date.now(),
      paused: !!currentState.is_paused,
      level: currentState.current_level,
      remaining: novoRestante,
      breakRemaining: agora.breakRemaining == null
        ? null : Math.max(0, agora.breakRemaining + deslocamento),
    };
    setTimerState((prev) => (prev ? {
      ...prev,
      time_remaining_current_level: novoRestante,
      current_level_ends_at: null,
      next_break_starts_at: null,
    } : prev));
    return true;
  }, [shiftLevelLocally]);

  // Atualização OTIMISTA: reflete um comando (play/pause) na hora, sem esperar o
  // round-trip. Re-ancora sem salto. Se `patch.remaining` vier (valor COMPARTILHADO
  // pelo comando broadcast), congela/retoma EXATAMENTE nesse número — assim Controle
  // e telas de visualização mostram o mesmo valor; senão usa o valor exibido local.
  // optimisticRef segura o is_paused para um poll atrasado não reverter o comando.
  const applyOptimistic = useCallback((patch) => {
    if (!patch || typeof patch.is_paused !== 'boolean') return;
    optimisticRef.current = { is_paused: patch.is_paused, until: Date.now() + 6000 };
    const a = anchorRef.current;
    let remaining = null;
    let breakRemaining = null;
    if (typeof patch.remaining === 'number') {
      remaining = patch.remaining;
      breakRemaining = typeof patch.breakRemaining === 'number'
        ? patch.breakRemaining
        : (a ? anchorNow(a).breakRemaining : null);
    } else if (a) {
      const n = anchorNow(a);
      remaining = n.remaining;
      breakRemaining = n.breakRemaining;
    }
    if (remaining != null) {
      anchorRef.current = {
        at: Date.now(),
        paused: patch.is_paused,
        level: a ? a.level : timerStateRef.current?.current_level,
        remaining,
        breakRemaining,
      };
    }
    setTimerState((prev) => (prev ? { ...prev, is_paused: patch.is_paused } : prev));
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
      marcarOffline(false);

      // Trava do nível local: o operador mudou o blind sem rede e o comando ficou
      // na fila; até o servidor reexecutá-lo ele ainda responde o nível ANTIGO.
      // Sem isto a tela voltaria ao blind anterior por alguns segundos.
      let manterNivelLocal = false;
      const hold = optimisticLevelRef.current;
      if (hold) {
        const local = timerStateRef.current;
        if (Date.now() > hold.until || data.current_level === hold.level || !local) {
          optimisticLevelRef.current = null;
        } else {
          manterNivelLocal = true;
          data.current_level = local.current_level;
          data.current_blind = local.current_blind;
          data.next_blind = local.next_blind;
          data.next_break = local.next_break;
          data.time_remaining_current_level = local.time_remaining_current_level;
          data.current_level_ends_at = null;
          data.next_break_starts_at = null;
        }
      }

      const a = anchorRef.current;
      const paused = !!data.is_paused;
      const hasAbs = !paused && typeof data.current_level_ends_at === 'number';
      if (manterNivelLocal) {
        // âncora local preservada: o servidor ainda não sabe do comando
      } else if (hasAbs) {
        // Absoluto: valor estável e IDÊNTICO entre telas — adota sempre. Não causa
        // jitter porque endsAt é constante enquanto nível/elapsed não mudam.
        anchorRef.current = anchorFromData(data);
      } else {
        // Fallback relativo/pausado: re-ancora só em mudança real (nível, pause,
        // primeira carga, saída do modo absoluto) ou desvio GRANDE (ex.: ajuste
        // manual de tempo). Um desvio pequeno (~1s do atraso de propagação do
        // pause) NÃO re-ancora — assim o valor COMPARTILHADO pelo comando broadcast
        // (igual em todas as telas) não é sobrescrito pelo valor do servidor, que
        // congela ~1s depois por causa da latência do POST.
        let reanchor = !a || a.endsAt != null || a.level !== data.current_level || a.paused !== paused;
        if (!reanchor && typeof data.time_remaining_current_level === 'number') {
          const { remaining: displayed } = anchorNow(a);
          if (displayed == null || Math.abs(data.time_remaining_current_level - displayed) > REANCHOR_DRIFT) {
            reanchor = true;
          }
        }
        if (reanchor) anchorRef.current = anchorFromData(data);
      }

      setTimerState(data);
      setError(null);
      return data;
    } catch (err) {
      consecutiveFailsRef.current += 1;
      avaliarModoLocal();
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
            applyOptimistic(payload); // congela/retoma no valor COMPARTILHADO
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
  // Anexa o `remaining` ATUAL para que todas as telas congelem/retomem no MESMO
  // valor (sem o desvio de ~1s entre elas). Retorna o payload enriquecido para o
  // Controle aplicar localmente o mesmo valor.
  const broadcastCommand = useCallback((patch) => {
    const enriched = { ...patch };
    const a = anchorRef.current;
    if (a) {
      const n = anchorNow(a);
      if (n.remaining != null) enriched.remaining = n.remaining;
      if (n.breakRemaining != null) enriched.breakRemaining = n.breakRemaining;
    }
    const ch = channelRef.current;
    if (ch) {
      try {
        ch.send({ type: 'broadcast', event: 'timer-cmd', payload: enriched });
      } catch (e) {
        /* canal ainda não pronto — o caminho postgres_changes cobre depois */
      }
    }
    return enriched;
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
          shiftLevelLocally(1);
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
  }, [timerState?.is_paused, timerState?.current_level, shiftLevelLocally, fetchStatus]);

  // O sinal global de conectividade (heartbeat/axios) chega antes do nosso poll
  // falhar duas vezes. Ele é usado só para ANTECIPAR a decisão: reavalia o modo
  // local, que continua exigindo pelo menos uma falha DESTE relógio. Se /timer
  // responde normalmente, este relógio segue no servidor — é o que impede dois
  // telões de divergirem por causa de uma requisição alheia.
  useEffect(() => {
    avaliarModoLocal();
    return assinarConectividade(() => {
      avaliarModoLocal();
      // A volta só é confirmada por um fetch bem-sucedido deste relógio.
    });
  }, [avaliarModoLocal]);

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
    applyLocalCommand,
    broadcastCommand,
    isOffline,
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
