import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import { useTimerSync } from '../hooks/useTimerSync';
import { usePolling } from '../hooks/usePolling';
import { labelsForLanguage } from '../utils/broadcastLabels';
import { idiomaEscolhidoPeloUsuario } from '../utils/idiomaDoUsuario';
import {
  lerFonteLocal, gravarFonteLocal, limparFonteLocal, proximaFonte, FONTE_MIN, FONTE_MAX, FONTE_PASSO,
} from '../utils/broadcastFontLocal';
import TvStage from '../components/broadcast/TvStage';
import TvScreen from '../components/broadcast/TvScreen';
import { buildTvModel, buildTvSettings, blindValuesAt, formatClock } from '../components/broadcast/tvModel';
import { resolveBackground } from '../components/broadcast/tvBackgrounds';
import './TournamentBroadcast.css';

/**
 * Tela de transmissão (o telão do salão). Pública: abre por `/tv/<código>`
 * sem login, ou por `/broadcast/:id` com id de DIA ou de TORNEIO (legado).
 *
 * A página só busca e sincroniza; quem desenha é `TvScreen` dentro de
 * `TvStage` (mesmos componentes da prévia das Configurações). Para o dia, o
 * relógio enriquecido (`useTimerSync`) é a fonte única; prêmios, moeda e nome
 * do clube vêm do endpoint PÚBLICO de extras — os endpoints de premiação
 * exigem login, e a TV do salão não tem.
 */

// Generate blinds structure from tournament day configuration (legacy fallback)
const generateBlindsFromDayConfig = (dayConfig, numLevels = 20) => {
  const blinds = [];
  let smallBlind = dayConfig.initial_small_blind || 25;
  let bigBlind = dayConfig.initial_big_blind || 50;
  const duration = dayConfig.blind_duration || 15;
  const increaseType = dayConfig.blind_increase_type || 'double';
  const bbAnteStartLevel = dayConfig.bb_ante_start_level || 3;

  for (let level = 1; level <= numLevels; level++) {
    const ante = level >= bbAnteStartLevel ? bigBlind : 0;
    blinds.push({ level, small_blind: smallBlind, big_blind: bigBlind, ante, duration });

    if (increaseType === 'double' || increaseType === '2x') {
      smallBlind *= 2; bigBlind *= 2;
    } else if (increaseType === 'triple' || increaseType === '3x') {
      smallBlind *= 3; bigBlind *= 3;
    } else if (increaseType === '1.5x') {
      smallBlind = Math.round(smallBlind * 1.5); bigBlind = Math.round(bigBlind * 1.5);
    }
  }
  return blinds;
};

// Legacy: calculate level from elapsed time (non-day tournaments only)
const calculateCurrentLevel = (elapsedSeconds, blindsArray) => {
  if (!blindsArray || blindsArray.length === 0) {
    return { level: 1, remainingSeconds: 0 };
  }
  let accumulatedTime = 0;
  for (let i = 0; i < blindsArray.length; i++) {
    const blind = blindsArray[i];
    const blindDurationSeconds = blind.duration * 60;
    if (elapsedSeconds < accumulatedTime + blindDurationSeconds) {
      const elapsedInLevel = elapsedSeconds - accumulatedTime;
      const remainingSeconds = blindDurationSeconds - elapsedInLevel;
      return { level: blind.level, remainingSeconds };
    }
    accumulatedTime += blindDurationSeconds;
  }
  const lastBlind = blindsArray[blindsArray.length - 1];
  return { level: lastBlind.level, remainingSeconds: 0 };
};

const TournamentBroadcast = () => {
  const { t, i18n } = useTranslation();
  const { id } = useParams();
  const [tournament, setTournament] = useState(null);
  const [tournamentDay, setTournamentDay] = useState(null);
  const [players, setPlayers] = useState([]);
  const [blinds, setBlinds] = useState([]);
  const [blindLevel, setBlindLevel] = useState(1);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isOnBreak, setIsOnBreak] = useState(false);
  const [breakTimeRemaining, setBreakTimeRemaining] = useState(0);
  const [totalPlayTime, setTotalPlayTime] = useState(0);
  const [isDayBased, setIsDayBased] = useState(false);
  const [aggregatedStats, setAggregatedStats] = useState(null);
  // Nome do clube, moeda, prize pool e prêmios visíveis — rota pública.
  const [extras, setExtras] = useState(null);

  // Tamanho de fonte ajustado pelos botões +/− do próprio telão. Enquanto
  // houver um valor aqui, ele vence o do servidor; vira null assim que o
  // servidor aceita o PATCH (aí o dado volta a ter uma fonte só).
  const [fonteLocal, setFonteLocal] = useState(() => lerFonteLocal(id));
  const patchFonteTimer = useRef(null);
  useEffect(() => () => clearTimeout(patchFonteTimer.current), []);

  // SINGLE SOURCE OF TRUTH for day-based tournaments (blinds passed for offline fallback)
  const { timerState } = useTimerSync(isDayBased ? id : null, blinds);

  // === Audio Alert System ===
  const audioContextRef = useRef(null);
  const firedAlertsRef = useRef(new Set());
  const prevLevelRef = useRef(null);

  const playBeep = useCallback((frequency, duration, volume = 0.5) => {
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = audioContextRef.current;
      const oscillator = ctx.createOscillator();
      const gainNode = ctx.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(ctx.destination);

      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(frequency, ctx.currentTime);
      gainNode.gain.setValueAtTime(volume, ctx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + duration);

      oscillator.start(ctx.currentTime);
      oscillator.stop(ctx.currentTime + duration);
    } catch (e) {
      // AudioContext not supported or blocked
    }
  }, []);

  const fetchExtras = async () => {
    try {
      const res = await api.get(`/public/tv/days/${id}/extras`, { _silentError: true });
      setExtras(res.data || null);
    } catch {
      setExtras(null);
    }
  };

  // Fetch tournament data (initial load)
  const fetchTournamentData = async (initializeTimer = false) => {
    try {
      let dayData = null;
      let tournamentData = null;
      let playersData = null;
      let blindsData = null;

      // ISSUE-010 fix: the `/broadcast/:id` route accepts either a tournament
      // day id or a tournament id. The initial probe against /tournament-days/:id
      // is expected to 404 when `id` is actually a tournament, so mark the
      // request as silent to avoid polluting the console with false positives.
      try {
        const dayRes = await api.get(`/tournament-days/${id}`, { _silentError: true });
        dayData = dayRes.data;
        setIsDayBased(true);
        setTournamentDay(dayData);

        const tournamentRes = await api.get(`/tournaments/${dayData.tournament_id}`);
        tournamentData = tournamentRes.data;

        const playersRes = await api.get(`/tournament-players/day/${id}`);
        playersData = playersRes.data;

        try {
          const dayBlindsRes = await api.get(`/tournament-days/${id}/blinds`, { _silentError: true });
          blindsData = dayBlindsRes.data;
          if (!blindsData || blindsData.length === 0) {
            const tournamentBlindsRes = await api.get(`/tournaments/${dayData.tournament_id}/blinds`, { _silentError: true });
            blindsData = tournamentBlindsRes.data;
          }
          if (!blindsData || blindsData.length === 0) {
            blindsData = generateBlindsFromDayConfig(dayData);
          }
        } catch {
          blindsData = generateBlindsFromDayConfig(dayData);
        }
      } catch {
        setIsDayBased(false);
        const [tournamentRes, playersRes, blindsRes] = await Promise.all([
          api.get(`/tournaments/${id}`),
          api.get(`/tournament-players/tournament/${id}`),
          api.get(`/tournaments/${id}/blinds`, { _silentError: true }),
        ]);
        tournamentData = tournamentRes.data;
        playersData = playersRes.data;
        blindsData = blindsRes.data;
      }

      // Prêmios, moeda e clube: só pelo endpoint público (sem login). Os de
      // premiação exigem autenticação e a TV do salão não tem — era por isso
      // que a premiação nunca aparecia no telão. Só existe por DIA.
      if (dayData) {
        await fetchExtras();
      } else {
        setExtras(null);
      }

      if (dayData && dayData.day_type === 'final') {
        try {
          const statsRes = await api.get(`/tournament-days/${id}/aggregated-stats`);
          setAggregatedStats(statsRes.data);
        } catch {
          setAggregatedStats(null);
        }
      }

      setTournament(tournamentData);
      setPlayers(playersData);
      const sortedBlinds = blindsData.sort((a, b) => a.level - b.level);
      setBlinds(sortedBlinds);

      // Legacy init for non-day tournaments
      const dataToCheck = dayData || tournamentData;
      if (initializeTimer && !dayData && dataToCheck.status === 'active') {
        const startTime = new Date(dataToCheck.start_time || dataToCheck.updated_at || dataToCheck.created_at);
        const now = new Date();
        const elapsedSeconds = Math.floor((now - startTime) / 1000);
        const { level: currentLevel, remainingSeconds } = calculateCurrentLevel(elapsedSeconds, sortedBlinds);
        setBlindLevel(currentLevel);
        setTimeRemaining(remainingSeconds);
        setTotalPlayTime(elapsedSeconds);
      } else if (initializeTimer && !dayData) {
        const firstBlind = sortedBlinds[0];
        setBlindLevel(1);
        setTimeRemaining((firstBlind?.duration || 15) * 60);
      }

      setLoading(false);
    } catch (err) {
      console.error('Error fetching tournament data:', err);
      setError(t('common.error'));
      setLoading(false);
    }
  };

  // Poll player updates
  const fetchPlayersOnly = async () => {
    if (tournament === null) return;
    try {
      let playersRes;
      if (isDayBased) {
        playersRes = await api.get(`/tournament-players/day/${id}`);
      } else {
        playersRes = await api.get(`/tournament-players/tournament/${id}`);
      }
      if (playersRes.data && Array.isArray(playersRes.data)) {
        setPlayers(playersRes.data);
      }
    } catch (err) {
      console.error('Error fetching players:', err);
    }
  };

  // Initial load
  useEffect(() => {
    fetchTournamentData(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Polling de jogadores (10s) e das configurações do dia + extras (30s),
  // ambos pausando quando a aba fica oculta. No display da transmissão
  // (sempre visível) seguem normais; numa aba de fundo, param de martelar a API.
  usePolling(() => fetchPlayersOnly(), 10000);
  usePolling(() => {
    if (!isDayBased) return;
    api.get(`/tournament-days/${id}`)
      .then((res) => setTournamentDay(res.data))
      .catch(() => { /* ignore */ });
    fetchExtras();
  }, isDayBased ? 30000 : 0);

  // Legacy timer countdown (NON-day tournaments only)
  useEffect(() => {
    if (isDayBased) return; // Day-based uses useTimerSync hook
    const activeStatus = tournament?.status;
    if (activeStatus !== 'active') return;

    const timer = setInterval(() => {
      if (isOnBreak) {
        setBreakTimeRemaining((prev) => {
          if (prev <= 1) { setIsOnBreak(false); return 0; }
          return prev - 1;
        });
      } else {
        setTimeRemaining((prev) => {
          if (prev <= 1) {
            setBlindLevel((currentLevel) => {
              const nextLevel = currentLevel + 1;
              const nextBlindData = blindValuesAt(blinds, nextLevel);
              setTimeRemaining(nextBlindData.duration * 60);
              return nextLevel;
            });
            return 0;
          }
          return prev - 1;
        });
        setTotalPlayTime((prev) => {
          const newPlayTime = prev + 1;
          const breakInterval = (tournament?.break_interval || 60) * 60;
          if (newPlayTime > 0 && newPlayTime % breakInterval === 0) {
            setIsOnBreak(true);
            setBreakTimeRemaining((tournament?.break_duration || 10) * 60);
          }
          return newPlayTime;
        });
      }
    }, 1000);

    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tournament, isOnBreak, isDayBased]);

  // === Audio alerts at 60s, 30s, and 1s before blind change ===
  const currentLevelForAlert = isDayBased && timerState ? timerState.current_level : blindLevel;
  const currentTimeForAlert = isDayBased && timerState ? timerState.time_remaining_current_level : timeRemaining;
  const currentBlindIsBreakForAlert = isDayBased && timerState ? timerState.current_blind?.is_break === true : false;

  const blindAlertsEnabled =
    (tournamentDay?.broadcast_blind_alerts_enabled ?? tournament?.broadcast_blind_alerts_enabled) !== false;

  useEffect(() => {
    // Reset fired alerts when blind level changes
    if (prevLevelRef.current !== null && prevLevelRef.current !== currentLevelForAlert) {
      firedAlertsRef.current = new Set();
    }
    prevLevelRef.current = currentLevelForAlert;

    // User disabled blind audio alerts for this day/tournament
    if (!blindAlertsEnabled) return;

    // Don't fire alerts during breaks
    if (currentBlindIsBreakForAlert) return;

    const seconds = currentTimeForAlert;
    if (seconds === undefined || seconds === null) return;

    const alertThresholds = [
      { time: 60, freq: 660, dur: 0.3, vol: 0.3 },  // gentle beep at 60s
      { time: 30, freq: 880, dur: 0.4, vol: 0.5 },   // medium beep at 30s
      { time: 1, freq: 1100, dur: 0.6, vol: 0.7 },    // urgent beep at 1s
    ];

    for (const alert of alertThresholds) {
      if (seconds === alert.time && !firedAlertsRef.current.has(alert.time)) {
        firedAlertsRef.current.add(alert.time);
        playBeep(alert.freq, alert.dur, alert.vol);
      }
    }
  }, [currentTimeForAlert, currentLevelForAlert, currentBlindIsBreakForAlert, blindAlertsEnabled, playBeep]);

  const getTimeUntilBreak = () => {
    if (!tournament) return 0;
    const breakInterval = (tournament.break_interval || 60) * 60;
    // Torneio antigo sem data de início: o tempo jogado sai NaN e o tile
    // mostraria "00:00" para sempre; conta como recém-começado.
    const played = Number.isFinite(totalPlayTime) ? totalPlayTime : 0;
    const timeIntoCurrentCycle = played % breakInterval;
    return breakInterval - timeIntoCurrentCycle;
  };

  if (loading) {
    return (
      <div className="broadcast-container">
        <div className="broadcast-loading">{t('common.loading')}</div>
      </div>
    );
  }

  if (error || !tournament) {
    return (
      <div className="broadcast-container">
        <div className="broadcast-error">{error || t('common.noData')}</div>
      </div>
    );
  }

  // Configurações: do DIA (por-dia), com o torneio como reserva no legado.
  const bSource = tournamentDay || tournament;
  const settings = buildTvSettings(bSource, { fontSizeOverride: fonteLocal });

  // Idioma do telão, na mesma regra do resto do app: a escolha explícita da
  // pessoa (bandeiras, guardada neste aparelho) vence; sem ela, o idioma do
  // CLUBE (vem nos extras públicos — a TV do salão não tem login para
  // aplicá-lo de outro jeito); sem extras (backend antigo), o idioma em que o
  // app está. A coluna `broadcast_language` do dia nunca ganhou tela para ser
  // escolhida e ficava em pt-BR para todo mundo: o telão "não traduzia".
  const L = labelsForLanguage(idiomaEscolhidoPeloUsuario() || extras?.language || i18n?.language);

  // Botões +/− do canto: a tela muda na hora; a gravação decide o destino.
  // Logado (o mesmo token que api.js manda no Authorization) e com dia: vai
  // para o servidor, com debounce para que cinco cliques virem um PATCH só.
  // Sem login, sem dia, ou se o servidor recusar (token velho, sem permissão,
  // sem rede): fica só neste aparelho. Sem toast — é tela pública, ninguém
  // está operando; o próprio tamanho na tela é o retorno.
  const ajustarFonte = (delta) => {
    const proximo = proximaFonte(settings.fontSize, delta);
    if (proximo === settings.fontSize) return;
    setFonteLocal(proximo);

    let logado = false;
    try { logado = Boolean(localStorage.getItem('supabase_token')); } catch (e) { /* storage bloqueado */ }

    if (!isDayBased || !logado) {
      gravarFonteLocal(id, proximo);
      return;
    }

    clearTimeout(patchFonteTimer.current);
    patchFonteTimer.current = setTimeout(() => {
      api.patch(`/tournament-days/${id}`, { broadcast_font_size: proximo })
        .then(() => {
          setTournamentDay((prev) => (prev ? { ...prev, broadcast_font_size: proximo } : prev));
          // Se a pessoa clicou de novo enquanto este PATCH voava, o valor
          // novo já está na tela e tem seu próprio PATCH a caminho: não apagar.
          setFonteLocal((atual) => (atual === proximo ? null : atual));
          limparFonteLocal(id);
        })
        .catch(() => gravarFonteLocal(id, proximo));
    }, 500);
  };

  const model = buildTvModel({
    isDayBased,
    timerState,
    tournament,
    tournamentDay,
    players,
    blinds,
    blindLevel,
    timeRemaining,
    legacyBreakIn: !isDayBased ? getTimeUntilBreak() : null,
    aggregatedStats,
    extras,
  });

  let mode = 'live';
  if (model.status === 'completed') mode = 'completed';
  else if (isDayBased && model.isBreak) mode = 'break';

  const background = resolveBackground(settings.bgValue, settings.bgColor, settings.bgOverlay);
  const currency = extras?.currency || 'BRL';

  return (
    <>
      <TvStage fit="viewport" background={background}>
        <TvScreen
          mode={mode}
          model={model}
          settings={settings}
          labels={L}
          currency={currency}
          fontScale={settings.fontSize / 100}
        />
      </TvStage>

      {/* Legacy Break Overlay (non-day tournaments only) */}
      {!isDayBased && isOnBreak && (
        <div className="break-overlay">
          <div className="break-content">
            <div className="break-title">{t('broadcast.break').toUpperCase()}</div>
            <div className="break-timer">{formatClock(breakTimeRemaining)}</div>
            <p className="break-subtitle">{t('broadcast.breakMessage')}</p>
          </div>
        </div>
      )}

      {/* Ajuste de fonte — INVISÍVEL (pedido do cliente, 2026-10): nada
          aparece no telão, nem ao mexer o mouse; só quem leva o cursor até o
          canto inferior esquerdo (ou chega por teclado) vê os botões. Fica
          fora do palco de propósito: é controle, não conteúdo. O slider das
          Configurações continua sendo o jeito normal de ajustar. */}
      <div
        className="broadcast-font-controls"
        role="group"
        aria-label={t('broadcast.fontSizeControls')}
      >
        <button
          type="button"
          className="broadcast-font-controls__btn"
          onClick={() => ajustarFonte(+FONTE_PASSO)}
          disabled={settings.fontSize >= FONTE_MAX}
          aria-label={t('broadcast.fontIncrease')}
          title={t('broadcast.fontIncrease')}
        >+</button>
        <span className="broadcast-font-controls__value">{settings.fontSize}%</span>
        <button
          type="button"
          className="broadcast-font-controls__btn"
          onClick={() => ajustarFonte(-FONTE_PASSO)}
          disabled={settings.fontSize <= FONTE_MIN}
          aria-label={t('broadcast.fontDecrease')}
          title={t('broadcast.fontDecrease')}
        >−</button>
      </div>
    </>
  );
};

export default TournamentBroadcast;
