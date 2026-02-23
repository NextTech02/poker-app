import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../config/api';
import nextHubLogo from '../assets/next-hub-logo.png';
import { useTimerSync, formatTime as formatTimerTime, formatTimeHuman } from '../hooks/useTimerSync';
import './TournamentBroadcast.css';

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

// ── Currency helpers ──────────────────────────────────────────────────────────
const CURRENCY_SYMBOLS = {
  BRL: 'R$',
  USD: '$',
  EUR: '€',
  GBP: '£',
  ARS: '$',
  COP: '$',
};

const getCurrencySymbol = (code) => CURRENCY_SYMBOLS[code] || code || 'R$';

const formatCurrencyValue = (v, currency) => {
  const locale = currency === 'BRL' ? 'pt-BR' : 'en-US';
  return `${getCurrencySymbol(currency)} ${parseFloat(v).toLocaleString(locale, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

// ── Prize Ticker ─────────────────────────────────────────────────────────────
const PrizeTicker = ({ prizes, fontScale = 1, prizeScale = 1, currency = 'BRL' }) => {
  if (!prizes || prizes.length === 0) return null;

  const s = prizeScale;
  // Duplicate items for seamless infinite loop
  const items = [...prizes, ...prizes];
  // Duration proportional to number of prizes (≈5s per item)
  const duration = prizes.length * 5;
  // Bar height scales with prize size
  const barHeight = Math.round(48 * s);

  return (
    <div className="prize-ticker-bar" style={{ height: `${barHeight}px` }}>
      <div className="prize-ticker-label" style={{ fontSize: `${12 * s}px` }}>
        PREMIAÇÕES
      </div>
      <div className="prize-ticker-track-wrap">
        <div
          className="prize-ticker-track"
          style={{ animationDuration: `${duration}s` }}
        >
          {items.map((prize, idx) => (
            <span key={idx} className="prize-ticker-item">
              <span className="prize-ticker-pos" style={{ fontSize: `${14 * s}px` }}>
                {prize.position}º Lugar
              </span>
              <span className="prize-ticker-sep">:</span>
              <span className="prize-ticker-val" style={{ fontSize: `${16 * s}px` }}>
                {formatCurrencyValue(prize.prize_amount, currency)}
              </span>
              <span className="prize-ticker-dot">◆</span>
            </span>
          ))}
        </div>
      </div>
    </div>
  );
};

// ─────────────────────────────────────────────────────────────────────────────

const TournamentBroadcast = () => {
  const { t } = useTranslation();
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
  const [prizeSummary, setPrizeSummary] = useState(null);
  const [totalPlayTime, setTotalPlayTime] = useState(0);
  const [isDayBased, setIsDayBased] = useState(false);
  const [prizeAllocations, setPrizeAllocations] = useState([]);
  const [aggregatedStats, setAggregatedStats] = useState(null);

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

  // Fetch tournament data (initial load)
  const fetchTournamentData = async (initializeTimer = false) => {
    try {
      let dayData = null;
      let tournamentData = null;
      let playersData = null;
      let blindsData = null;

      try {
        const dayRes = await api.get(`/tournament-days/${id}`);
        dayData = dayRes.data;
        setIsDayBased(true);
        setTournamentDay(dayData);

        const tournamentRes = await api.get(`/tournaments/${dayData.tournament_id}`);
        tournamentData = tournamentRes.data;

        const playersRes = await api.get(`/tournament-players/day/${id}`);
        playersData = playersRes.data;

        try {
          const dayBlindsRes = await api.get(`/tournament-days/${id}/blinds`);
          blindsData = dayBlindsRes.data;
          if (!blindsData || blindsData.length === 0) {
            const tournamentBlindsRes = await api.get(`/tournaments/${dayData.tournament_id}/blinds`);
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
          api.get(`/tournaments/${id}/blinds`)
        ]);
        tournamentData = tournamentRes.data;
        playersData = playersRes.data;
        blindsData = blindsRes.data;
      }

      try {
        const tournamentIdForPrizes = dayData ? dayData.tournament_id : id;
        const [prizesRes, summaryRes] = await Promise.all([
          api.get(`/tournaments/${tournamentIdForPrizes}/prizes`),
          api.get(`/tournaments/${tournamentIdForPrizes}/prizes/summary`),
        ]);
        setPrizeAllocations(prizesRes.data || []);
        setPrizeSummary(summaryRes.data || null);
      } catch {
        setPrizeAllocations([]);
        setPrizeSummary(null);
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

  // Legacy: get blind values from local array (non-day tournaments only)
  const getBlindValues = (level) => {
    if (!blinds || blinds.length === 0) {
      return { smallBlind: 0, bigBlind: 0, ante: 0, duration: 15 };
    }
    const blind = blinds.find(b => b.level === level);
    if (blind) {
      return { smallBlind: blind.small_blind, bigBlind: blind.big_blind, ante: blind.ante || 0, duration: blind.duration || 15 };
    }
    const lastBlind = blinds[blinds.length - 1];
    return { smallBlind: lastBlind?.small_blind || 0, bigBlind: lastBlind?.big_blind || 0, ante: lastBlind?.ante || 0, duration: lastBlind?.duration || 15 };
  };

  const getNextBlindValues = (level) => getBlindValues(level + 1);

  // Initial load and player polling
  useEffect(() => {
    let isMounted = true;
    fetchTournamentData(true);

    const pollingInterval = setInterval(() => {
      if (!isMounted) return;
      fetchPlayersOnly();
    }, 10000);

    return () => { isMounted = false; clearInterval(pollingInterval); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

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
              const nextBlindData = getBlindValues(nextLevel);
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

  useEffect(() => {
    // Reset fired alerts when blind level changes
    if (prevLevelRef.current !== null && prevLevelRef.current !== currentLevelForAlert) {
      firedAlertsRef.current = new Set();
    }
    prevLevelRef.current = currentLevelForAlert;

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
  }, [currentTimeForAlert, currentLevelForAlert, currentBlindIsBreakForAlert, playBeep]);

  // Format helpers
  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const formatInterval = (seconds) => {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const getTimeUntilBreak = () => {
    if (!tournament) return 0;
    const breakInterval = (tournament.break_interval || 60) * 60;
    const timeIntoCurrentCycle = totalPlayTime % breakInterval;
    return breakInterval - timeIntoCurrentCycle;
  };

  // Compute ticker height before any early returns (Rules of Hooks)
  const prizeScaleEarly = ((tournamentDay?.broadcast_prize_size ?? tournament?.broadcast_prize_size) || 100) / 100;
  const tickerHeightEarly = Math.round(48 * prizeScaleEarly);

  // Propagate ticker height to :root so position:fixed elements can use it via CSS var
  useEffect(() => {
    document.documentElement.style.setProperty('--prize-ticker-height', `${tickerHeightEarly}px`);
    return () => document.documentElement.style.removeProperty('--prize-ticker-height');
  }, [tickerHeightEarly]);

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

  // Broadcast settings - read from tournament day (per-day config), fallback to tournament
  const bSource = tournamentDay || tournament;
  const broadcastSettings = {
    bgColor: bSource?.broadcast_bg_color || '#0a0e13',
    bgImageUrl: bSource?.broadcast_bg_image_url || null,
    displayName: bSource?.broadcast_display_name || null,
    fontSize: bSource?.broadcast_font_size || 100,
    showLogo: bSource?.broadcast_show_logo !== false,
    showTitle: bSource?.broadcast_show_title !== false,
    showPrizepool: bSource?.broadcast_show_prizepool !== false,
    showLevel: bSource?.broadcast_show_level !== false,
    showPlayers: bSource?.broadcast_show_players !== false,
    showInterval: bSource?.broadcast_show_interval !== false,
    showTimer: bSource?.broadcast_show_timer !== false,
    showBlinds: bSource?.broadcast_show_blinds !== false,
    showAnte: bSource?.broadcast_show_ante !== false,
    showNextBlind: bSource?.broadcast_show_next_blind !== false,
    showPrizes: bSource?.broadcast_show_prizes !== false,
    showChipcount: bSource?.broadcast_show_chipcount !== false,
    showAverage: bSource?.broadcast_show_average !== false,
  };

  const fontScale = broadcastSettings.fontSize / 100;
  const prizeScale = (bSource?.broadcast_prize_size || 100) / 100;
  const prizepoolScale = (bSource?.broadcast_prizepool_size || 100) / 100;
  const prizepoolLabelColor = bSource?.broadcast_prizepool_label_color || '#ffffff';
  const prizepoolValueColor = bSource?.broadcast_prizepool_value_color || '#ffffff';
  const dayCurrency = tournamentDay?.currency || 'BRL';

  // Per-element colors
  const colors = {
    timer:        bSource?.broadcast_timer_color         || '#d4af37',
    title:        bSource?.broadcast_title_color         || '#d4af37',
    blindsLabel:  bSource?.broadcast_blinds_label_color  || '#d4af37',
    blindsValue:  bSource?.broadcast_blinds_value_color  || '#ffffff',
    anteLabel:    bSource?.broadcast_ante_label_color    || '#d4af37',
    anteValue:    bSource?.broadcast_ante_value_color    || '#d4af37',
    nextLabel:    bSource?.broadcast_next_label_color    || '#d4af37',
    nextValue:    bSource?.broadcast_next_value_color    || '#9ca3af',
    sidebarLabel: bSource?.broadcast_sidebar_label_color || '#9ca3af',
    sidebarValue: bSource?.broadcast_sidebar_value_color || '#d4af37',
  };

  // Prizepool = guaranteed + all-days entries net of rake (from backend summary)
  const displayPrizePool = parseFloat(prizeSummary?.available_prize_pool || tournamentDay?.prize_pool || 0);

  const containerStyle = {};
  if (broadcastSettings.bgImageUrl) {
    containerStyle.backgroundImage = `url(${broadcastSettings.bgImageUrl})`;
    containerStyle.backgroundSize = 'cover';
    containerStyle.backgroundPosition = 'center';
    containerStyle.backgroundRepeat = 'no-repeat';
  } else if (broadcastSettings.bgColor && broadcastSettings.bgColor !== '#0a0e13') {
    containerStyle.background = broadcastSettings.bgColor;
  }

  const displayName = broadcastSettings.displayName ||
    (tournamentDay ? `${tournament.name} - ${tournamentDay.day_name}` : tournament.name);

  const tickerHeight = Math.round(48 * prizeScale);

  // Check if completed
  const currentStatus = tournamentDay?.status || tournament?.status;
  if (currentStatus === 'completed') {
    return (
      <div className="broadcast-container" style={containerStyle}>
        <header className="broadcast-header">
          {broadcastSettings.showLogo && (
            <div className="broadcast-logo">
              <img src={nextHubLogo} alt="Next Hub" className="broadcast-logo-img" />
            </div>
          )}
          {broadcastSettings.showTitle && (
            <div className="broadcast-title"><h1 style={{ color: colors.title, backgroundImage: 'none', WebkitTextFillColor: colors.title }}>{displayName}</h1></div>
          )}
          <div className="broadcast-header-spacer"></div>
        </header>
        <div className="broadcast-main">
          <div className="broadcast-completed">
            <div className="completed-icon">&#127942;</div>
            <h2>{t('common.completed').toUpperCase()}</h2>
            <p>{t('common.noData')}</p>
            <div className="completed-stats">
              <div className="stat-item">
                <span className="stat-label">{t('elimination.totalPlayers')}</span>
                <span className="stat-value">{players.length}</span>
              </div>
            </div>
          </div>
        </div>
        {broadcastSettings.showPrizepool && (
          <div className="broadcast-prizepool-corner">
            <div className="prize-label" style={{ fontSize: `${13 * prizepoolScale}px`, color: prizepoolLabelColor }}>PRIZEPOOL</div>
            <div className="prize-amount" style={{ fontSize: `${32 * prizepoolScale}px`, color: prizepoolValueColor }}>
              {formatCurrencyValue(displayPrizePool, dayCurrency)}
            </div>
          </div>
        )}
        {broadcastSettings.showPrizes && prizeAllocations.length > 0 && (
          <PrizeTicker prizes={prizeAllocations} fontScale={fontScale} prizeScale={prizeScale} currency={dayCurrency} />
        )}
      </div>
    );
  }

  // === DISPLAY VALUES ===
  // For day-based: use enriched endpoint (timerState) as SINGLE SOURCE
  // For legacy: use local state
  let displayBlindLevel, displayTimeRemaining, displaySmallBlind, displayBigBlind, displayAnte;
  let displayNextSmallBlind, displayNextBigBlind, displayNextAnte;
  let currentBlindIsBreak = false;
  let nextBlindIsBreak = false;

  if (isDayBased && timerState) {
    displayBlindLevel = timerState.current_level;
    displayTimeRemaining = timerState.time_remaining_current_level;
    displaySmallBlind = timerState.current_blind?.small_blind || 0;
    displayBigBlind = timerState.current_blind?.big_blind || 0;
    displayAnte = timerState.current_blind?.ante || 0;
    currentBlindIsBreak = timerState.current_blind?.is_break === true;

    displayNextSmallBlind = timerState.next_blind?.small_blind || 0;
    displayNextBigBlind = timerState.next_blind?.big_blind || 0;
    displayNextAnte = timerState.next_blind?.ante || 0;
    nextBlindIsBreak = timerState.next_blind?.is_break === true;
  } else {
    const currentBlinds = getBlindValues(blindLevel);
    const nextBlinds = getNextBlindValues(blindLevel);
    displayBlindLevel = blindLevel;
    displayTimeRemaining = timeRemaining;
    displaySmallBlind = currentBlinds.smallBlind;
    displayBigBlind = currentBlinds.bigBlind;
    displayAnte = currentBlinds.ante;
    displayNextSmallBlind = nextBlinds.smallBlind;
    displayNextBigBlind = nextBlinds.bigBlind;
    displayNextAnte = nextBlinds.ante;
  }

  // For day-based: active players and entries come from enriched endpoint (entries - eliminations)
  const activePlayers = (isDayBased && timerState) ? (timerState.active_players || 0) : players.filter(p => p.status !== 'eliminated').length;
  const totalEntries = (isDayBased && timerState) ? (timerState.total_entries || 0) : players.reduce((sum, p) => {
    return sum + (p.buy_in_count || 0) + (p.rebuy_count || 0);
  }, 0);

  // Chipcount and average stack (day-based only, from enriched endpoint)
  const chipcount = (isDayBased && timerState) ? (timerState.chipcount || 0) : 0;
  const averageStack = (isDayBased && timerState) ? (timerState.average_stack || 0) : 0;

  const formatChips = (n) => {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
    return n.toLocaleString();
  };

  const isFinalDay = tournamentDay?.day_type === 'final' || players.some(p => p.is_qualified_entry);
  let displayActivePlayers = activePlayers;
  let displayTotalPlayers = totalEntries;

  if (isFinalDay && aggregatedStats) {
    const totalQualifyingPlayers = aggregatedStats.qualifying_days?.reduce(
      (sum, day) => sum + (day.total_players || 0), 0
    ) || 0;
    if (totalQualifyingPlayers > 0) displayTotalPlayers = totalQualifyingPlayers;
  }

  return (
    <div className="broadcast-container" style={containerStyle}>
      <header className="broadcast-header">
        {broadcastSettings.showLogo && (
          <div className="broadcast-logo">
            <img src={nextHubLogo} alt="Next Hub" className="broadcast-logo-img" />
          </div>
        )}
        {broadcastSettings.showTitle && (
          <div className="broadcast-title">
            <h1 style={{ color: colors.title, backgroundImage: 'none', WebkitTextFillColor: colors.title }}>{displayName}</h1>
          </div>
        )}
        <div className="broadcast-header-spacer"></div>
      </header>

      <div className="broadcast-main">
        {(broadcastSettings.showLevel || broadcastSettings.showPlayers || broadcastSettings.showInterval || broadcastSettings.showChipcount || broadcastSettings.showAverage) && (
          <aside className="broadcast-sidebar">
            {broadcastSettings.showLevel && (
              <div className="sidebar-section">
                <div className="sidebar-label" style={{ fontSize: `${13 * fontScale}px`, color: colors.sidebarLabel }}>{t('broadcast.level')} {displayBlindLevel}</div>
              </div>
            )}

            {broadcastSettings.showPlayers && (
              <div className="sidebar-section">
                <div className="sidebar-label" style={{ fontSize: `${13 * fontScale}px`, color: colors.sidebarLabel }}>{t('broadcast.players').toUpperCase()}</div>
                <div className="sidebar-value" style={{ fontSize: `${32 * fontScale}px`, color: colors.sidebarValue }}>{displayActivePlayers} / {displayTotalPlayers}</div>
              </div>
            )}

            {broadcastSettings.showPlayers && totalEntries > 0 && (
              <div className="sidebar-section">
                <div className="sidebar-label" style={{ fontSize: `${13 * fontScale}px`, color: colors.sidebarLabel }}>{t('broadcast.entries').toUpperCase()}</div>
                <div className="sidebar-value" style={{ fontSize: `${32 * fontScale}px`, color: colors.sidebarValue }}>{totalEntries}</div>
              </div>
            )}

            {isDayBased && broadcastSettings.showChipcount && chipcount > 0 && (
              <div className="sidebar-section">
                <div className="sidebar-label" style={{ fontSize: `${13 * fontScale}px`, color: colors.sidebarLabel }}>CHIP COUNT</div>
                <div className="sidebar-value" style={{ fontSize: `${28 * fontScale}px`, color: colors.sidebarValue }}>{formatChips(chipcount)}</div>
              </div>
            )}

            {isDayBased && broadcastSettings.showAverage && averageStack > 0 && (
              <div className="sidebar-section">
                <div className="sidebar-label" style={{ fontSize: `${13 * fontScale}px`, color: colors.sidebarLabel }}>MÉDIA</div>
                <div className="sidebar-value" style={{ fontSize: `${28 * fontScale}px`, color: colors.sidebarValue }}>{formatChips(averageStack)}</div>
              </div>
            )}

            {/* Break countdown from enriched endpoint for day-based */}
            {isDayBased && timerState?.next_break && (
              <div className="sidebar-section">
                <div className="sidebar-label" style={{ fontSize: `${13 * fontScale}px`, color: colors.sidebarLabel }}>INTERVALO EM</div>
                <div className="sidebar-value" style={{ fontSize: `${32 * fontScale}px`, color: colors.sidebarValue }}>
                  {formatTimeHuman(timerState.next_break.time_until_break)}
                </div>
              </div>
            )}

            {/* Legacy break countdown for non-day tournaments */}
            {broadcastSettings.showInterval && !isDayBased && (
              <div className="sidebar-section">
                <div className="sidebar-label" style={{ fontSize: `${13 * fontScale}px` }}>{t('broadcast.intervalIn').toUpperCase()}</div>
                <div className="sidebar-value" style={{ fontSize: `${32 * fontScale}px` }}>{formatInterval(getTimeUntilBreak())}</div>
              </div>
            )}
          </aside>
        )}

        <main className="broadcast-center">
          {/* Break overlay for day-based tournaments */}
          {isDayBased && currentBlindIsBreak ? (
            <>
              <div className="broadcast-break-label" style={{ fontSize: `${36 * fontScale}px`, color: colors.timer }}>INTERVALO</div>
              {broadcastSettings.showTimer && (
                <div className="timer-display break-timer-display" style={{ fontSize: `${160 * fontScale}px`, color: colors.timer }}>
                  {formatTimerTime(displayTimeRemaining)}
                </div>
              )}
            </>
          ) : (
            <>
              {broadcastSettings.showTimer && (
                <div className="timer-display" style={{ fontSize: `${160 * fontScale}px`, color: colors.timer }}>
                  {formatTimerTime(displayTimeRemaining)}
                </div>
              )}

              {broadcastSettings.showBlinds && (
                <div className="blinds-section">
                  <div className="blinds-label" style={{ fontSize: `${16 * fontScale}px`, color: colors.blindsLabel }}>{t('broadcast.blinds')}</div>
                  <div className="blinds-value" style={{ fontSize: `${80 * fontScale}px`, color: colors.blindsValue }}>{displaySmallBlind}/{displayBigBlind}</div>
                </div>
              )}

              {broadcastSettings.showAnte && (
                <div className="ante-section">
                  <div className="ante-label" style={{ fontSize: `${14 * fontScale}px`, color: colors.anteLabel }}>{t('broadcast.ante')}</div>
                  <div className="ante-value" style={{ fontSize: `${36 * fontScale}px`, color: colors.anteValue }}>{displayAnte}</div>
                </div>
              )}

              {broadcastSettings.showNextBlind && (
                <div className="next-blind-section">
                  <div className="next-blind-label" style={{ fontSize: `${14 * fontScale}px`, color: colors.nextLabel }}>{t('broadcast.nextBlinds')}</div>
                  <div className="next-blind-value" style={{ fontSize: `${24 * fontScale}px`, color: colors.nextValue }}>
                    {nextBlindIsBreak
                      ? `INTERVALO`
                      : `${displayNextSmallBlind}/${displayNextBigBlind} ( ${displayNextAnte} )`
                    }
                  </div>
                </div>
              )}
            </>
          )}
        </main>

      </div>

      {/* Prizepool - Bottom Right */}
      {broadcastSettings.showPrizepool && (
        <div className="broadcast-prizepool-corner">
          <div className="prize-label" style={{ fontSize: `${13 * prizepoolScale}px`, color: prizepoolLabelColor }}>PRIZEPOOL</div>
          <div className="prize-amount" style={{ fontSize: `${32 * prizepoolScale}px`, color: prizepoolValueColor }}>
            {formatCurrencyValue(displayPrizePool, dayCurrency)}
          </div>
        </div>
      )}

      {/* Prize Ticker — scrolling bottom bar */}
      {broadcastSettings.showPrizes && prizeAllocations.length > 0 && (
        <PrizeTicker prizes={prizeAllocations} fontScale={fontScale} prizeScale={prizeScale} currency={dayCurrency} />
      )}

      {/* Legacy Break Overlay (non-day tournaments only) */}
      {!isDayBased && isOnBreak && (
        <div className="break-overlay">
          <div className="break-content">
            <div className="break-icon"></div>
            <h1 className="break-title">{t('broadcast.break').toUpperCase()}</h1>
            <div className="break-timer">{formatTime(breakTimeRemaining)}</div>
            <p className="break-subtitle">{t('broadcast.breakMessage')}</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default TournamentBroadcast;
