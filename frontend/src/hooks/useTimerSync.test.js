import { renderHook, waitFor } from '@testing-library/react';
import { useTimerSync, formatTime, formatTimeHuman } from './useTimerSync';
import api from '../config/api';

// Mock the API module
jest.mock('../config/api');

describe('useTimerSync', () => {
  const mockDayId = 'test-day-id-123';
  const mockTimerState = {
    current_level: 2,
    elapsed_time: 720,
    is_paused: false,
    timer_started_at: '2024-01-15T10:30:00Z',
    current_blind: {
      level: 2,
      small_blind: 50,
      big_blind: 100,
      ante: 0,
      duration: 10,
      is_break: false
    },
    next_blind: {
      level: 3,
      small_blind: 100,
      big_blind: 200,
      ante: 25,
      duration: 10,
      is_break: false
    },
    time_remaining_current_level: 480,
    next_break: {
      level: 5,
      duration: 900,
      time_until_break: 1200
    },
    active_players: 45,
    total_entries: 50
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  describe('Hook Behavior', () => {
    test('should fetch timer status on mount', async () => {
      api.get.mockResolvedValue({ data: mockTimerState });

      const { result } = renderHook(() => useTimerSync(mockDayId));

      expect(result.current.isLoading).toBe(true);

      await waitFor(() => {
        expect(result.current.timerState).toEqual(mockTimerState);
      });

      expect(api.get).toHaveBeenCalledWith(
        `/tournament-days/${mockDayId}/timer/status-enriched`
      );
    });

    test('should handle API errors gracefully', async () => {
      const errorMessage = 'Network error';
      api.get.mockRejectedValue(new Error(errorMessage));

      const { result } = renderHook(() => useTimerSync(mockDayId));

      await waitFor(() => {
        expect(result.current.error).toBeTruthy();
      });

      expect(result.current.timerState).toBeNull();
    });

    test('should not fetch if dayId is not provided', () => {
      renderHook(() => useTimerSync(null));

      expect(api.get).not.toHaveBeenCalled();
    });

    test('should poll server every 5 seconds', async () => {
      api.get.mockResolvedValue({ data: mockTimerState });

      renderHook(() => useTimerSync(mockDayId));

      // Initial fetch
      expect(api.get).toHaveBeenCalledTimes(1);

      // Advance time by 5 seconds
      jest.advanceTimersByTime(5000);

      await waitFor(() => {
        expect(api.get).toHaveBeenCalledTimes(2);
      });

      // Advance another 5 seconds
      jest.advanceTimersByTime(5000);

      await waitFor(() => {
        expect(api.get).toHaveBeenCalledTimes(3);
      });
    });

    test('should apply local tick countdown', async () => {
      api.get.mockResolvedValue({ data: mockTimerState });

      const { result } = renderHook(() => useTimerSync(mockDayId));

      await waitFor(() => {
        expect(result.current.timerState).toBeTruthy();
      });

      const initialTimeRemaining = result.current.timerState.time_remaining_current_level;

      // Advance time by 3 seconds (3 ticks)
      jest.advanceTimersByTime(3000);

      await waitFor(() => {
        const newTimeRemaining = result.current.timerState.time_remaining_current_level;
        expect(newTimeRemaining).toBe(initialTimeRemaining - 3);
      });
    });

    test('should reset local tick on server sync', async () => {
      api.get.mockResolvedValue({ data: mockTimerState });

      const { result } = renderHook(() => useTimerSync(mockDayId));

      await waitFor(() => {
        expect(result.current.timerState).toBeTruthy();
      });

      // Advance 3 seconds (local tick)
      jest.advanceTimersByTime(3000);

      // Advance to trigger server sync (5 seconds total)
      jest.advanceTimersByTime(2000);

      await waitFor(() => {
        // After sync, time_remaining should be reset to server value
        expect(result.current.timerState.time_remaining_current_level).toBe(
          mockTimerState.time_remaining_current_level
        );
      });
    });

    test('should not tick when timer is paused', async () => {
      const pausedState = { ...mockTimerState, is_paused: true };
      api.get.mockResolvedValue({ data: pausedState });

      const { result } = renderHook(() => useTimerSync(mockDayId));

      await waitFor(() => {
        expect(result.current.timerState).toBeTruthy();
      });

      const timeRemaining = result.current.timerState.time_remaining_current_level;

      // Advance time by 3 seconds
      jest.advanceTimersByTime(3000);

      // Time should not change because timer is paused
      expect(result.current.timerState.time_remaining_current_level).toBe(timeRemaining);
    });

    test('should never show negative time remaining', async () => {
      const expiredState = {
        ...mockTimerState,
        time_remaining_current_level: 2
      };
      api.get.mockResolvedValue({ data: expiredState });

      const { result } = renderHook(() => useTimerSync(mockDayId));

      await waitFor(() => {
        expect(result.current.timerState).toBeTruthy();
      });

      // Advance time by 5 seconds (more than remaining time)
      jest.advanceTimersByTime(5000);

      await waitFor(() => {
        // Should be 0, not negative
        expect(result.current.timerState.time_remaining_current_level).toBe(0);
      });
    });

    test('should calculate next_break countdown correctly', async () => {
      api.get.mockResolvedValue({ data: mockTimerState });

      const { result } = renderHook(() => useTimerSync(mockDayId));

      await waitFor(() => {
        expect(result.current.timerState?.next_break).toBeTruthy();
      });

      const initialBreakTime = result.current.timerState.next_break.time_until_break;

      // Advance 2 seconds
      jest.advanceTimersByTime(2000);

      await waitFor(() => {
        const newBreakTime = result.current.timerState.next_break.time_until_break;
        expect(newBreakTime).toBe(initialBreakTime - 2);
      });
    });
  });
});

describe('Helper Functions', () => {
  describe('formatTime', () => {
    test('should format seconds to MM:SS', () => {
      expect(formatTime(0)).toBe('00:00');
      expect(formatTime(30)).toBe('00:30');
      expect(formatTime(60)).toBe('01:00');
      expect(formatTime(90)).toBe('01:30');
      expect(formatTime(600)).toBe('10:00');
      expect(formatTime(3661)).toBe('61:01');
    });

    test('should pad single digits with zero', () => {
      expect(formatTime(5)).toBe('00:05');
      expect(formatTime(65)).toBe('01:05');
    });
  });

  describe('formatTimeHuman', () => {
    test('should format seconds only', () => {
      expect(formatTimeHuman(0)).toBe('0s');
      expect(formatTimeHuman(30)).toBe('30s');
      expect(formatTimeHuman(59)).toBe('59s');
    });

    test('should format minutes and seconds', () => {
      expect(formatTimeHuman(60)).toBe('1m 0s');
      expect(formatTimeHuman(90)).toBe('1m 30s');
      expect(formatTimeHuman(3599)).toBe('59m 59s');
    });

    test('should format hours and minutes (omit seconds)', () => {
      expect(formatTimeHuman(3600)).toBe('1h 0m');
      expect(formatTimeHuman(3660)).toBe('1h 1m');
      expect(formatTimeHuman(7200)).toBe('2h 0m');
      expect(formatTimeHuman(7380)).toBe('2h 3m');
    });
  });
});
