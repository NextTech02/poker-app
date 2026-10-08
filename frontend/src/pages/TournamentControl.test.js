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
import { usePermissions } from '../contexts/PermissionContext';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../offline/apiOffline', () => ({ offlineWrite: jest.fn() }));
jest.mock('../offline/db', () => ({ uuid: () => 'mut-fixa' }));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/PermissionContext', () => ({ usePermissions: jest.fn() }));
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

const DIA = { id: 'dia-1', day_name: 'Dia 1A', status: 'active', tournament_id: 'torneio-9' };

const BLINDS = [
  { level: 2, small_blind: 100, big_blind: 200, ante: 0, duration: 15, is_break: false },
  { level: 1, small_blind: 50, big_blind: 100, ante: 0, duration: 15, is_break: false },
];

let relogio;
let confirmar;
let toast;

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

const montar = async (extraRelogio = {}, extraHook = {}) => {
  relogio = {
    timerState: estadoRelogio(extraRelogio),
    triggerRefetch: jest.fn(),
    applyOptimistic: jest.fn(),
    applyLocalCommand: jest.fn(() => true),
    broadcastCommand: jest.fn((c) => ({ ...c, remaining: 305 })),
    isOffline: false,
    isLoading: false,
    ...extraHook,
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
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  useToast.mockReturnValue({ confirm: confirmar, toast });
  usePermissions.mockReturnValue({ isAdmin: true, hasPermission: () => true });
  api.get.mockResolvedValue({ data: DIA });
  api.post.mockResolvedValue({ data: { success: true } });
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


describe('bloqueio de vendas do dia', () => {
  /** O dia é a trava fina: encerrar o Dia 1A não pode parar o 1B da mesma
   *  etapa. Quem decide a hora é o diretor, e ele está NESTA tela. */
  const montarComDia = async (dia) => {
    api.get.mockResolvedValue({ data: { ...DIA, ...dia } });
    await montar();
  };

  it('encerra a venda do dia com o motivo digitado', async () => {
    // O motivo aparece para o operador do Caixa; sem ele a venda recusada vira
    // chamado de suporte no meio do evento.
    await montar();
    await userEvent.click(screen.getByText('sales.blockDay'));
    await userEvent.type(screen.getByLabelText('sales.blockReason'), 'registro tardio encerrado');
    await userEvent.click(screen.getByText('sales.confirmBlock'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tournament-days/dia-1/sales-block', {
        blocked: true,
        reason: 'registro tardio encerrado',
      })
    );
  });

  it('motivo em branco vira nulo, e não string vazia', async () => {
    await montar();
    await userEvent.click(screen.getByText('sales.blockDay'));
    await userEvent.click(screen.getByText('sales.confirmBlock'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tournament-days/dia-1/sales-block', {
        blocked: true, reason: null,
      })
    );
  });

  it('dia bloqueado mostra o motivo e oferece liberar', async () => {
    await montarComDia({ sales_blocked: true, sales_blocked_reason: 'mesas fechadas' });
    expect(screen.getByText('mesas fechadas')).toBeInTheDocument();
    await userEvent.click(screen.getByText('sales.unblockDay'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tournament-days/dia-1/sales-block', {
        blocked: false, reason: null,
      })
    );
  });

  it('desistir da confirmação não libera a venda', async () => {
    confirmar.mockResolvedValue(false);
    await montarComDia({ sales_blocked: true });
    await userEvent.click(screen.getByText('sales.unblockDay'));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.post).not.toHaveBeenCalled();
  });

  it('quem não administra caixa nem vê o botão', async () => {
    // É justamente do operador que se está tirando a permissão de vender.
    usePermissions.mockReturnValue({ isAdmin: false, hasPermission: () => false });
    await montar();
    expect(screen.queryByText('sales.blockDay')).toBeNull();
  });

  it('só o perfil financeiro não basta — o servidor exige caixa', async () => {
    // O backend exige CashboxService.can_admin. Com 'financial' liberando o
    // botão, o usuário clicava, levava "Sem permissão para bloquear vendas" e
    // ficava sem saber se a trava valeu — no meio do evento vira telefonema.
    usePermissions.mockReturnValue({
      isAdmin: false,
      hasPermission: (p) => p === 'financial',
    });
    await montar();
    expect(screen.queryByText('sales.blockDay')).toBeNull();
  });

  it('erro do servidor é mostrado ao diretor', async () => {
    api.post.mockRejectedValue({ response: { data: { detail: 'Sem permissão para bloquear vendas' } } });
    await montar();
    await userEvent.click(screen.getByText('sales.blockDay'));
    await userEvent.click(screen.getByText('sales.confirmBlock'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Sem permissão para bloquear vendas')
    );
  });
});


describe('saída da tela', () => {
  /** O operador entra no controle pelo torneio e precisa VOLTAR para ele.
   *  Sem a trilha, a única saída era o menu lateral — foi o achado relatado
   *  duas vezes no teste de aceitação. */

  it('a trilha leva de volta ao torneio', async () => {
    await montar();
    const link = screen.getByText('control.breadcrumbTournament').closest('a');
    expect(link).toHaveAttribute('href', '/torneios/torneio-9');
  });

  it('mesmo sem conseguir carregar o dia, ainda há por onde voltar', async () => {
    // O relógio continua na tela quando o GET do dia falha; a saída também
    // precisa continuar, senão o operador fica preso justamente no erro.
    api.get.mockRejectedValue(new Error('503'));
    useTimerSync.mockReturnValue({
      timerState: estadoRelogio(),
      triggerRefetch: jest.fn(),
      applyOptimistic: jest.fn(),
      applyLocalCommand: jest.fn(),
      broadcastCommand: jest.fn(),
      isLoading: false,
    });
    render(<MemoryRouter><TournamentControl /></MemoryRouter>);
    const link = (await screen.findByText('tournaments.title')).closest('a');
    expect(link).toHaveAttribute('href', '/torneios');
  });
});

describe('operação sem internet', () => {
  /** O relógio do telão é o que a mesa inteira olha. Se o operador muda o
   *  blind sem rede, o comando entra na fila — e a TELA não pode ficar
   *  esperando calada uma confirmação que não vem. */

  it('comando que ficou na fila é aplicado nesta tela na hora', async () => {
    offlineWrite.mockResolvedValue({ data: { ok: true }, offline: true });
    await montar();
    await userEvent.click(screen.getByText('⏭'));
    await waitFor(() =>
      expect(relogio.applyLocalCommand).toHaveBeenCalledWith('next-level', {})
    );
  });

  it('o ajuste de tempo leva os segundos para a aplicação local', async () => {
    offlineWrite.mockResolvedValue({ data: { ok: true }, offline: true });
    await montar();
    await userEvent.click(screen.getByText('+5m'));
    await waitFor(() =>
      expect(relogio.applyLocalCommand).toHaveBeenCalledWith('adjust', { seconds: 300 })
    );
  });

  it('o operador é avisado de que a mudança ainda não foi ao servidor', async () => {
    // Um relógio que muda sozinho sem explicação assusta tanto quanto um
    // relógio parado.
    offlineWrite.mockResolvedValue({ data: { ok: true }, offline: true });
    await montar();
    await userEvent.click(screen.getByText('⏭'));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('control.offlineApplied')
    );
  });

  it('quando nem localmente dá para aplicar, o aviso diz que ficou na fila', async () => {
    // Voltar de nível sem a estrutura em cache é um caso assim: melhor avisar
    // do que inventar um blind na frente da mesa.
    offlineWrite.mockResolvedValue({ data: { ok: true }, offline: true });
    await montar({}, { applyLocalCommand: jest.fn(() => false) });
    await userEvent.click(screen.getByText('⏮'));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('control.offlineQueued')
    );
  });

  it('comando que chegou ao servidor não mexe no relógio local nem avisa', async () => {
    await montar();
    await userEvent.click(screen.getByText('⏭'));
    await waitFor(() => expect(relogio.triggerRefetch).toHaveBeenCalled());
    expect(relogio.applyLocalCommand).not.toHaveBeenCalled();
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('o telão diz que está sem conexão', async () => {
    // Sem esse aviso, "relógio rodando local" é indistinguível de "travou".
    await montar({}, { isOffline: true });
    expect(screen.getByText('control.offlineClock')).toBeInTheDocument();
  });

  it('com conexão o aviso não aparece', async () => {
    await montar();
    expect(screen.queryByText('control.offlineClock')).toBeNull();
  });

  it('entrega a estrutura de blinds ao relógio, ordenada por nível', async () => {
    // É ela que permite virar de nível sozinho quando a internet cai; sem
    // passar os blinds o relógio parava em 00:00 no fim do nível.
    api.get.mockImplementation((url) => (
      url.endsWith('/blinds')
        ? Promise.resolve({ data: BLINDS })
        : Promise.resolve({ data: DIA })
    ));
    await montar();
    await waitFor(() => {
      const ultima = useTimerSync.mock.calls[useTimerSync.mock.calls.length - 1];
      expect(ultima[1].map((b) => b.level)).toEqual([1, 2]);
    });
  });
});

describe('modo de eliminação', () => {
  /** O diretor escolhe na criação do torneio COMO elimina. Os dois modos
   *  seguem a mesma conta (ENTRADAS − ELIMINAÇÕES = ATIVOS); muda o lugar
   *  onde a eliminação é marcada. */
  const comModo = (modo) => {
    api.get.mockImplementation((url) => (
      url === '/tournaments/torneio-9'
        ? Promise.resolve({ data: { id: 'torneio-9', elimination_mode: modo } })
        : Promise.resolve({ data: DIA })
    ));
  };

  it('em massa mantém os botões do contador', async () => {
    comModo('bulk');
    await montar();
    expect(await screen.findByText('control.eliminateOne')).toBeInTheDocument();
    expect(screen.queryByText('control.eliminateAtTables')).toBeNull();
  });

  it('por mesa troca os botões pelo caminho até as mesas', async () => {
    // Por mesa, o contador é a contagem dos eliminados no assento: um
    // "Eliminar 1" sem nome descolaria o número da lista.
    comModo('table');
    await montar();
    const link = (await screen.findByText('control.eliminateAtTables')).closest('a');
    expect(link).toHaveAttribute('href', '/alocacao/dia/dia-1');
    expect(screen.queryByText('control.eliminateOne')).toBeNull();
    expect(screen.queryByText('control.bulkEliminate')).toBeNull();
  });

  it('mostra as reentradas fora da conta dos ativos', async () => {
    comModo('bulk');
    await montar({ total_reentries: 6 });
    expect(screen.getByText('CONTROL.REENTRIES')).toBeInTheDocument();
    expect(screen.getByText('6')).toBeInTheDocument();
  });

  it('recusa do servidor ao eliminar em massa chega ao diretor', async () => {
    comModo('bulk');
    const recusa = new Error('409');
    recusa.userMessage = 'Este torneio elimina jogadores pelas mesas.';
    offlineWrite.mockRejectedValue(recusa);
    await montar();
    await userEvent.click(await screen.findByText('control.eliminateOne'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Este torneio elimina jogadores pelas mesas.')
    );
  });
});
