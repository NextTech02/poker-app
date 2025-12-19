import React, { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import api from '../config/api';
import nextHubLogo from '../assets/next-hub-logo.png';
import './TournamentBroadcast.css';

const TournamentBroadcast = () => {
  const { id } = useParams();
  const [tournament, setTournament] = useState(null);
  const [players, setPlayers] = useState([]);
  const [blinds, setBlinds] = useState([]); // Blinds from database
  const [blindLevel, setBlindLevel] = useState(1);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [isOnBreak, setIsOnBreak] = useState(false);
  const [breakTimeRemaining, setBreakTimeRemaining] = useState(0);
  const [totalPlayTime, setTotalPlayTime] = useState(0); // Seconds of actual play (excluding breaks)

  // Fetch tournament data (initial load only)
  const fetchTournamentData = async (initializeTimer = false) => {
    try {
      const [tournamentRes, playersRes, blindsRes] = await Promise.all([
        api.get(`/tournaments/${id}`),
        api.get(`/tournament-players/tournament/${id}`),
        api.get(`/tournaments/${id}/blinds`)
      ]);

      console.log('Tournament data:', tournamentRes.data);
      console.log('Players data:', playersRes.data);
      console.log('Blinds data:', blindsRes.data);

      setTournament(tournamentRes.data);
      setPlayers(playersRes.data);
      setBlinds(blindsRes.data.sort((a, b) => a.level - b.level));

      // Only initialize blind level and timer on first load
      if (initializeTimer && tournamentRes.data.status === 'active') {
        // Use start_time if available, otherwise fall back to updated_at
        const startTime = new Date(tournamentRes.data.start_time || tournamentRes.data.updated_at || tournamentRes.data.created_at);
        const now = new Date();
        const elapsedSeconds = Math.floor((now - startTime) / 1000);

        // Calculate current level based on blinds with variable durations
        const sortedBlinds = blindsRes.data.sort((a, b) => a.level - b.level);
        const { level: currentLevel, remainingSeconds } = calculateCurrentLevel(elapsedSeconds, sortedBlinds);

        setBlindLevel(currentLevel);
        setTimeRemaining(remainingSeconds);

        // Calculate total play time (for break calculation)
        setTotalPlayTime(elapsedSeconds);
      } else if (initializeTimer) {
        // If tournament is pending, start at level 1 with full time
        const sortedBlinds = blindsRes.data.sort((a, b) => a.level - b.level);
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
      const playersRes = await api.get(`/tournament-players/tournament/${id}`);
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
    if (tournament?.status !== 'active') return;

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

          // Check if it's time for a break
          const breakInterval = (tournament.break_interval || 60) * 60; // Convert to seconds
          if (newPlayTime > 0 && newPlayTime % breakInterval === 0) {
            // Time for a break!
            setIsOnBreak(true);
            setBreakTimeRemaining((tournament.break_duration || 10) * 60);
          }

          return newPlayTime;
        });
      }
    }, 1000);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [tournament, isOnBreak, totalPlayTime]);

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
    if (!tournament) return 0;
    const breakInterval = (tournament.break_interval || 60) * 60; // in seconds
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

  const { smallBlind, bigBlind, ante } = getBlindValues(blindLevel);
  const nextBlinds = getNextBlindValues(blindLevel);
  const activePlayers = players.filter(p => p.status !== 'eliminated').length;

  return (
    <div className="broadcast-container">
      <header className="broadcast-header">
        <div className="broadcast-logo">
          <img src={nextHubLogo} alt="Next Hub" className="broadcast-logo-img" />
        </div>
        <div className="broadcast-title">
          <h1>{tournament.name}</h1>
        </div>
        <div className="broadcast-prize">
          <div className="prize-label">PRIZEPOOL</div>
          <div className="prize-amount">
            $ {tournament.prize_pool ? tournament.prize_pool.toFixed(2) : '0,00'}
          </div>
        </div>
      </header>

      <div className="broadcast-main">
        <aside className="broadcast-sidebar">
          <div className="sidebar-section">
            <div className="sidebar-label">Nível {blindLevel}</div>
          </div>

          <div className="sidebar-section">
            <div className="sidebar-label">JOGADORES</div>
            <div className="sidebar-value">{activePlayers} DE {players.length}</div>
          </div>

          <div className="sidebar-section">
            <div className="sidebar-label">INTERVALO EM</div>
            <div className="sidebar-value">{formatInterval(getTimeUntilBreak())}</div>
          </div>
        </aside>

        <main className="broadcast-center">
          <div className="timer-display">
            {formatTime(timeRemaining)}
          </div>

          <div className="blinds-section">
            <div className="blinds-label">Small-Blind/Big-Blind</div>
            <div className="blinds-value">{smallBlind}/{bigBlind}</div>
          </div>

          <div className="ante-section">
            <div className="ante-label">BB-Ante</div>
            <div className="ante-value">{ante}</div>
          </div>

          <div className="next-blind-section">
            <div className="next-blind-label">Próximo Blind</div>
            <div className="next-blind-value">
              {nextBlinds.smallBlind}/{nextBlinds.bigBlind} ( {nextBlinds.ante} )
            </div>
          </div>
        </main>
      </div>

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
