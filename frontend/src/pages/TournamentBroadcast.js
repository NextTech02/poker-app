import React, { useState, useEffect } from 'react';
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
  const [totalPlayTime, setTotalPlayTime] = useState(0);
  const [isDayBased, setIsDayBased] = useState(false);
  const [prizeAllocations, setPrizeAllocations] = useState([]);
  const [aggregatedStats, setAggregatedStats] = useState(null);

  // SINGLE SOURCE OF TRUTH for day-based tournaments
  const { timerState } = useTimerSync(isDayBased ? id : null);

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
        const prizesRes = await api.get(`/tournaments/${tournamentIdForPrizes}/prizes`);
        setPrizeAllocations(prizesRes.data || []);
      } catch {
        setPrizeAllocations([]);
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

  // Broadcast settings
  const broadcastSettings = {
    bgColor: tournament?.broadcast_bg_color || '#0a0e13',
    bgImageUrl: tournament?.broadcast_bg_image_url || null,
    displayName: tournament?.broadcast_display_name || null,
    fontSize: tournament?.broadcast_font_size || 100,
    showLogo: tournament?.broadcast_show_logo !== false,
    showTitle: tournament?.broadcast_show_title !== false,
    showPrizepool: tournament?.broadcast_show_prizepool !== false,
    showLevel: tournament?.broadcast_show_level !== false,
    showPlayers: tournament?.broadcast_show_players !== false,
    showInterval: tournament?.broadcast_show_interval !== false,
    showTimer: tournament?.broadcast_show_timer !== false,
    showBlinds: tournament?.broadcast_show_blinds !== false,
    showAnte: tournament?.broadcast_show_ante !== false,
    showNextBlind: tournament?.broadcast_show_next_blind !== false,
    showPrizes: tournament?.broadcast_show_prizes !== false,
  };

  const fontScale = broadcastSettings.fontSize / 100;

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
            <div className="broadcast-title"><h1>{displayName}</h1></div>
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
            <div className="prize-label" style={{ fontSize: `${13 * fontScale}px` }}>PRIZEPOOL</div>
            <div className="prize-amount" style={{ fontSize: `${32 * fontScale}px` }}>
              $ {tournamentDay?.prize_pool || tournament.prize_pool ? (tournamentDay?.prize_pool || tournament.prize_pool).toFixed(2) : '0,00'}
            </div>
          </div>
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
            <h1>{displayName}</h1>
            {isFinalDay && <span className="day-type-indicator final">{t('broadcast.finalDay')}</span>}
            {tournamentDay?.day_type === 'qualifying' && <span className="day-type-indicator qualifying">{t('broadcast.qualifyingDay')}</span>}
          </div>
        )}
        <div className="broadcast-header-spacer"></div>
      </header>

      <div className="broadcast-main">
        {(broadcastSettings.showLevel || broadcastSettings.showPlayers || broadcastSettings.showInterval) && (
          <aside className="broadcast-sidebar">
            {broadcastSettings.showLevel && (
              <div className="sidebar-section">
                <div className="sidebar-label" style={{ fontSize: `${13 * fontScale}px` }}>{t('broadcast.level')} {displayBlindLevel}</div>
              </div>
            )}

            {broadcastSettings.showPlayers && (
              <div className="sidebar-section">
                <div className="sidebar-label" style={{ fontSize: `${13 * fontScale}px` }}>{t('broadcast.players').toUpperCase()}</div>
                <div className="sidebar-value" style={{ fontSize: `${32 * fontScale}px` }}>{displayActivePlayers} / {displayTotalPlayers}</div>
              </div>
            )}

            {broadcastSettings.showPlayers && totalEntries > 0 && (
              <div className="sidebar-section">
                <div className="sidebar-label" style={{ fontSize: `${13 * fontScale}px` }}>{t('broadcast.entries').toUpperCase()}</div>
                <div className="sidebar-value" style={{ fontSize: `${32 * fontScale}px` }}>{totalEntries}</div>
              </div>
            )}

            {/* Break countdown from enriched endpoint for day-based */}
            {isDayBased && timerState?.next_break && (
              <div className="sidebar-section">
                <div className="sidebar-label" style={{ fontSize: `${13 * fontScale}px` }}>INTERVALO EM</div>
                <div className="sidebar-value" style={{ fontSize: `${32 * fontScale}px` }}>
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
              <div className="broadcast-break-label" style={{ fontSize: `${36 * fontScale}px` }}>INTERVALO</div>
              {broadcastSettings.showTimer && (
                <div className="timer-display break-timer-display" style={{ fontSize: `${160 * fontScale}px` }}>
                  {formatTimerTime(displayTimeRemaining)}
                </div>
              )}
            </>
          ) : (
            <>
              {broadcastSettings.showTimer && (
                <div className="timer-display" style={{ fontSize: `${160 * fontScale}px` }}>
                  {formatTimerTime(displayTimeRemaining)}
                </div>
              )}

              {broadcastSettings.showBlinds && (
                <div className="blinds-section">
                  <div className="blinds-label" style={{ fontSize: `${16 * fontScale}px` }}>{t('broadcast.blinds')}</div>
                  <div className="blinds-value" style={{ fontSize: `${80 * fontScale}px` }}>{displaySmallBlind}/{displayBigBlind}</div>
                </div>
              )}

              {broadcastSettings.showAnte && (
                <div className="ante-section">
                  <div className="ante-label" style={{ fontSize: `${14 * fontScale}px` }}>{t('broadcast.ante')}</div>
                  <div className="ante-value" style={{ fontSize: `${36 * fontScale}px` }}>{displayAnte}</div>
                </div>
              )}

              {broadcastSettings.showNextBlind && (
                <div className="next-blind-section">
                  <div className="next-blind-label" style={{ fontSize: `${14 * fontScale}px` }}>{t('broadcast.nextBlinds')}</div>
                  <div className="next-blind-value" style={{ fontSize: `${24 * fontScale}px` }}>
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

        {/* Right Sidebar - Prizes */}
        {broadcastSettings.showPrizes && prizeAllocations.length > 0 && (
          <aside className="broadcast-prizes-sidebar">
            <div className="prizes-header" style={{ fontSize: `${14 * fontScale}px` }}>
              {t('broadcast.prizePool').toUpperCase()}
            </div>
            <div className="prizes-list">
              {prizeAllocations.slice(0, 10).map((prize) => (
                <div key={prize.id} className="prize-row">
                  <span className="prize-position" style={{ fontSize: `${14 * fontScale}px` }}>{prize.position}º</span>
                  <span className="prize-value" style={{ fontSize: `${18 * fontScale}px` }}>
                    R$ {parseFloat(prize.prize_amount).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                  </span>
                </div>
              ))}
            </div>
          </aside>
        )}
      </div>

      {/* Prizepool - Bottom Right */}
      {broadcastSettings.showPrizepool && (
        <div className="broadcast-prizepool-corner">
          <div className="prize-label" style={{ fontSize: `${13 * fontScale}px` }}>PRIZEPOOL</div>
          <div className="prize-amount" style={{ fontSize: `${32 * fontScale}px` }}>
            $ {tournamentDay?.prize_pool || tournament.prize_pool ? (tournamentDay?.prize_pool || tournament.prize_pool).toFixed(2) : '0,00'}
          </div>
        </div>
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
