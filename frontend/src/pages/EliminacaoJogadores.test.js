/**
 * Eliminação de jogadores — usada de pé, ao lado das mesas, enquanto o
 * torneio corre.
 *
 * Duas decisões carregam o peso:
 *
 * - **A lista vira na hora (otimista) e só depois reconcilia.** O staff
 *   elimina alguém e já anda para a próxima mesa; esperar a resposta faria
 *   ele duvidar se o clique pegou e eliminar de novo.
 * - **Eliminar e reativar passam pela camada offline.** Sem internet a
 *   operação entra na fila e a tela avisa que foi salva — porque a
 *   eliminação já aconteceu de fato no salão, e perder isso significaria
 *   pagar prêmio a quem foi eliminado.
 *
 * Reativar existe porque o rebuy pós-eliminação é comum: o jogador volta, e
 * sem desfazer a eliminação ele ficaria de fora do ranking.
 */
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import EliminacaoJogadores from './EliminacaoJogadores';
import api from '../config/api';
import { offlineWrite } from '../offline/apiOffline';
import { applyEliminate } from '../offline/domainRules';
import { getEntity, putEntity } from '../offline/db';
import { useToast } from '../contexts/ToastContext';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../offline/apiOffline', () => ({ offlineWrite: jest.fn() }));
jest.mock('../offline/domainRules', () => ({ applyEliminate: jest.fn() }));
jest.mock('../offline/db', () => ({
  uuid: () => 'mut-fixa',
  getEntity: jest.fn(),
  putEntity: jest.fn(),
}));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));

const mockNavegar = jest.fn();
let mockBusca = 'tournament=t1';
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavegar,
  useSearchParams: () => [new URLSearchParams(mockBusca)],
}));

jest.mock('react-i18next', () => {
  const t = (chave, vars) =>
    vars && typeof vars === 'object' ? `${chave}:${Object.values(vars).join(',')}` : chave;
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const TORNEIO = { id: 't1', name: 'Main Event', stage_id: 'e1' };
const ETAPA = { id: 'e1', name: 'Etapa Rio', location: 'Rio', start_date: '2026-06-08' };
const DIAS = [
  { id: 'd1', day_name: 'Dia 1A', status: 'completed' },
  { id: 'd2', day_name: 'Dia 1B', status: 'active' },
];
const JOGADORES = [
  { id: 'tp1', player_name: 'Ana Souza', player_nickname: 'aninha', status: 'active' },
  { id: 'tp2', player_name: 'Bruno Lima', player_nickname: null, status: 'active' },
  { id: 'tp3', player_name: 'Carla Dias', player_nickname: null, status: 'eliminated' },
];

let toast;
let confirmar;

const responder = ({ torneio = TORNEIO, etapa = ETAPA, dias = DIAS, jogadores = JOGADORES } = {}) => {
  api.get.mockImplementation((url) => {
    if (url.startsWith('/tournaments/')) {
      return torneio instanceof Error ? Promise.reject(torneio) : Promise.resolve({ data: torneio });
    }
    if (url.startsWith('/stages/')) {
      return etapa instanceof Error ? Promise.reject(etapa) : Promise.resolve({ data: etapa });
    }
    if (url.startsWith('/tournament-days/')) return Promise.resolve({ data: dias });
    if (url.includes('/tournament-players/')) return Promise.resolve({ data: jogadores });
    return Promise.resolve({ data: [] });
  });
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<MemoryRouter><EliminacaoJogadores /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
};

beforeEach(() => {
  jest.useRealTimers();
  mockBusca = 'tournament=t1';
  mockNavegar.mockClear();
  toast = { success: jest.fn(), error: jest.fn() };
  confirmar = jest.fn().mockResolvedValue(true);
  useToast.mockReturnValue({ toast, confirm: confirmar });
  offlineWrite.mockResolvedValue({ data: { ok: true }, offline: false });
  applyEliminate.mockResolvedValue(undefined);
  getEntity.mockResolvedValue({ id: 'tp1', status: 'eliminated', eliminated_at: 'x' });
  putEntity.mockResolvedValue(undefined);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('carga', () => {
  it('sem torneio na URL volta para a lista', async () => {
    // A tela não tem sentido fora de um torneio.
    mockBusca = '';
    render(<MemoryRouter><EliminacaoJogadores /></MemoryRouter>);
    await waitFor(() => expect(mockNavegar).toHaveBeenCalledWith('/torneios'));
  });

  it('mostra torneio e etapa no título', async () => {
    await montar();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Main Event');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Etapa Rio');
  });

  it('etapa que falha não impede a operação', async () => {
    // Eliminar jogador não depende do nome da etapa.
    await montar({ etapa: new Error('403') });
    expect(screen.getByText('Ana Souza')).toBeInTheDocument();
  });

  it('torneio sem etapa não quebra', async () => {
    await montar({ torneio: { id: 't1', name: 'Main Event' } });
    expect(screen.getByText('Ana Souza')).toBeInTheDocument();
  });

  it('escolhe sozinho o dia ATIVO', async () => {
    // O staff está operando o dia em curso; abrir num dia encerrado faria
    // ele eliminar no lugar errado.
    await montar();
    expect(screen.getByLabelText(/selectDay/)).toHaveValue('d2');
  });

  it('sem dia ativo cai no primeiro', async () => {
    await montar({ dias: [{ id: 'd1', day_name: 'Dia 1A', status: 'pending' }] });
    expect(screen.getByLabelText(/selectDay/)).toHaveValue('d1');
  });

  it('o dia da URL manda sobre o padrão', async () => {
    mockBusca = 'tournament=t1&day=d1';
    await montar();
    expect(screen.getByLabelText(/selectDay/)).toHaveValue('d1');
  });

  it('falha ao carregar não deixa a tela presa em "carregando"', async () => {
    await montar({ torneio: new Error('500') });
    expect(screen.queryByText('common.loading')).toBeNull();
  });
});

describe('contadores', () => {
  it('separa total, ativos e eliminados', async () => {
    // É o número que o staff confere com o salão.
    await montar();
    const valores = Array.from(document.querySelectorAll('.stat-value')).map((v) => v.textContent);
    expect(valores).toEqual(['3', '2', '1']);
  });
});

describe('filtros', () => {
  it('por padrão mostra só quem está em jogo', async () => {
    // A lista de quem já saiu não interessa durante a operação.
    await montar();
    expect(screen.getByText('Ana Souza')).toBeInTheDocument();
    expect(screen.queryByText('Carla Dias')).toBeNull();
  });

  it('busca por nome', async () => {
    await montar();
    await userEvent.type(screen.getByRole('textbox'), 'bru');
    expect(screen.getByText('Bruno Lima')).toBeInTheDocument();
    expect(screen.queryByText('Ana Souza')).toBeNull();
  });

  it('busca por apelido', async () => {
    // O salão chama o jogador pelo apelido.
    await montar();
    await userEvent.type(screen.getByRole('textbox'), 'aninha');
    expect(screen.getByText('Ana Souza')).toBeInTheDocument();
  });

  it('jogador sem apelido não quebra a busca', async () => {
    await montar();
    await userEvent.type(screen.getByRole('textbox'), 'lima');
    expect(screen.getByText('Bruno Lima')).toBeInTheDocument();
  });

  it('busca ignora maiúsculas', async () => {
    await montar();
    await userEvent.type(screen.getByRole('textbox'), 'ANA');
    expect(screen.getByText('Ana Souza')).toBeInTheDocument();
  });
});

describe('eliminar', () => {
  // O botao de eliminar e por linha; o filtro tambem contem "eliminate" no
  // rotulo, entao a busca e pela classe do botao.
  const eliminarPrimeiro = async () => {
    await userEvent.click(document.querySelectorAll('.eliminate-btn')[0]);
  };

  it('pede confirmação com o nome do jogador', async () => {
    // Eliminar o jogador errado obriga a desfazer na frente dele.
    await montar();
    await eliminarPrimeiro();
    expect(confirmar).toHaveBeenCalledWith(
      expect.stringContaining('Ana Souza'),
      expect.objectContaining({ variant: 'danger' })
    );
  });

  it('cancelar não elimina', async () => {
    confirmar.mockResolvedValue(false);
    await montar();
    await eliminarPrimeiro();
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(offlineWrite).not.toHaveBeenCalled();
  });

  it('a lista vira sem esperar o servidor', async () => {
    // O staff ja andou para a proxima mesa; esperar faria ele duvidar do
    // clique e eliminar de novo. Aqui o caminho offline isola o efeito: sem
    // recarga, a unica coisa que pode ter tirado a linha e a atualizacao
    // otimista local.
    offlineWrite.mockResolvedValue({ data: {}, offline: true });
    await montar();
    await eliminarPrimeiro();
    await waitFor(() => expect(screen.queryByText('Ana Souza')).toBeNull());
  });

  it('online, reconcilia com o servidor depois de eliminar', async () => {
    // Outra estacao pode ter mexido no mesmo dia; a lista precisa voltar a
    // ser a do servidor.
    await montar();
    api.get.mockClear();
    await eliminarPrimeiro();
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/tournament-players/day/d2')
    );
  });

  it('offline avisa que a operação foi guardada', async () => {
    // A eliminação já aconteceu no salão; perder isso significaria pagar
    // prêmio a quem foi eliminado.
    offlineWrite.mockResolvedValue({ data: {}, offline: true });
    await montar();
    await eliminarPrimeiro();
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('offline aplica a mudança na réplica local', async () => {
    offlineWrite.mockImplementation(async (o) => {
      await o.applyLocal();
      return { data: {}, offline: true };
    });
    await montar();
    await eliminarPrimeiro();
    await waitFor(() => expect(applyEliminate).toHaveBeenCalled());
  });

  it('erro do servidor mostra o motivo', async () => {
    // "Jogador já eliminado" precisa chegar ao staff.
    offlineWrite.mockRejectedValue({
      response: { data: { detail: 'Jogador já eliminado' } },
    });
    await montar();
    await eliminarPrimeiro();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Jogador já eliminado')
    );
  });

  it('erro sem texto legível cai numa mensagem genérica', async () => {
    // O detail do 422 vem como LISTA; renderizá-la quebraria a tela.
    offlineWrite.mockRejectedValue({ response: { data: { detail: [{ msg: 'x' }] } } });
    await montar();
    await eliminarPrimeiro();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('common.error'));
  });
});

describe('reativar', () => {
  // O filtro de status sao BOTOES, nao um select.
  const mostrarEliminados = async () => {
    await userEvent.click(
      screen.getByRole('button', { name: /elimination.eliminatedOnly/ })
    );
  };

  it('quem foi eliminado pode voltar', async () => {
    // O rebuy pós-eliminação é comum; sem desfazer, o jogador ficaria fora
    // do ranking.
    await montar();
    await mostrarEliminados();
    expect(screen.getByText('Carla Dias')).toBeInTheDocument();
    await userEvent.click(document.querySelector('.restore-btn'));
    await waitFor(() =>
      expect(offlineWrite).toHaveBeenCalledWith(
        expect.objectContaining({ kind: 'restore' })
      )
    );
  });

  it('reativar também pede confirmação', async () => {
    await montar();
    await mostrarEliminados();
    await userEvent.click(document.querySelector('.restore-btn'));
    expect(confirmar).toHaveBeenCalledWith(expect.stringContaining('Carla Dias'));
  });

  it('cancelar não reativa', async () => {
    confirmar.mockResolvedValue(false);
    await montar();
    await mostrarEliminados();
    await userEvent.click(document.querySelector('.restore-btn'));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(offlineWrite).not.toHaveBeenCalled();
  });

  it('offline limpa a marca de eliminado na réplica', async () => {
    // Deixar `eliminated_at` faria o jogador voltar "ativo mas eliminado" no
    // replay.
    offlineWrite.mockImplementation(async (o) => {
      await o.applyLocal();
      return { data: {}, offline: true };
    });
    await montar();
    await mostrarEliminados();
    await userEvent.click(document.querySelector('.restore-btn'));
    await waitFor(() => expect(putEntity).toHaveBeenCalled());
    const gravado = putEntity.mock.calls[0][1];
    expect(gravado.status).toBe('active');
    expect(gravado.eliminated_at).toBeUndefined();
  });

  it('jogador ausente da réplica não quebra', async () => {
    getEntity.mockResolvedValue(null);
    offlineWrite.mockImplementation(async (o) => {
      await o.applyLocal();
      return { data: {}, offline: true };
    });
    await montar();
    await mostrarEliminados();
    await userEvent.click(document.querySelector('.restore-btn'));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(putEntity).not.toHaveBeenCalled();
  });

  it('erro ao reativar avisa', async () => {
    offlineWrite.mockRejectedValue({ response: { data: { detail: 'dia encerrado' } } });
    await montar();
    await mostrarEliminados();
    await userEvent.click(document.querySelector('.restore-btn'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('dia encerrado'));
  });
});

describe('troca de dia', () => {
  it('mudar o dia recarrega os jogadores daquele dia', async () => {
    // Manter a lista anterior faria o staff eliminar alguém do dia errado.
    await montar();
    api.get.mockClear();
    await userEvent.selectOptions(screen.getByLabelText(/selectDay/), 'd1');
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/tournament-players/day/d1')
    );
  });
});

describe('atualização periódica', () => {
  it('alcança sozinho quem foi eliminado em outra estação', async () => {
    // Outra estação pode estar eliminando ao mesmo tempo.
    //
    // Quem avisa agora é o banco, via Realtime — esta tela recarregava a cada
    // 3 SEGUNDOS para descobrir sozinha, e quase sempre recebia de volta
    // exatamente a lista que já tinha. O que continua garantido, e é o que
    // este teste protege, é que ela NÃO depende de uma ação local para
    // atualizar: mesmo sem evento nenhum, a rede de segurança a alcança.
    jest.useFakeTimers();
    responder();
    render(<MemoryRouter><EliminacaoJogadores /></MemoryRouter>);
    await act(async () => {});
    const antes = api.get.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(30000 + 200); // intervalo + debounce do hook
    });
    expect(api.get.mock.calls.length).toBeGreaterThan(antes);
    jest.useRealTimers();
  });
});
