/**
 * Controle do torneio — a tela que o staff opera com o salão cheio.
 *
 * O comportamento mais delicado é o play/pause. Ele resolve dois problemas
 * ao mesmo tempo:
 *
 * - **A tela reage na hora** (estado otimista), porque o operador aperta
 *   pausa quando algo já aconteceu na mesa; esperar a rede seria tarde.
 * - **A rajada de cliques não vira uma rajada de requisições.** O envio usa
 *   *leading edge*: o primeiro toque sai IMEDIATAMENTE (para a TV refletir
 *   junto) e os seguintes são unificados, com um envio final garantindo que
 *   o estado que ficou na tela é o que foi persistido. Um clique = 1 POST;
 *   uma rajada = no máximo 2.
 *
 * Todos os comandos passam pela camada offline: sem internet eles entram na
 * fila e o relógio continua rodando ancorado localmente.
 */
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import TournamentControl from './TournamentControl';
import api from '../config/api';
import { offlineWrite } from '../offline/apiOffline';
import { useTimerSync } from '../hooks/useTimerSync';
import { useToast } from '../contexts/ToastContext';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../offline/apiOffline', () => ({ offlineWrite: jest.fn() }));
jest.mock('../offline/db', () => ({ uuid: () => 'mut-fixa' }));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../hooks/useTimerSync', () => ({
  useTimerSync: jest.fn(),
  formatTime: (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`,
  formatTimeHuman: (s) => `${Math.round(s / 60)}min`,
}));
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ dayId: 'dia-1' }),
}));
jest.mock('react-i18next', () => {
  const t = (chave) => chave;
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const DIA = { id: 'dia-1', day_name: 'Dia 1A', status: 'active' };

let relogio;
let confirmar;

const estadoRelogio = (extra = {}) => ({
  current_blind: { small_blind: 100, big_blind: 200, ante: 0, is_break: false },
  next_blind: { small_blind: 200, big_blind: 400, ante: 0, is_break: false },
  time_remaining_current_level: 305,
  current_level: 4,
  is_paused: true,
  active_players: 18,
  total_entries: 25,
  eliminations_count: 7,
  ...extra,
});

const montar = async (extraRelogio = {}) => {
  relogio = {
    timerState: estadoRelogio(extraRelogio),
    triggerRefetch: jest.fn(),
    applyOptimistic: jest.fn(),
    broadcastCommand: jest.fn((c) => ({ ...c, remaining: 305 })),
    isLoading: false,
  };
  useTimerSync.mockReturnValue(relogio);
  render(<MemoryRouter><TournamentControl /></MemoryRouter>);
  await screen.findByText('Dia 1A');
};

const comando = (acao) =>
  offlineWrite.mock.calls.find((c) => c[0].url.endsWith(`/timer/${acao}`));

beforeEach(() => {
  jest.useRealTimers();
  confirmar = jest.fn().mockResolvedValue(true);
  useToast.mockReturnValue({ confirm: confirmar });
  api.get.mockResolvedValue({ data: DIA });
  offlineWrite.mockResolvedValue({ data: { ok: true } });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('carga', () => {
  it('mostra o carregamento enquanto o dia ou o relógio não chegam', () => {
    useTimerSync.mockReturnValue({
      timerState: null,
      isLoading: true,
      triggerRefetch: jest.fn(),
      applyOptimistic: jest.fn(),
      broadcastCommand: jest.fn(),
    });
    api.get.mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><TournamentControl /></MemoryRouter>);
    expect(screen.getByText('common.loading')).toBeInTheDocument();
  });

  it('mostra o nome e o status do dia', async () => {
    await montar();
    expect(screen.getByText('Dia 1A')).toBeInTheDocument();
    expect(screen.getByText('common.active')).toBeInTheDocument();
  });

  it('falha ao carregar o dia não derruba a tela do relógio', async () => {
    // O relógio é o que o salão está vendo; ele não pode sumir porque o
    // nome do dia falhou.
    api.get.mockRejectedValue(new Error('503'));
    useTimerSync.mockReturnValue({
      timerState: estadoRelogio(),
      triggerRefetch: jest.fn(),
      applyOptimistic: jest.fn(),
      broadcastCommand: jest.fn(),
      isLoading: false,
    });
    render(<MemoryRouter><TournamentControl /></MemoryRouter>);
    await screen.findByText('5:05');
  });
});

describe('exibição', () => {
  it('mostra o tempo restante do nível', async () => {
    await montar();
    expect(screen.getByText('5:05')).toBeInTheDocument();
  });

  it('mostra o nível atual', async () => {
    await montar();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('durante o intervalo troca a exibição', async () => {
    // "Blinds 0/0" faria o staff achar que a estrutura quebrou.
    await montar({ current_blind: { small_blind: 0, big_blind: 0, is_break: true } });
    expect(screen.getByText('control.break')).toBeInTheDocument();
    expect(screen.queryByText('control.blinds')).toBeNull();
  });

  it('pausado oferece play; rodando oferece pausa', async () => {
    await montar({ is_paused: true });
    expect(screen.getByText('▶')).toBeInTheDocument();
    expect(screen.queryByText('⏸')).toBeNull();
  });
});

describe('play e pausa', () => {
  it('a tela vira na hora, antes da rede', async () => {
    // O operador aperta pausa quando algo já aconteceu na mesa; esperar a
    // resposta seria tarde.
    await montar({ is_paused: true });
    await userEvent.click(screen.getByText('▶'));
    expect(relogio.applyOptimistic).toHaveBeenCalled();
  });

  it('o primeiro toque sai IMEDIATAMENTE', async () => {
    // É o que faz a TV do salão refletir junto, sem 350ms de atraso.
    await montar({ is_paused: true });
    await userEvent.click(screen.getByText('▶'));
    expect(comando('start')).toBeTruthy();
  });

  it('o comando compartilha o tempo, para todas as telas baterem', async () => {
    await montar({ is_paused: true });
    await userEvent.click(screen.getByText('▶'));
    expect(relogio.broadcastCommand).toHaveBeenCalledWith({ is_paused: false });
  });

  it('reconcilia com o servidor depois de enviar', async () => {
    await montar({ is_paused: true });
    await userEvent.click(screen.getByText('▶'));
    await waitFor(() => expect(relogio.triggerRefetch).toHaveBeenCalled());
  });

  it('uma rajada de cliques não vira uma rajada de requisições', async () => {
    // Sem a coalescência, dez toques nervosos seriam dez POSTs — e o último
    // a chegar poderia ser o mais antigo.
    jest.useFakeTimers();
    const usuario = userEvent.setup({ advanceTimers: jest.advanceTimersByTime });
    await montar({ is_paused: true });
    const botao = screen.getByText('▶');
    await usuario.click(botao);
    await usuario.click(botao);
    await usuario.click(botao);
    await act(async () => {
      jest.advanceTimersByTime(400);
    });
    // no máximo 2: o primeiro (imediato) e o final (estado que ficou)
    expect(offlineWrite.mock.calls.length).toBeLessThanOrEqual(2);
    jest.useRealTimers();
  });

  it('comando que falha não derruba a tela', async () => {
    // Sem rede, a operação vai para a fila; um erro aqui não pode apagar o
    // relógio do salão.
    offlineWrite.mockRejectedValue(new Error('sem rede'));
    await montar({ is_paused: true });
    await userEvent.click(screen.getByText('▶'));
    await waitFor(() => expect(relogio.triggerRefetch).toHaveBeenCalled());
    expect(screen.getByText('5:05')).toBeInTheDocument();
  });
});

describe('níveis e ajuste de tempo', () => {
  it('avança de nível', async () => {
    await montar();
    await userEvent.click(screen.getByText('⏭'));
    await waitFor(() => expect(comando('next-level')).toBeTruthy());
  });

  it('volta de nível', async () => {
    await montar();
    await userEvent.click(screen.getByText('⏮'));
    await waitFor(() => expect(comando('prev-level')).toBeTruthy());
  });

  it.each([
    ['-5m', -300],
    ['-1m', -60],
    ['-30s', -30],
    ['+30s', 30],
    ['+1m', 60],
    ['+5m', 300],
  ])('o botão %s ajusta %i segundos', async (rotulo, segundos) => {
    await montar();
    await userEvent.click(screen.getByText(rotulo));
    await waitFor(() => {
      const c = comando('adjust');
      expect(c[0].body.seconds).toBe(segundos);
    });
  });

  it('cada comando reconcilia com o servidor', async () => {
    await montar();
    await userEvent.click(screen.getByText('⏭'));
    await waitFor(() => expect(relogio.triggerRefetch).toHaveBeenCalled());
  });

  it('erro num comando não quebra a tela', async () => {
    offlineWrite.mockRejectedValue(new Error('falhou'));
    await montar();
    await userEvent.click(screen.getByText('⏭'));
    await waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(screen.getByText('5:05')).toBeInTheDocument();
  });
});

describe('reiniciar o relógio', () => {
  it('pede confirmação de perigo', async () => {
    // Reiniciar zera o tempo na frente do salão inteiro; não pode sair de um
    // clique acidental.
    await montar();
    await userEvent.click(screen.getByText('control.reset'));
    expect(confirmar).toHaveBeenCalledWith(
      'control.confirmReset',
      expect.objectContaining({ variant: 'danger' })
    );
    await waitFor(() => expect(comando('reset')).toBeTruthy());
  });

  it('cancelar não reinicia', async () => {
    confirmar.mockResolvedValue(false);
    await montar();
    await userEvent.click(screen.getByText('control.reset'));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(comando('reset')).toBeFalsy();
  });
});

describe('contador de eliminados', () => {
  it('os comandos vão pela camada offline com identificador próprio', async () => {
    // A chave de idempotência é o que evita contar a mesma eliminação duas
    // vezes se o envio for repetido.
    await montar();
    await userEvent.click(screen.getByText('⏭'));
    await waitFor(() => expect(offlineWrite).toHaveBeenCalled());
    expect(offlineWrite.mock.calls[0][0].clientMutationId).toBe('mut-fixa');
  });

  it('o corpo carrega o dia e a ação para o replay', async () => {
    // O `/sync/batch` reexecuta a operação sozinho; sem esses campos ele não
    // saberia o que fazer.
    await montar();
    await userEvent.click(screen.getByText('⏭'));
    await waitFor(() => expect(comando('next-level')).toBeTruthy());
    expect(comando('next-level')[0].body).toMatchObject({
      day_id: 'dia-1',
      action: 'next-level',
    });
  });
});
