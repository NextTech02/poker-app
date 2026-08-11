import { renderHook, waitFor, act } from '@testing-library/react';
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

    // O polling e um setTimeout RECURSIVO: a proxima chamada so e agendada
    // depois que a anterior resolve. Por isso nao basta adiantar o relogio --
    // e preciso liberar as microtasks entre os avancos, senao o timer dispara
    // antes de existir. Era o que deixava estes testes vermelhos.
    // Libera as microtasks pendentes (o fetch resolve e SO ENTAO o proximo
    // setTimeout e agendado).
    const liberar = async () => {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    const avancar = async (ms) => {
      await liberar();                                    // agenda o proximo ciclo
      await act(async () => { jest.advanceTimersByTime(ms); });
      await liberar();                                    // deixa a nova chamada resolver
    };

    test('consulta o servidor a cada ~3s, sem empilhar chamadas', async () => {
      api.get.mockResolvedValue({ data: mockTimerState });

      renderHook(() => useTimerSync(mockDayId));

      await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));

      await avancar(3000);
      await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));

      await avancar(3000);
      await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
    });

    test('desconta o tempo localmente entre as consultas', async () => {
      api.get.mockResolvedValue({ data: mockTimerState });

      const { result } = renderHook(() => useTimerSync(mockDayId));
      await waitFor(() => expect(result.current.timerState).toBeTruthy());

      const inicial = result.current.timerState.time_remaining_current_level;

      // 2s de relogio de parede, sem deixar o polling substituir o estado:
      // o desconto tem que vir da ancora local.
      await avancar(2000);

      const depois = result.current.timerState.time_remaining_current_level;
      expect(depois).toBeLessThanOrEqual(inicial);
      expect(inicial - depois).toBeLessThanOrEqual(3);
    });

    test('reancora no valor do servidor quando ele responde', async () => {
      api.get.mockResolvedValue({ data: mockTimerState });

      const { result } = renderHook(() => useTimerSync(mockDayId));
      await waitFor(() => expect(result.current.timerState).toBeTruthy());

      // servidor passa a responder um nivel adiante, com o tempo cheio
      api.get.mockResolvedValue({
        data: { ...mockTimerState, current_level: 3, time_remaining_current_level: 600 },
      });

      await avancar(3000);

      await waitFor(() => {
        expect(result.current.timerState.current_level).toBe(3);
        // volta para perto de 600: o desconto local nao se acumula sobre o novo valor
        expect(result.current.timerState.time_remaining_current_level).toBeGreaterThan(595);
      });
    });

    test('nao desconta tempo enquanto o relogio esta pausado', async () => {
      api.get.mockResolvedValue({
        data: { ...mockTimerState, is_paused: true },
      });

      const { result } = renderHook(() => useTimerSync(mockDayId));
      await waitFor(() => expect(result.current.timerState).toBeTruthy());

      const inicial = result.current.timerState.time_remaining_current_level;
      await avancar(4000);

      expect(result.current.timerState.time_remaining_current_level).toBe(inicial);
    });

    test('nunca exibe tempo negativo', async () => {
      // 1 segundo restante e o relogio avanca muito alem disso
      api.get.mockResolvedValue({
        data: { ...mockTimerState, time_remaining_current_level: 1 },
      });

      const { result } = renderHook(() => useTimerSync(mockDayId));
      await waitFor(() => expect(result.current.timerState).toBeTruthy());

      await avancar(10000);

      expect(result.current.timerState.time_remaining_current_level).toBeGreaterThanOrEqual(0);
    });

    test('conta regressivamente ate o proximo intervalo', async () => {
      api.get.mockResolvedValue({ data: mockTimerState });

      const { result } = renderHook(() => useTimerSync(mockDayId));
      await waitFor(() => expect(result.current.timerState?.next_break).toBeTruthy());

      const inicial = result.current.timerState.next_break.time_until_break;
      expect(inicial).toBeLessThanOrEqual(mockTimerState.next_break.time_until_break);

      await avancar(2000);

      const depois = result.current.timerState.next_break.time_until_break;
      expect(depois).toBeLessThanOrEqual(inicial);
      expect(depois).toBeGreaterThanOrEqual(0);
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
