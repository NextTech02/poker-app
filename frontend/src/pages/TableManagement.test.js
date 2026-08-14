/**
 * Mesas e assentos — o mapa do salão.
 *
 * A tela existe para responder uma pergunta que o staff faz a cada minuto:
 * *onde esse jogador senta?* Três regras dão a resposta:
 *
 * - **Travar as mesas** muda o significado de quem está sem lugar: antes da
 *   trava é "ainda não alocado"; depois, é **alternado** — está na fila,
 *   esperando alguém sair. A tela precisa trocar o rótulo junto, senão o
 *   operador aloca à força alguém que devia esperar.
 * - **Assento ocupado não recebe ninguém.** Dois jogadores no mesmo assento é
 *   um conflito impossível de resolver com a mesa já montada.
 * - **Mesa com gente não é removida.** Apagar a mesa deixaria os jogadores
 *   pendurados em alocações órfãs.
 *
 * Toda alocação termina em bilhete, porque é o papel que o jogador leva para
 * achar a própria cadeira.
 */
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import TableManagement from './TableManagement';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../hooks/usePolling', () => ({ usePolling: jest.fn() }));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../components/SeatTicket', () => ({ allocation }) => (
  <div data-testid="bilhete">
    <span data-testid="bilhete-jogador">{allocation.player_name}</span>
    <span data-testid="bilhete-mesa">{allocation.table_number ?? '-'}</span>
    <span data-testid="bilhete-assento">{allocation.seat_number ?? '-'}</span>
    <span data-testid="bilhete-alternado">{String(!!allocation.is_alternate)}</span>
  </div>
));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ dayId: 'd1' }),
  useNavigate: () => mockNavigate,
}));
jest.mock('react-i18next', () => {
  const t = (chave, vars) =>
    vars && typeof vars === 'object' ? `${chave}:${Object.values(vars).join(',')}` : chave;
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const DIA = { id: 'd1', day_name: 'Dia 1A', tournament_id: 't1', tables_locked: false };

const MESAS = [
  { id: 'm1', table_number: 1, seats: 3, status: 'active' },
  { id: 'm2', table_number: 2, seats: 3, status: 'active' },
];

const ALOCACOES = [
  { id: 'a1', table_id: 'm1', seat_number: 1, player_id: 'p1', players: { name: 'Ana' } },
];

const SEM_MESA = [
  { player_id: 'p2', player_name: 'Beto' },
  { player_id: 'p3', player_name: 'Carla' },
];

let toast;
let confirmar;

const responder = ({
  dia = DIA, mesas = MESAS, alocacoes = ALOCACOES, semMesa = SEM_MESA,
  torneio = { id: 't1', name: 'Main Event' },
} = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/tournament-days/d1') {
      return dia instanceof Error ? Promise.reject(dia) : Promise.resolve({ data: dia });
    }
    if (url === '/tables/day/d1') return Promise.resolve({ data: mesas });
    if (url === '/allocations/day/d1') return Promise.resolve({ data: alocacoes });
    if (url === '/allocations/day/d1/unallocated') return Promise.resolve({ data: semMesa });
    if (url === '/tournaments/t1') return Promise.resolve({ data: torneio });
    if (url.startsWith('/allocations/')) {
      return Promise.resolve({ data: { player_name: 'Ana', table_number: 2, seat_number: 3 } });
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
  render(<MemoryRouter><TableManagement /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
};

const mesaDoNumero = (n) =>
  Array.from(document.querySelectorAll('.tm-table')).find((el) =>
    el.querySelector('.tm-table-num').textContent.includes(`:${n}`)
  );

const assentos = (mesa) => Array.from(mesa.querySelectorAll('.tm-seat'));

/** Arrasta um jogador da lista "sem mesa" para um assento. */
const arrastarParaAssento = async (nomeJogador, mesa, indiceAssento) => {
  const cartao = Array.from(document.querySelectorAll('.tm-player-card, .tm-players-list > *'))
    .find((el) => el.textContent.includes(nomeJogador));
  const dados = { effectAllowed: '', dropEffect: '' };
  fireEvent.dragStart(cartao, { dataTransfer: dados });
  const alvo = assentos(mesa)[indiceAssento];
  fireEvent.dragOver(alvo, { dataTransfer: dados });
  fireEvent.drop(alvo, { dataTransfer: dados });
};

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  confirmar = jest.fn().mockResolvedValue(true);
  useToast.mockReturnValue({ toast, confirm: confirmar });
  api.post.mockResolvedValue({ data: { player_name: 'Beto', table_number: 1, seat_number: 2 } });
  api.patch.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('carga', () => {
  it('mostra o carregamento antes dos dados', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><TableManagement /></MemoryRouter>);
    expect(screen.getByText('common.loading')).toBeInTheDocument();
  });

  it('o subtítulo resume ocupação sobre assentos ativos', async () => {
    // 1 ocupado de 6 assentos (duas mesas de 3).
    await montar();
    expect(document.querySelector('.tm-subtitle')).toHaveTextContent('Dia 1A,1,6');
  });

  it('mesa desativada não conta assentos disponíveis', async () => {
    // Contar a mesa fechada faria o operador achar que ainda cabe gente.
    await montar({ mesas: [MESAS[0], { ...MESAS[1], status: 'closed' }] });
    expect(document.querySelector('.tm-subtitle')).toHaveTextContent('Dia 1A,1,3');
  });

  it('falha ao carregar não deixa a tela presa no carregamento', async () => {
    await montar({ dia: erroHttp('500') });
    expect(screen.queryByText('common.loading')).toBeNull();
  });

  it('sem mesa nenhuma orienta a criar a primeira', async () => {
    await montar({ mesas: [], alocacoes: [] });
    expect(document.querySelector('.tm-no-tables')).toBeInTheDocument();
  });

  it('voltar volta', async () => {
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.back' }));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });
});

describe('travar as mesas', () => {
  it('mesas abertas: quem não tem lugar é "sem mesa"', async () => {
    await montar();
    expect(document.querySelector('.tm-panel-title')).toHaveTextContent('tableManagement.panelNoTable');
    expect(document.querySelector('.tm-alt-hint')).toBeNull();
  });

  it('mesas travadas: quem não tem lugar vira ALTERNADO', async () => {
    // Depois da trava, quem chega entra na fila; tratar como "não alocado"
    // levaria o operador a forçar um assento numa mesa já fechada.
    await montar({ dia: { ...DIA, tables_locked: true } });
    expect(document.querySelector('.tm-panel-title')).toHaveTextContent('tableManagement.panelAlternates');
    expect(document.querySelector('.tm-alt-hint')).toBeInTheDocument();
  });

  it('o selo do cabeçalho também muda com a trava', async () => {
    await montar({ dia: { ...DIA, tables_locked: true } });
    expect(document.querySelector('.tm-badge-alt')).toHaveTextContent('tableManagement.badgeAlternate');
  });

  it('travar pede confirmação e avisa o resultado', async () => {
    await montar();
    await userEvent.click(document.querySelector('.tm-btn-lock'));
    expect(confirmar).toHaveBeenCalledWith('tableManagement.confirmLock', expect.anything());
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/tournament-days/d1/tables-lock'));
    expect(toast.success).toHaveBeenCalledWith('tableManagement.tablesLockedSuccess');
  });

  it('destravar usa a mensagem inversa', async () => {
    await montar({ dia: { ...DIA, tables_locked: true } });
    await userEvent.click(document.querySelector('.tm-btn-lock'));
    expect(confirmar).toHaveBeenCalledWith('tableManagement.confirmUnlock', expect.anything());
  });

  it('recusar a confirmação não trava', async () => {
    confirmar.mockResolvedValue(false);
    await montar();
    await userEvent.click(document.querySelector('.tm-btn-lock'));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.post).not.toHaveBeenCalled();
  });

  it('erro ao travar mostra o motivo', async () => {
    api.post.mockRejectedValue(erroHttp('Dia encerrado'));
    await montar();
    await userEvent.click(document.querySelector('.tm-btn-lock'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('tableManagement.errorToggleLock:Dia encerrado')
    );
  });
});

describe('mesas', () => {
  it('cada mesa mostra a própria ocupação', async () => {
    await montar();
    expect(within(mesaDoNumero(1)).getByText('1/3')).toBeInTheDocument();
    expect(within(mesaDoNumero(2)).getByText('0/3')).toBeInTheDocument();
  });

  it('mesa fechada é sinalizada', async () => {
    await montar({ mesas: [{ ...MESAS[0], status: 'closed' }], alocacoes: [] });
    expect(document.querySelector('.tm-badge-closed')).toHaveTextContent('tableManagement.badgeClosed');
  });

  it('mesa quebrada tem selo próprio', async () => {
    await montar({ mesas: [{ ...MESAS[0], status: 'broken' }], alocacoes: [] });
    expect(document.querySelector('.tm-badge-closed')).toHaveTextContent('tableManagement.badgeBroken');
  });

  it('assento de mesa inativa não recebe ninguém', async () => {
    // Sentar numa mesa fechada é a origem clássica do "jogador sumido".
    await montar({ mesas: [{ ...MESAS[0], status: 'closed' }], alocacoes: [] });
    const assento = assentos(mesaDoNumero(1))[0];
    expect(assento).toHaveClass('inactive');
    fireEvent.drop(assento, { dataTransfer: {} });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('criar UMA mesa continua a numeração', async () => {
    // Repetir um número de mesa deixaria dois "Mesa 2" no salão.
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.addTable' }));
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.addTablesButtonSingle' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tables/day/d1', { table_number: 3, seats: 9 })
    );
  });

  it('a primeira mesa do dia é a número 1', async () => {
    await montar({ mesas: [], alocacoes: [] });
    await userEvent.click(screen.getAllByRole('button', { name: 'tableManagement.addTable' })[0]);
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.addTablesButtonSingle' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tables/day/d1', { table_number: 1, seats: 9 })
    );
  });

  it('criar várias usa o endpoint em lote', async () => {
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.addTable' }));
    // O campo se corrige para 1 ao ficar vazio, entao digitar depois de
    // limpar produziria "14"; a troca direta do valor e o gesto real.
    const qtd = document.querySelectorAll('.tm-input')[0];
    fireEvent.change(qtd, { target: { value: '4' } });
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.addTablesButtonMulti:4' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tables/day/d1/bulk?count=4&seats=9')
    );
  });

  it('quantidade inválida vira 1, não zero', async () => {
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.addTable' }));
    const qtd = document.querySelectorAll('.tm-input')[0];
    await userEvent.clear(qtd);
    expect(qtd).toHaveValue(1);
  });

  it('assentos por mesa ficam entre 2 e 10', async () => {
    // Mesa de 1 assento ou de 30 não existe no salão.
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.addTable' }));
    const lugares = document.querySelectorAll('.tm-input')[1];
    await userEvent.clear(lugares);
    await userEvent.type(lugares, '30');
    expect(lugares).toHaveValue(10);
  });

  it('erro ao criar mesa mostra o motivo', async () => {
    api.post.mockRejectedValue(erroHttp('Limite do plano'));
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.addTable' }));
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.addTablesButtonSingle' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('tableManagement.errorAddTable:Limite do plano')
    );
  });

  it('mesa COM jogador não oferece remoção', async () => {
    // Apagar a mesa deixaria os jogadores em alocações órfãs.
    await montar();
    expect(within(mesaDoNumero(1)).queryByText('common.remove')).toBeNull();
    expect(within(mesaDoNumero(2)).getByText('common.remove')).toBeInTheDocument();
  });

  it('remover mesa vazia pede confirmação', async () => {
    await montar();
    await userEvent.click(within(mesaDoNumero(2)).getByText('common.remove'));
    expect(confirmar).toHaveBeenCalledWith(
      'tableManagement.confirmRemoveTable:2',
      expect.objectContaining({ variant: 'danger' })
    );
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/tables/m2'));
  });

  it('erro ao remover mostra o motivo', async () => {
    api.delete.mockRejectedValue(erroHttp('Mesa em uso'));
    await montar();
    await userEvent.click(within(mesaDoNumero(2)).getByText('common.remove'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('tableManagement.errorRemoveTable:Mesa em uso')
    );
  });

  it('fechar uma mesa muda o status para closed', async () => {
    await montar();
    await userEvent.click(within(mesaDoNumero(1)).getByText('tableManagement.close'));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/tables/m1', { status: 'closed' }));
  });

  it('reativar volta para active', async () => {
    await montar({ mesas: [{ ...MESAS[0], status: 'closed' }], alocacoes: [] });
    await userEvent.click(within(mesaDoNumero(1)).getByText('tableManagement.activate'));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/tables/m1', { status: 'active' }));
  });

  it('erro ao trocar o status avisa', async () => {
    api.patch.mockRejectedValue(erroHttp('Mesa travada'));
    await montar();
    await userEvent.click(within(mesaDoNumero(1)).getByText('tableManagement.close'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('tableManagement.errorToggleTableStatus:Mesa travada')
    );
  });
});

describe('alocar arrastando', () => {
  it('soltar num assento vazio aloca e emite o bilhete', async () => {
    // O bilhete é o papel que o jogador leva para achar a cadeira.
    await montar();
    await arrastarParaAssento('Beto', mesaDoNumero(2), 0);
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/allocations/day/d1/manual', {
        player_id: 'p2', table_id: 'm2', seat_number: 1,
      })
    );
    expect(await screen.findByTestId('bilhete')).toBeInTheDocument();
  });

  it('assento OCUPADO é recusado', async () => {
    // Dois jogadores na mesma cadeira não têm solução com a mesa montada.
    await montar();
    const ocupado = assentos(mesaDoNumero(1))[0];
    const cartao = Array.from(document.querySelectorAll('.tm-players-list > *'))
      .find((el) => el.textContent.includes('Beto'));
    fireEvent.dragStart(cartao, { dataTransfer: {} });
    fireEvent.drop(ocupado, { dataTransfer: {} });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('mover um jogador já sentado usa PATCH, não cria outra alocação', async () => {
    // Criar uma nova deixaria o jogador ocupando dois assentos.
    await montar();
    const jogadorSentado = document.querySelector('.tm-seat-player');
    fireEvent.dragStart(jogadorSentado, { dataTransfer: {} });
    fireEvent.drop(assentos(mesaDoNumero(2))[0], { dataTransfer: {} });
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/allocations/a1', { table_id: 'm2', seat_number: 1 })
    );
    expect(api.post).not.toHaveBeenCalled();
  });

  it('mover reemite o bilhete com o assento novo', async () => {
    await montar();
    fireEvent.dragStart(document.querySelector('.tm-seat-player'), { dataTransfer: {} });
    fireEvent.drop(assentos(mesaDoNumero(2))[0], { dataTransfer: {} });
    expect(await screen.findByTestId('bilhete-mesa')).toHaveTextContent('2');
  });

  it('arrastar de volta para a lista LIBERA o assento', async () => {
    // É como o staff tira alguém da mesa sem eliminar o jogador.
    await montar();
    fireEvent.dragStart(document.querySelector('.tm-seat-player'), { dataTransfer: {} });
    fireEvent.drop(document.querySelector('.tm-players-list'), { dataTransfer: {} });
    await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/allocations/a1'));
  });

  it('arrastar da lista para a lista não faz nada', async () => {
    await montar();
    const cartao = Array.from(document.querySelectorAll('.tm-players-list > *'))
      .find((el) => el.textContent.includes('Beto'));
    fireEvent.dragStart(cartao, { dataTransfer: {} });
    fireEvent.drop(document.querySelector('.tm-players-list'), { dataTransfer: {} });
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('erro ao alocar mostra o motivo', async () => {
    api.post.mockRejectedValue(erroHttp('Assento reservado'));
    await montar();
    await arrastarParaAssento('Beto', mesaDoNumero(2), 0);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('tableManagement.errorAllocate:Assento reservado')
    );
  });

  it('erro ao liberar o assento mostra o motivo', async () => {
    api.delete.mockRejectedValue(erroHttp('Alocação travada'));
    await montar();
    fireEvent.dragStart(document.querySelector('.tm-seat-player'), { dataTransfer: {} });
    fireEvent.drop(document.querySelector('.tm-players-list'), { dataTransfer: {} });
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('tableManagement.errorUnallocate:Alocação travada')
    );
  });
});

describe('bilhete de alternado', () => {
  it('quem está na fila pode receber um bilhete de alternado', async () => {
    // Com as mesas travadas ele não tem cadeira, mas precisa de um papel que
    // prove que pagou e está na fila.
    await montar({ dia: { ...DIA, tables_locked: true } });
    await userEvent.click(document.querySelectorAll('.tm-btn-print-alt')[0]);
    expect(await screen.findByTestId('bilhete-alternado')).toHaveTextContent('true');
    expect(screen.getByTestId('bilhete-jogador')).toHaveTextContent('Beto');
  });

  it('o bilhete de alternado não inventa mesa nem assento', async () => {
    await montar({ dia: { ...DIA, tables_locked: true } });
    await userEvent.click(document.querySelectorAll('.tm-btn-print-alt')[0]);
    expect(await screen.findByTestId('bilhete-mesa')).toHaveTextContent('-');
    expect(screen.getByTestId('bilhete-assento')).toHaveTextContent('-');
  });

  it('com as mesas abertas não há bilhete de alternado', async () => {
    await montar();
    expect(document.querySelector('.tm-btn-print-alt')).toBeNull();
  });

  it('fechar o bilhete o remove da tela', async () => {
    await montar({ dia: { ...DIA, tables_locked: true } });
    await userEvent.click(document.querySelectorAll('.tm-btn-print-alt')[0]);
    await screen.findByTestId('bilhete');
    await userEvent.click(document.querySelector('.tm-close-btn'));
    expect(screen.queryByTestId('bilhete')).toBeNull();
  });
});

describe('distribuição em lote', () => {
  const abrir = () => userEvent.click(screen.getByRole('button', { name: 'tableManagement.bulkAllocate' }));

  it('o modo salvo do dia já vem selecionado', async () => {
    // O modo é uma decisão do torneio, não de cada distribuição.
    await montar({ dia: { ...DIA, allocation_mode: 'random_balanced' } });
    await abrir();
    const cartoes = document.querySelectorAll('.tm-mode-card');
    expect(cartoes[2]).toHaveClass('selected');
  });

  it('sem modo salvo, o padrão é equilibrado', async () => {
    await montar();
    await abrir();
    expect(document.querySelectorAll('.tm-mode-card')[1]).toHaveClass('selected');
  });

  it('escolher outro modo troca a seleção', async () => {
    await montar();
    await abrir();
    const opcoes = screen.getAllByRole('button', { name: /modeSequentialLabel|modeBalancedLabel|modeRandomBalancedLabel/ });
    await userEvent.click(opcoes[0]);
    expect(opcoes[0]).toHaveClass('selected');
    expect(opcoes[0]).toHaveAttribute('aria-pressed', 'true');
  });

  it('dá para escolher o modo só pelo teclado', async () => {
    // Cada cartão era um <div> com onClick: o Tab passava reto por todos.
    await montar();
    await abrir();
    const opcoes = screen.getAllByRole('button', { name: /modeSequentialLabel|modeBalancedLabel|modeRandomBalancedLabel/ });
    opcoes[0].focus();
    await userEvent.keyboard('{Enter}');
    expect(opcoes[0]).toHaveAttribute('aria-pressed', 'true');
  });

  it('Esc fecha o modal de distribuição', async () => {
    await montar();
    await abrir();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(document.querySelector('.tm-mode-card')).toBeNull());
  });

  it('salvar o modo o persiste no dia, sem alocar ninguém', async () => {
    // O buy-in individual também usa esse modo; por isso ele é do DIA.
    await montar();
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.setMode' }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/tournament-days/d1', { allocation_mode: 'balanced' })
    );
    expect(api.post).not.toHaveBeenCalled();
  });

  it('distribuir persiste o modo ANTES de alocar', async () => {
    // Se só a distribuição usasse o modo, o próximo buy-in individual cairia
    // no modo antigo.
    await montar();
    await abrir();
    await userEvent.click(document.querySelectorAll('.tm-mode-card')[0]);
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.allocatePlayersButton:2' }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/tournament-days/d1', { allocation_mode: 'sequential' })
    );
    expect(api.post).toHaveBeenCalledWith('/allocations/day/d1/bulk', {
      mode: 'sequential', player_ids: [],
    });
  });

  it('sem ninguém para alocar o botão fica desabilitado', async () => {
    await montar({ semMesa: [] });
    await abrir();
    expect(screen.getByRole('button', { name: 'tableManagement.allocatePlayersButton:0' })).toBeDisabled();
  });

  it('erro ao distribuir mostra o motivo', async () => {
    api.post.mockRejectedValue(erroHttp('Sem assentos livres'));
    await montar();
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.allocatePlayersButton:2' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('tableManagement.errorBulkAllocate:Sem assentos livres')
    );
  });

  it('erro ao salvar o modo mostra o motivo', async () => {
    api.patch.mockRejectedValue(erroHttp('Dia encerrado'));
    await montar();
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.setMode' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('tableManagement.errorSaveMode:Dia encerrado')
    );
  });

  it('cancelar fecha sem distribuir', async () => {
    await montar();
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(document.querySelector('.tm-mode-card')).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });
});
