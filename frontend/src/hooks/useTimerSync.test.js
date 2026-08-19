import { renderHook, waitFor, act } from '@testing-library/react';
import { useTimerSync, formatTime, formatTimeHuman } from './useTimerSync';
import api from '../config/api';
// Modulo REAL de conectividade: markOffline/markOnline sao exatamente o que o
// wrapper axios chama quando QUALQUER requisicao falha ou passa. Usar o modulo
// de verdade e o que torna o teste fiel ao cenario "outra tela derrubou o sinal".
import { markOffline, markOnline } from '../offline/connectivity';

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
    markOnline(); // o sinal global e um singleton: zera entre os testes
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

  // O relogio do telao e o que a mesa inteira olha. Quando a internet cai no
  // meio do torneio ele NAO pode parar sem explicacao: ou anda sozinho, ou
  // avisa. Estes testes cobrem o achado do cliente ("mudar o blind sem
  // internet trava o relogio; quando volta, volta no tempo certo").
  describe('operacao sem internet', () => {
    const liberar = async () => {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    };

    const avancar = async (ms) => {
      await liberar();
      await act(async () => { jest.advanceTimersByTime(ms); });
      await liberar();
    };

    const ESTRUTURA = [
      { level: 2, small_blind: 50, big_blind: 100, ante: 0, duration: 10, is_break: false },
      { level: 3, small_blind: 100, big_blind: 200, ante: 0, duration: 10, is_break: false },
    ];

    const semRede = async (result) => {
      api.get.mockRejectedValue(new Error('sem rede'));
      await avancar(3000);
      await avancar(3000);
      await waitFor(() => expect(result.current.isOffline).toBe(true));
    };

    // O sinal GLOBAL de conectividade e compartilhado por toda a aplicacao: uma
    // requisicao de outra tela pode derruba-lo enquanto /timer responde normal.
    // Se ele sozinho ligasse o modo local, dois teloes passariam a avancar de
    // nivel por conta propria e mostrariam HORAS DIFERENTES na mesma sala.
    test('sinal global de rede caida NAO liga o modo local se /timer responde', async () => {
      api.get.mockResolvedValue({ data: mockTimerState });

      const { result } = renderHook(() => useTimerSync(mockDayId, ESTRUTURA));
      await waitFor(() => expect(result.current.timerState).toBeTruthy());

      // Uma requisicao NAO relacionada falha e marca a rede como offline.
      act(() => { markOffline(); markOffline(); });

      // NA HORA: nem por um instante o aviso pode acender. Um piscar de "modo
      // local" ja e tempo suficiente para o ticker virar o nivel sozinho.
      expect(result.current.isOffline).toBe(false);
      await avancar(3000);
      expect(result.current.isOffline).toBe(false);
    });

    test('com o sinal global caido mas /timer respondendo, o nivel NAO vira sozinho', async () => {
      // O nivel acaba em 2s. Se o relogio entrasse em modo local so pelo sinal
      // global, ele avancaria para o nivel 3 aqui -- e o telao ao lado, cujo
      // sinal global nao caiu, continuaria no 2. E essa divergencia que a mesa
      // ve e discute.
      api.get.mockResolvedValue({
        data: {
          ...mockTimerState,
          time_remaining_current_level: 2,
          current_level_ends_at: Date.now() / 1000 + 2,
        },
      });

      const { result } = renderHook(() => useTimerSync(mockDayId, ESTRUTURA));
      await waitFor(() => expect(result.current.timerState).toBeTruthy());

      act(() => { markOffline(); markOffline(); });
      await avancar(2500); // passa o fim do nivel sem chegar no proximo poll

      expect(result.current.timerState.current_level).toBe(2);
      expect(result.current.isOffline).toBe(false);
    });

    test('sinal global + falha do proprio poll ligam o modo local ja na 1a falha', async () => {
      // O sinal global nao decide sozinho, mas COMPLEMENTA a evidencia local:
      // com ele caido basta uma falha nossa (3s) em vez de duas (6s).
      api.get.mockResolvedValue({ data: mockTimerState });

      const { result } = renderHook(() => useTimerSync(mockDayId, ESTRUTURA));
      await waitFor(() => expect(result.current.timerState).toBeTruthy());

      act(() => { markOffline(); markOffline(); });
      api.get.mockRejectedValue(new Error('sem rede'));
      await avancar(3000); // UMA falha do nosso proprio poll

      await waitFor(() => expect(result.current.isOffline).toBe(true));
    });

    test('sinaliza o modo offline e limpa o aviso quando a rede volta', async () => {
      // Sem esse sinal, "relogio rodando local" fica indistinguivel de
      // "o sistema travou" -- e vira telefonema no meio do evento.
      api.get.mockResolvedValue({ data: mockTimerState });

      const { result } = renderHook(() => useTimerSync(mockDayId));
      await waitFor(() => expect(result.current.timerState).toBeTruthy());
      expect(result.current.isOffline).toBe(false);

      await semRede(result);

      api.get.mockResolvedValue({ data: mockTimerState });
      await avancar(3000);
      await waitFor(() => expect(result.current.isOffline).toBe(false));
    });

    test('ao virar de nivel offline mostra o tempo CHEIO do nivel novo', async () => {
      // O servidor manda tambem o INSTANTE ABSOLUTO em que o nivel acaba.
      // Esse instante e do nivel ANTIGO: se o estado sintetizado o herdar, a
      // ancora le um fim ja vencido e o telao congela em 00:00 no nivel novo.
      api.get.mockResolvedValue({
        data: {
          ...mockTimerState,
          time_remaining_current_level: 2,
          current_level_ends_at: Date.now() / 1000 + 2,
        },
      });

      const { result } = renderHook(() => useTimerSync(mockDayId, ESTRUTURA));
      await waitFor(() => expect(result.current.timerState).toBeTruthy());

      await semRede(result);

      await waitFor(() => expect(result.current.timerState.current_level).toBe(3));
      expect(result.current.timerState.time_remaining_current_level).toBeGreaterThan(500);
    });

    test('o comando manual do operador vira o blind na tela na hora', async () => {
      // Aqui a estrutura nem esta em cache: o proprio estado enriquecido ja
      // traz o proximo blind, e um nivel adiante e o que o operador pediu.
      api.get.mockResolvedValue({ data: mockTimerState });

      const { result } = renderHook(() => useTimerSync(mockDayId));
      await waitFor(() => expect(result.current.timerState).toBeTruthy());

      let aplicou;
      act(() => { aplicou = result.current.applyLocalCommand('next-level'); });

      expect(aplicou).toBe(true);
      expect(result.current.timerState.current_level).toBe(3);
      expect(result.current.timerState.time_remaining_current_level).toBeGreaterThan(590);
    });

    test('o ajuste de tempo tambem vale offline', async () => {
      api.get.mockResolvedValue({ data: mockTimerState });

      const { result } = renderHook(() => useTimerSync(mockDayId));
      await waitFor(() => expect(result.current.timerState).toBeTruthy());
      const antes = result.current.timerState.time_remaining_current_level;

      act(() => { result.current.applyLocalCommand('adjust', { seconds: 300 }); });

      expect(result.current.timerState.time_remaining_current_level)
        .toBeGreaterThanOrEqual(antes + 299);
    });

    test('reiniciar offline volta o nivel para a duracao cheia', async () => {
      api.get.mockResolvedValue({ data: mockTimerState });

      const { result } = renderHook(() => useTimerSync(mockDayId));
      await waitFor(() => expect(result.current.timerState).toBeTruthy());

      act(() => { result.current.applyLocalCommand('reset'); });

      // current_blind.duration = 10 minutos
      expect(result.current.timerState.time_remaining_current_level).toBe(600);
    });

    test('recusa o que nao da para simular, em vez de inventar um blind', async () => {
      // Voltar de nivel sem a estrutura em cache: a tela nao tem como saber os
      // valores do nivel anterior. Devolver false e o que faz o Controle avisar
      // "comando na fila" em vez de mostrar um blind errado para a mesa.
      api.get.mockResolvedValue({ data: mockTimerState });

      const { result } = renderHook(() => useTimerSync(mockDayId));
      await waitFor(() => expect(result.current.timerState).toBeTruthy());

      let aplicou;
      act(() => { aplicou = result.current.applyLocalCommand('prev-level'); });

      expect(aplicou).toBe(false);
      expect(result.current.timerState.current_level).toBe(2);
    });

    test('o poll nao devolve o nivel antigo enquanto o comando esta na fila', async () => {
      // Ao voltar a internet o servidor ainda responde o nivel ANTIGO ate a
      // fila ser reexecutada. Sem a trava, o telao piscaria de volta para o
      // blind anterior por alguns segundos -- na frente da mesa.
      api.get.mockResolvedValue({ data: mockTimerState });

      const { result } = renderHook(() => useTimerSync(mockDayId));
      await waitFor(() => expect(result.current.timerState).toBeTruthy());

      act(() => { result.current.applyLocalCommand('next-level'); });
      expect(result.current.timerState.current_level).toBe(3);

      await avancar(3000);
      expect(result.current.timerState.current_level).toBe(3);

      // o /sync/batch reexecuta o comando: o servidor concorda e a trava cai
      api.get.mockResolvedValue({ data: { ...mockTimerState, current_level: 3 } });
      await avancar(3000);

      // dai em diante o servidor volta a mandar na tela
      api.get.mockResolvedValue({ data: { ...mockTimerState, current_level: 5 } });
      await avancar(3000);
      await waitFor(() => expect(result.current.timerState.current_level).toBe(5));
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
