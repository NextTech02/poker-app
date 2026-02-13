import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import api from '../config/api';

/**
 * Shared hook for timer synchronization between Control Panel and Broadcast Screen.
 *
 * This is the SINGLE SOURCE OF TRUTH for timer display on both screens.
 * Both screens poll the same enriched endpoint and display the same values.
 * The backend auto-advances levels when elapsed time exceeds level duration.
 *
 * @param {string} dayId - Tournament day ID
 * @returns {Object} { timerState, refetch, error, isLoading }
 */
export const useTimerSync = (dayId) => {
  const [timerState, setTimerState] = useState(null);
  const [localTick, setLocalTick] = useState(0);
  const [error, setError] = useState(null);
  const lastLevelRef = useRef(null);

  // Fetch enriched status from server
  const fetchStatus = useCallback(async () => {
    if (!dayId) return null;

    try {
      const res = await api.get(`/tournament-days/${dayId}/timer/status-enriched`);
      const data = res.data;
      setTimerState(data);
      setLocalTick(0);
      setError(null);

      // Track level changes for UI effects
      if (lastLevelRef.current !== null && data.current_level !== lastLevelRef.current) {
        // Level changed - could trigger sound/animation
      }
      lastLevelRef.current = data.current_level;

      return data;
    } catch (err) {
      console.error('Error fetching enriched timer status:', err);
      setError(err.message);
      return null;
    }
  }, [dayId]);

  // Poll server every 3 seconds for tighter sync
  useEffect(() => {
    if (!dayId) return;

    fetchStatus();

    const interval = setInterval(fetchStatus, 3000);
    return () => clearInterval(interval);
  }, [fetchStatus, dayId]);

  // Local tick every second for smooth countdown
  useEffect(() => {
    if (!timerState || timerState.is_paused) return;

    const ticker = setInterval(() => {
      setLocalTick(prev => {
        const next = prev + 1;
        // When local countdown hits 0, force a server sync to get new level
        const remaining = timerState.time_remaining_current_level - next;
        if (remaining <= 0) {
          fetchStatus();
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
