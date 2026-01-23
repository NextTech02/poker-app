import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import api from '../config/api';
import nextHubLogo from '../assets/next-hub-logo.png';
import './TournamentBroadcast.css';

// Generate blinds structure from tournament day configuration
const generateBlindsFromDayConfig = (dayConfig, numLevels = 20) => {
  const blinds = [];
  let smallBlind = dayConfig.initial_small_blind || 25;
  let bigBlind = dayConfig.initial_big_blind || 50;
  const duration = dayConfig.blind_duration || 15;
  const increaseType = dayConfig.blind_increase_type || 'double';
  const bbAnteStartLevel = dayConfig.bb_ante_start_level || 3;

  for (let level = 1; level <= numLevels; level++) {
    // Calculate ante (BB ante starts at specified level)
    const ante = level >= bbAnteStartLevel ? bigBlind : 0;

    blinds.push({
      level,
      small_blind: smallBlind,
      big_blind: bigBlind,
      ante,
      duration
    });

    // Increase blinds for next level based on increase type
    if (increaseType === 'double' || increaseType === '2x') {
      smallBlind *= 2;
      bigBlind *= 2;
    } else if (increaseType === 'triple' || increaseType === '3x') {
      smallBlind *= 3;
      bigBlind *= 3;
    } else if (increaseType === '1.5x') {
      smallBlind = Math.round(smallBlind * 1.5);
      bigBlind = Math.round(bigBlind * 1.5);
    }
  }

  return blinds;
};

const TournamentBroadcast = () => {
  const { id } = useParams();
  const [tournament, setTournament] = useState(null);
  const [tournamentDay, setTournamentDay] = useState(null);
  const [players, setPlayers] = useState([]);
  const [blinds, setBlinds] = useState([]); // Blinds from database or generated
  const [blindLevel, setBlindLevel] = useState(1);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isOnBreak, setIsOnBreak] = useState(false);
  const [breakTimeRemaining, setBreakTimeRemaining] = useState(0);
  const [totalPlayTime, setTotalPlayTime] = useState(0); // Seconds of actual play (excluding breaks)
  const [isDayBased, setIsDayBased] = useState(false);
  const [prizeAllocations, setPrizeAllocations] = useState([]);

  // Fetch tournament data (initial load only)
  const fetchTournamentData = async (initializeTimer = false) => {
    try {
      // Try to fetch as tournament day first
      let dayData = null;
      let tournamentData = null;
      let playersData = null;
      let blindsData = null;

      try {
        const dayRes = await api.get(`/tournament-days/${id}`);
        dayData = dayRes.data;
        setIsDayBased(true);
        setTournamentDay(dayData);

        // Get tournament data for the day
        const tournamentRes = await api.get(`/tournaments/${dayData.tournament_id}`);
        tournamentData = tournamentRes.data;

        // Get players for this specific day
        const playersRes = await api.get(`/tournament-players/day/${id}`);
        playersData = playersRes.data;

        // Get blinds for the tournament day first, fallback to tournament blinds, then generate
        try {
          // First try to get blinds specific to this tournament day
          const dayBlindsRes = await api.get(`/tournament-days/${id}/blinds`);
          blindsData = dayBlindsRes.data;

          // If no day-specific blinds, try tournament-level blinds
          if (!blindsData || blindsData.length === 0) {
            const tournamentBlindsRes = await api.get(`/tournaments/${dayData.tournament_id}/blinds`);
            blindsData = tournamentBlindsRes.data;
          }

          // If still no blinds, generate from day config
          if (!blindsData || blindsData.length === 0) {
            blindsData = generateBlindsFromDayConfig(dayData);
          }
        } catch {
          // If no blinds exist, generate them from day config
          blindsData = generateBlindsFromDayConfig(dayData);
        }
      } catch (dayError) {
        // If it fails, try as tournament (backward compatibility)
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

      console.log('Tournament data:', tournamentData);
      console.log('Day data:', dayData);
      console.log('Players data:', playersData);
      console.log('Blinds data:', blindsData);

      // Fetch prize allocations for the tournament
      try {
        const tournamentIdForPrizes = dayData ? dayData.tournament_id : id;
        const prizesRes = await api.get(`/tournaments/${tournamentIdForPrizes}/prizes`);
        setPrizeAllocations(prizesRes.data || []);
      } catch (prizeError) {
        console.log('No prize allocations found:', prizeError);
        setPrizeAllocations([]);
      }

      setTournament(tournamentData);
      setPlayers(playersData);
      setBlinds(blindsData.sort((a, b) => a.level - b.level));

      // Only initialize blind level and timer on first load
      const dataToCheck = dayData || tournamentData;
      if (initializeTimer && dataToCheck.status === 'active') {
        // Use start_time if available, otherwise fall back to updated_at
        const startTime = new Date(dataToCheck.start_time || dataToCheck.updated_at || dataToCheck.created_at);
        const now = new Date();
        const elapsedSeconds = Math.floor((now - startTime) / 1000);

        // Calculate current level based on blinds with variable durations
        const sortedBlinds = blindsData.sort((a, b) => a.level - b.level);
        const { level: currentLevel, remainingSeconds } = calculateCurrentLevel(elapsedSeconds, sortedBlinds);

        setBlindLevel(currentLevel);
        setTimeRemaining(remainingSeconds);

        // Calculate total play time (for break calculation)
        setTotalPlayTime(elapsedSeconds);
      } else if (initializeTimer) {
        // If tournament is pending, start at level 1 with full time
        const sortedBlinds = blindsData.sort((a, b) => a.level - b.level);
        const firstBlind = sortedBlinds[0];
        setBlindLevel(1);
        setTimeRemaining((firstBlind?.duration || 15) * 60);
      }

      setLoading(false);
    } catch (err) {
      console.error('Error fetching tournament data:', err);
      setError('Erro ao carregar dados do torneio');
      setLoading(false);
    }
  };

  // Fetch only player updates (for polling)
  const fetchPlayersOnly = async () => {
    try {
      let playersRes;
      if (isDayBased) {
        playersRes = await api.get(`/tournament-players/day/${id}`);
      } else {
        playersRes = await api.get(`/tournament-players/tournament/${id}`);
      }
      setPlayers(playersRes.data);
    } catch (err) {
      console.error('Error fetching players:', err);
    }
  };

  // Calculate current blind level based on elapsed time and variable durations
  const calculateCurrentLevel = (elapsedSeconds, blindsArray) => {
    if (!blindsArray || blindsArray.length === 0) {
      return { level: 1, remainingSeconds: 0 };
    }

    let accumulatedTime = 0;

    for (let i = 0; i < blindsArray.length; i++) {
      const blind = blindsArray[i];
      const blindDurationSeconds = blind.duration * 60;

      if (elapsedSeconds < accumulatedTime + blindDurationSeconds) {
        // We're in this level
        const elapsedInLevel = elapsedSeconds - accumulatedTime;
        const remainingSeconds = blindDurationSeconds - elapsedInLevel;
        return { level: blind.level, remainingSeconds };
      }

      accumulatedTime += blindDurationSeconds;
    }

    // If elapsed time exceeds all configured blinds, stay at last level
    const lastBlind = blindsArray[blindsArray.length - 1];
    return { level: lastBlind.level, remainingSeconds: 0 };
  };

  // Get blind values from database for the specified level
  const getBlindValues = (level) => {
    if (!blinds || blinds.length === 0) {
      return { smallBlind: 0, bigBlind: 0, ante: 0, duration: 15 };
    }

    // Find the blind structure for this level
    const blind = blinds.find(b => b.level === level);

    if (blind) {
      return {
        smallBlind: blind.small_blind,
        bigBlind: blind.big_blind,
        ante: blind.ante || 0,
        duration: blind.duration || 15
      };
    }

    // If level not found, return the last configured blind
    const lastBlind = blinds[blinds.length - 1];
    return {
      smallBlind: lastBlind?.small_blind || 0,
      bigBlind: lastBlind?.big_blind || 0,
      ante: lastBlind?.ante || 0,
      duration: lastBlind?.duration || 15
    };
  };

  // Calculate next blind values
  const getNextBlindValues = (level) => {
    return getBlindValues(level + 1);
  };

  // Setup initial load and polling for player updates
  useEffect(() => {
    // Initial load with timer initialization
    fetchTournamentData(true);

    // Poll every 3 seconds for player updates (runs even in background)
    const pollingInterval = setInterval(() => {
      fetchPlayersOnly();
    }, 3000);

    return () => {
      clearInterval(pollingInterval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Timer countdown with break management and Page Visibility API
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    // Check status from tournamentDay if in day-based mode, otherwise from tournament
    const activeStatus = tournamentDay?.status || tournament?.status;
    if (activeStatus !== 'active') return;

    let isPageVisible = !document.hidden;

    // Handle page visibility changes
    const handleVisibilityChange = () => {
      isPageVisible = !document.hidden;
      if (isPageVisible) {
        // Page became visible, resync timer
        console.log('Page became visible, resyncing...');
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    const timer = setInterval(() => {
      // Only update timer when page is visible
      if (!isPageVisible) return;

      if (isOnBreak) {
        // Break countdown - blind timer is paused
        setBreakTimeRemaining((prev) => {
          if (prev <= 1) {
            // Break is over, resume tournament
            setIsOnBreak(false);
            return 0;
          }
          return prev - 1;
        });
      } else {
        // Normal level countdown - only runs when NOT on break
        setTimeRemaining((prev) => {
          if (prev <= 1) {
            // Level completed, move to next level
            setBlindLevel((currentLevel) => {
              const nextLevel = currentLevel + 1;
              // Get duration for next level from blinds
              const nextBlindData = getBlindValues(nextLevel);
              setTimeRemaining(nextBlindData.duration * 60);
              return nextLevel;
            });
            return 0; // Temporary value, will be set by setBlindLevel callback
          }
          return prev - 1;
        });

        // Update total play time
        setTotalPlayTime((prev) => {
          const newPlayTime = prev + 1;

          // Check if it's time for a break (use tournamentDay values if available)
          const dataSource = tournamentDay || tournament;
          const breakInterval = (dataSource?.break_interval || 60) * 60; // Convert to seconds
          if (newPlayTime > 0 && newPlayTime % breakInterval === 0) {
            // Time for a break!
            setIsOnBreak(true);
            setBreakTimeRemaining((dataSource?.break_duration || 10) * 60);
          }

          return newPlayTime;
        });
      }
    }, 1000);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [tournament, tournamentDay, isOnBreak, totalPlayTime]);

  // Format time remaining
  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  // Format time for interval display
  const formatInterval = (seconds) => {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  // Calculate time until next break
  const getTimeUntilBreak = () => {
    const dataSource = tournamentDay || tournament;
    if (!dataSource) return 0;
    const breakInterval = (dataSource.break_interval || 60) * 60; // in seconds
    const timeIntoCurrentCycle = totalPlayTime % breakInterval;
    return breakInterval - timeIntoCurrentCycle;
  };

  if (loading) {
    return (
      <div className="broadcast-container">
        <div className="broadcast-loading">Carregando...</div>
      </div>
    );
  }

  if (error || !tournament) {
    return (
      <div className="broadcast-container">
        <div className="broadcast-error">{error || 'Torneio não encontrado'}</div>
      </div>
    );
  }

  // Get broadcast settings from tournament (defined early for use in completed screen too)
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

  // Calculate font scale multiplier
  const fontScale = broadcastSettings.fontSize / 100;

  // Build custom background style
  const containerStyle = {};
  if (broadcastSettings.bgImageUrl) {
    containerStyle.backgroundImage = `url(${broadcastSettings.bgImageUrl})`;
    containerStyle.backgroundSize = 'cover';
    containerStyle.backgroundPosition = 'center';
    containerStyle.backgroundRepeat = 'no-repeat';
  } else if (broadcastSettings.bgColor && broadcastSettings.bgColor !== '#0a0e13') {
    containerStyle.background = broadcastSettings.bgColor;
  }

  // Get display name
  const displayName = broadcastSettings.displayName ||
    (tournamentDay ? `${tournament.name} - ${tournamentDay.day_name}` : tournament.name);

  // Check if tournament day is completed
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
            <div className="broadcast-title">
              <h1>{displayName}</h1>
            </div>
          )}
          <div className="broadcast-header-spacer"></div>
        </header>

        <div className="broadcast-main">
          <div className="broadcast-completed">
            <div className="completed-icon">&#127942;</div>
            <h2>TORNEIO FINALIZADO</h2>
            <p>Este dia do torneio foi encerrado.</p>
            <div className="completed-stats">
              <div className="stat-item">
                <span className="stat-label">Total de Jogadores</span>
                <span className="stat-value">{players.length}</span>
              </div>
            </div>
          </div>
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
      </div>
    );
  }

  const { smallBlind, bigBlind, ante } = getBlindValues(blindLevel);
  const nextBlinds = getNextBlindValues(blindLevel);
  const activePlayers = players.filter(p => p.status !== 'eliminated').length;

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
          </div>
        )}
        <div className="broadcast-header-spacer"></div>
      </header>

      <div className="broadcast-main">
        {(broadcastSettings.showLevel || broadcastSettings.showPlayers || broadcastSettings.showInterval) && (
          <aside className="broadcast-sidebar">
            {broadcastSettings.showLevel && (
              <div className="sidebar-section">
                <div className="sidebar-label" style={{ fontSize: `${13 * fontScale}px` }}>Nível {blindLevel}</div>
              </div>
            )}

            {broadcastSettings.showPlayers && (
              <div className="sidebar-section">
                <div className="sidebar-label" style={{ fontSize: `${13 * fontScale}px` }}>JOGADORES</div>
                <div className="sidebar-value" style={{ fontSize: `${32 * fontScale}px` }}>{activePlayers} DE {players.length}</div>
              </div>
            )}

            {broadcastSettings.showInterval && (
              <div className="sidebar-section">
                <div className="sidebar-label" style={{ fontSize: `${13 * fontScale}px` }}>INTERVALO EM</div>
                <div className="sidebar-value" style={{ fontSize: `${32 * fontScale}px` }}>{formatInterval(getTimeUntilBreak())}</div>
              </div>
            )}
          </aside>
        )}

        <main className="broadcast-center">
          {broadcastSettings.showTimer && (
            <div className="timer-display" style={{ fontSize: `${160 * fontScale}px` }}>
              {formatTime(timeRemaining)}
            </div>
          )}

          {broadcastSettings.showBlinds && (
            <div className="blinds-section">
              <div className="blinds-label" style={{ fontSize: `${16 * fontScale}px` }}>Small-Blind/Big-Blind</div>
              <div className="blinds-value" style={{ fontSize: `${80 * fontScale}px` }}>{smallBlind}/{bigBlind}</div>
            </div>
          )}

          {broadcastSettings.showAnte && (
            <div className="ante-section">
              <div className="ante-label" style={{ fontSize: `${14 * fontScale}px` }}>BB-Ante</div>
              <div className="ante-value" style={{ fontSize: `${36 * fontScale}px` }}>{ante}</div>
            </div>
          )}

          {broadcastSettings.showNextBlind && (
            <div className="next-blind-section">
              <div className="next-blind-label" style={{ fontSize: `${14 * fontScale}px` }}>Próximo Blind</div>
              <div className="next-blind-value" style={{ fontSize: `${24 * fontScale}px` }}>
                {nextBlinds.smallBlind}/{nextBlinds.bigBlind} ( {nextBlinds.ante} )
              </div>
            </div>
          )}
        </main>

        {/* Right Sidebar - Prizes */}
        {broadcastSettings.showPrizes && prizeAllocations.length > 0 && (
          <aside className="broadcast-prizes-sidebar">
            <div className="prizes-header" style={{ fontSize: `${14 * fontScale}px` }}>
              PREMIAÇÃO
            </div>
            <div className="prizes-list">
              {prizeAllocations.slice(0, 10).map((prize) => (
                <div key={prize.id} className="prize-row">
                  <span className="prize-position" style={{ fontSize: `${14 * fontScale}px` }}>
                    {prize.position}º
                  </span>
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

      {/* Break Overlay */}
      {isOnBreak && (
        <div className="break-overlay">
          <div className="break-content">
            <div className="break-icon"></div>
            <h1 className="break-title">INTERVALO</h1>
            <div className="break-timer">
              {formatTime(breakTimeRemaining)}
            </div>
            <p className="break-subtitle">O torneio retornará em breve</p>
          </div>
        </div>
      )}
    </div>
  );
};

export default TournamentBroadcast;
