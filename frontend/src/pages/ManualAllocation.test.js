/**
 * Alocação manual — a versão por TORNEIO do mapa de mesas.
 *
 * É a tela usada quando o torneio não tem estrutura de dias. O que ela tem de
 * próprio, e que os testes cercam:
 *
 * - **Eliminar daqui é UMA chamada ao servidor.** Ele marca o jogador como
 *   eliminado, soma no contador que a TV lê, libera a cadeira e recalcula o
 *   ranking. Gravar só o status (como antes) deixava a TV sem ver a
 *   eliminação.
 * - **Assento ocupado recusa o drop**, e mesa com gente não é removida.
 * - **Mover alguém já sentado é PATCH**, não uma nova alocação — criar outra o
 *   deixaria ocupando dois assentos ao mesmo tempo.
 */
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ManualAllocation from './ManualAllocation';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../components/SeatTicket', () => ({ allocation }) => (
  <div data-testid="bilhete">
    <span data-testid="bilhete-mesa">{allocation.table_number ?? '-'}</span>
    <span data-testid="bilhete-assento">{allocation.seat_number ?? '-'}</span>
  </div>
));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ tournamentId: 't1' }),
  useNavigate: () => mockNavigate,
}));
jest.mock('react-i18next', () => {
  const t = (chave, vars) =>
    vars && typeof vars === 'object' ? `${chave}:${Object.values(vars).join(',')}` : chave;
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const TORNEIO = { id: 't1', name: 'Main Event' };

const MESAS = [
  { id: 'm1', table_number: 1, seats: 3 },
  { id: 'm2', table_number: 2, seats: 3 },
];

const ALOCACOES = [
  { id: 'a1', table_id: 'm1', seat_number: 1, player_id: 'p1', players: { name: 'Ana' } },
];

const SEM_MESA = [
  { player_id: 'p2', player_name: 'Beto' },
  { player_id: 'p3', player_name: 'Carla' },
];

const INSCRITOS = [{ id: 'tp1', player_id: 'p1' }];

let toast;
let confirmar;

const responder = ({
  torneio = TORNEIO, mesas = MESAS, alocacoes = ALOCACOES,
  semMesa = SEM_MESA, inscritos = INSCRITOS,
} = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/tournaments/t1') {
      return torneio instanceof Error ? Promise.reject(torneio) : Promise.resolve({ data: torneio });
    }
    if (url === '/tables/tournament/t1') return Promise.resolve({ data: mesas });
    if (url === '/allocations/tournament/t1') return Promise.resolve({ data: alocacoes });
    if (url === '/allocations/tournament/t1/unallocated') return Promise.resolve({ data: semMesa });
    if (url === '/tournament-players/tournament/t1') return Promise.resolve({ data: inscritos });
    if (url.startsWith('/allocations/')) {
      return Promise.resolve({ data: { table_number: 2, seat_number: 3 } });
    }
    return Promise.resolve({ data: [] });
  });
};

const erroHttp = (detail) => {
  const e = new Error('http');
  e.response = { data: { detail } };
  return e;
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<MemoryRouter><ManualAllocation /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
};

const mesaDoNumero = (n) =>
  Array.from(document.querySelectorAll('.table-container')).find((el) =>
    el.querySelector('.table-header').textContent.includes(`:${n}`)
  );

const assentos = (mesa) => Array.from(mesa.querySelectorAll('.seat'));

const cartaoDe = (nome) =>
  Array.from(document.querySelectorAll('.player-card')).find((el) =>
    el.textContent.includes(nome)
  );

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  confirmar = jest.fn().mockResolvedValue(true);
  useToast.mockReturnValue({ toast, confirm: confirmar });
  api.post.mockResolvedValue({ data: { table_number: 1, seat_number: 2 } });
  api.patch.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('carga', () => {
  it('mostra o carregamento antes dos dados', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><ManualAllocation /></MemoryRouter>);
    expect(screen.getByText('common.loading')).toBeInTheDocument();
  });

  it('o subtítulo diz o torneio e quantos já estão sentados', async () => {
    await montar();
    expect(document.querySelector('.subtitle')).toHaveTextContent('Main Event,1');
  });

  it('falha ao carregar não deixa a tela presa', async () => {
    await montar({ torneio: erroHttp('500') });
    expect(screen.queryByText('common.loading')).toBeNull();
  });

  it('sem mesa nenhuma orienta a criar a primeira', async () => {
    await montar({ mesas: [], alocacoes: [] });
    expect(document.querySelector('.no-tables')).toBeInTheDocument();
  });

  it('com todos sentados a lista lateral diz isso', async () => {
    // Uma lista vazia sem explicação pareceria erro de carregamento.
    await montar({ semMesa: [] });
    expect(screen.getByText('manualAllocation.allPlayersAllocated')).toBeInTheDocument();
  });

  it('voltar leva à lista de torneios', async () => {
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'common.back' }));
    expect(mockNavigate).toHaveBeenCalledWith('/torneios');
  });
});

describe('mapa das mesas', () => {
  it('cada mesa mostra a própria ocupação', async () => {
    await montar();
    expect(mesaDoNumero(1)).toHaveTextContent('occupiedCount:1,3');
    expect(mesaDoNumero(2)).toHaveTextContent('occupiedCount:0,3');
  });

  it('o assento ocupado mostra quem está nele', async () => {
    await montar();
    expect(within(mesaDoNumero(1)).getByText('Ana')).toBeInTheDocument();
  });

  it('assento livre é marcado como vazio', async () => {
    await montar();
    expect(within(mesaDoNumero(2)).getAllByText('manualAllocation.empty').length).toBe(3);
  });
});

describe('alocar arrastando', () => {
  const arrastar = (cartao, alvo) => {
    fireEvent.dragStart(cartao, { dataTransfer: { setData: () => {}, effectAllowed: '' } });
    fireEvent.dragOver(alvo, { dataTransfer: { dropEffect: '' } });
    fireEvent.drop(alvo, { dataTransfer: {} });
  };

  it('soltar num assento vazio aloca e emite bilhete', async () => {
    await montar();
    arrastar(cartaoDe('Beto'), assentos(mesaDoNumero(2))[0]);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/allocations/tournament/t1/manual', {
        player_id: 'p2', table_id: 'm2', seat_number: 1,
      })
    );
    expect(await screen.findByTestId('bilhete')).toBeInTheDocument();
  });

  it('assento OCUPADO nem aceita o solte', async () => {
    // Dois jogadores na mesma cadeira não têm como ser resolvidos depois; o
    // assento ocupado sequer recebe o manipulador de solte.
    await montar();
    arrastar(cartaoDe('Beto'), assentos(mesaDoNumero(1))[0]);
    expect(api.post).not.toHaveBeenCalled();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('mover alguém já sentado usa PATCH', async () => {
    // Criar outra alocação o deixaria ocupando dois assentos.
    await montar();
    arrastar(document.querySelector('.seat-player'), assentos(mesaDoNumero(2))[0]);
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/allocations/a1', { table_id: 'm2', seat_number: 1 })
    );
    expect(api.post).not.toHaveBeenCalled();
  });

  it('mover reemite o bilhete com o assento novo', async () => {
    await montar();
    arrastar(document.querySelector('.seat-player'), assentos(mesaDoNumero(2))[0]);
    expect(await screen.findByTestId('bilhete-mesa')).toHaveTextContent('2');
  });

  it('arrastar de volta para a lista libera o assento', async () => {
    await montar();
    arrastar(document.querySelector('.seat-player'), document.querySelector('.players-list'));
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/allocations/a1'));
  });

  it('arrastar da lista para a lista não faz nada', async () => {
    await montar();
    arrastar(cartaoDe('Beto'), document.querySelector('.players-list'));
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('soltar sem ter arrastado ninguém não faz nada', async () => {
    await montar();
    fireEvent.drop(assentos(mesaDoNumero(2))[0], { dataTransfer: {} });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('erro ao alocar mostra o motivo', async () => {
    api.post.mockRejectedValue(erroHttp('Assento reservado'));
    await montar();
    arrastar(cartaoDe('Beto'), assentos(mesaDoNumero(2))[0]);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('manualAllocation.errorAllocate:Assento reservado')
    );
  });

  it('erro ao liberar o assento avisa', async () => {
    api.delete.mockRejectedValue(new Error('500'));
    await montar();
    arrastar(document.querySelector('.seat-player'), document.querySelector('.players-list'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('manualAllocation.errorUnallocate')
    );
  });

  it('o bilhete pode ser fechado', async () => {
    await montar();
    arrastar(cartaoDe('Beto'), assentos(mesaDoNumero(2))[0]);
    await screen.findByTestId('bilhete');
    await userEvent.click(document.querySelector('.ticket-modal-header .close-btn'));
    expect(screen.queryByTestId('bilhete')).toBeNull();
  });
});

describe('eliminar da mesa', () => {
  const eliminar = async () => {
    await userEvent.click(document.querySelector('.btn-remove-allocation'));
  };

  it('pede confirmação de perigo nomeando o jogador', async () => {
    await montar();
    await eliminar();
    expect(confirmar).toHaveBeenCalledWith(
      'manualAllocation.confirmEliminate:Ana',
      expect.objectContaining({ variant: 'danger' })
    );
  });

  it('elimina pelo servidor, numa chamada só', async () => {
    // O servidor marca a eliminação, soma no contador que a TV lê, libera a
    // cadeira e recalcula o ranking — a tela não faz nenhum desses passos.
    await montar();
    await eliminar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tournament-players/tp1/eliminate')
    );
    expect(api.patch).not.toHaveBeenCalled();
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('a inscrição é a do mesmo dia da cadeira', async () => {
    // Quem joga o 1A e o 1B tem duas inscrições; eliminar a do outro dia
    // tiraria do torneio quem está sentado jogando.
    await montar({
      alocacoes: [{ id: 'a1', table_id: 'm1', seat_number: 1, player_id: 'p1',
        tournament_day_id: 'd2', players: { name: 'Ana' } }],
      inscritos: [
        { id: 'tp-d1', player_id: 'p1', tournament_day_id: 'd1' },
        { id: 'tp-d2', player_id: 'p1', tournament_day_id: 'd2' },
      ],
    });
    await eliminar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tournament-players/tp-d2/eliminate')
    );
  });

  it('jogador sem inscrição no torneio ainda libera o assento', async () => {
    // Um assento preso por um registro inconsistente travaria a mesa.
    await montar({ inscritos: [] });
    await eliminar();
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/allocations/a1'));
    expect(api.post).not.toHaveBeenCalledWith(expect.stringMatching(/eliminate$/));
  });

  it('recusar a confirmação não elimina', async () => {
    confirmar.mockResolvedValue(false);
    await montar();
    await eliminar();
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('erro na eliminação mostra o motivo', async () => {
    api.post.mockRejectedValue(erroHttp('Torneio encerrado'));
    await montar();
    await eliminar();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('manualAllocation.errorEliminate:Torneio encerrado')
    );
  });

  it('alocação sem o jogador carregado não derruba o mapa', async () => {
    // Um join que falhou não pode apagar todas as mesas da tela.
    await montar({
      alocacoes: [{ id: 'a1', table_id: 'm1', seat_number: 1, player_id: 'p1', players: null }],
    });
    expect(mesaDoNumero(1)).toHaveTextContent('manualAllocation.defaultPlayer');
    await eliminar();
    expect(confirmar).toHaveBeenCalledWith(
      'manualAllocation.confirmEliminate:manualAllocation.defaultPlayer',
      expect.anything()
    );
  });
});

describe('gerenciar mesas', () => {
  const abrir = () => userEvent.click(screen.getByRole('button', { name: 'manualAllocation.manageTables' }));

  it('criar mesa continua a numeração', async () => {
    // Repetir um número deixaria duas "Mesa 2" no salão.
    await montar();
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'manualAllocation.addTable' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tables/tournament/t1', {
        table_number: 3, seats: 9,
      })
    );
  });

  it('a primeira mesa do torneio é a número 1', async () => {
    await montar({ mesas: [], alocacoes: [] });
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'manualAllocation.addTable' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tables/tournament/t1', {
        table_number: 1, seats: 9,
      })
    );
  });

  it('o número de assentos escolhido é respeitado', async () => {
    await montar();
    await abrir();
    fireEvent.change(screen.getByLabelText('manualAllocation.seatsLabel'), { target: { value: '6' } });
    await userEvent.click(screen.getByRole('button', { name: 'manualAllocation.addTable' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tables/tournament/t1', {
        table_number: 3, seats: 6,
      })
    );
  });

  it('erro ao criar mostra o motivo', async () => {
    api.post.mockRejectedValue(erroHttp('Limite do plano'));
    await montar();
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'manualAllocation.addTable' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('manualAllocation.errorAddTable:Limite do plano')
    );
  });

  it('mesa COM jogador não oferece remoção', async () => {
    // Apagar deixaria os jogadores em alocações órfãs.
    await montar();
    expect(mesaDoNumero(1).querySelector('.btn-remove-table')).toBeNull();
    expect(mesaDoNumero(2).querySelector('.btn-remove-table')).toBeInTheDocument();
  });

  it('remover mesa vazia pede confirmação', async () => {
    await montar();
    await userEvent.click(mesaDoNumero(2).querySelector('.btn-remove-table'));
    expect(confirmar).toHaveBeenCalledWith(
      'manualAllocation.confirmRemoveTable:2',
      expect.objectContaining({ variant: 'danger' })
    );
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/tables/m2'));
  });

  it('recusar não remove', async () => {
    confirmar.mockResolvedValue(false);
    await montar();
    await userEvent.click(mesaDoNumero(2).querySelector('.btn-remove-table'));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('erro ao remover mostra o motivo', async () => {
    api.delete.mockRejectedValue(erroHttp('Mesa em uso'));
    await montar();
    await userEvent.click(mesaDoNumero(2).querySelector('.btn-remove-table'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('manualAllocation.errorRemoveTable:Mesa em uso')
    );
  });
});
