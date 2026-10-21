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
import { offlineWrite } from '../offline/apiOffline';

jest.mock('../offline/apiOffline', () => ({ offlineWrite: jest.fn() }));
jest.mock('../offline/db', () => ({ uuid: () => 'mut-fixa' }));
jest.mock('../offline/domainRules', () => ({ applyEliminate: jest.fn(), applyUneliminate: jest.fn() }));
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
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: () => ({ formatCurrency: (v) => `S/ ${Number(v).toFixed(2)}` }) }));
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
  torneio = { id: 't1', name: 'Main Event' }, inscritos = [],
} = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/tournament-days/d1') {
      return dia instanceof Error ? Promise.reject(dia) : Promise.resolve({ data: dia });
    }
    if (url === '/tables/day/d1') return Promise.resolve({ data: mesas });
    if (url === '/allocations/day/d1') return Promise.resolve({ data: alocacoes });
    if (url === '/allocations/day/d1/unallocated') return Promise.resolve({ data: semMesa });
    if (url === '/tournaments/t1') return Promise.resolve({ data: torneio });
    if (url === '/tournament-players/day/d1') return Promise.resolve({ data: inscritos });
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

// Uma mesa em edição de número não mostra o título; ela simplesmente não casa.
const mesaDoNumero = (n) =>
  Array.from(document.querySelectorAll('.tm-table')).find((el) =>
    el.querySelector('.tm-table-num')?.textContent.includes(`:${n}`)
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
      expect(api.post).toHaveBeenCalledWith('/tables/day/d1/bulk?count=4&seats=9&start_number=3')
    );
  });

  it('quantidade inválida vira 1, não zero', async () => {
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.addTable' }));
    const qtd = document.querySelectorAll('.tm-input')[0];
    await userEvent.clear(qtd);
    expect(qtd).toHaveValue(1);
  });

  it('assentos por mesa não têm teto: a mesa de 12 vai como 12', async () => {
    // O salão monta mesa de 11 na final, de 12 em evento especial. O teto
    // de 10 que existia aqui (e no banco) transformava "12" em 10 calado.
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.addTable' }));
    const lugares = document.querySelectorAll('.tm-input')[1];
    fireEvent.change(lugares, { target: { value: '12' } });
    expect(lugares).toHaveValue(12);
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.addTablesButtonSingle' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tables/day/d1', { table_number: 3, seats: 12 })
    );
  });

  it('digitar "12" assento a assento não vira "22"', async () => {
    // Corrigir a cada tecla fazia o 1 virar 2 (mínimo) antes do 2 chegar.
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.addTable' }));
    const lugares = document.querySelectorAll('.tm-input')[1];
    await userEvent.clear(lugares);
    await userEvent.type(lugares, '12');
    expect(lugares).toHaveValue(12);
  });

  it('mesa de 1 assento vira 2 ao sair do campo; vazio volta a 9', async () => {
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.addTable' }));
    const lugares = document.querySelectorAll('.tm-input')[1];
    fireEvent.change(lugares, { target: { value: '1' } });
    fireEvent.blur(lugares);
    expect(lugares).toHaveValue(2);
    fireEvent.change(lugares, { target: { value: '' } });
    fireEvent.blur(lugares);
    expect(lugares).toHaveValue(9);
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

describe('jogador no assento', () => {
  /* Pedido do NSOP: o nome aparece no assento sem passar o cursor (o floor
     acha o jogador mais rápido) e, para quem veio do classificatório, as
     fichas com que se classificou. */
  const seatDaAna = () => assentos(mesaDoNumero(1))[0];

  it('mostra o nome no assento, sem depender do title', async () => {
    await montar();
    expect(within(seatDaAna()).getByText('Ana')).toHaveClass('tm-seat-name');
  });

  it('classificado mostra as fichas com que se classificou', async () => {
    await montar({ inscritos: [
      { id: 'tp-a', player_id: 'p1', player_name: 'Ana', status: 'active',
        is_qualified_entry: true, total_chips: 763800 },
    ] });
    const fichas = await within(seatDaAna()).findByText((763800).toLocaleString('pt-BR'));
    expect(fichas).toHaveAttribute('title', 'tableManagement.qualifiedChips');
  });

  it('entrada comum (buy-in) não mostra fichas', async () => {
    await montar({ inscritos: [
      { id: 'tp-a', player_id: 'p1', player_name: 'Ana', status: 'active',
        is_qualified_entry: false, total_chips: 20000 },
    ] });
    await waitFor(() => expect(within(seatDaAna()).getByText('Ana')).toBeInTheDocument());
    expect(seatDaAna().querySelector('.tm-seat-chips')).toBeNull();
  });
});

describe('mesas na TV', () => {
  /* O floor liga o quadro de mesas e assentos numa TV do salão pelo código
     do dia (o mesmo do relógio): a tela mostra o código e o link direto. */
  it('mostra o código do dia e o link do quadro de mesas', async () => {
    await montar();
    const base = api.get.getMockImplementation();
    api.get.mockImplementation((url, ...resto) => (
      url === '/tournament-days/d1/broadcast-code'
        ? Promise.resolve({ data: { code: 'ABC234' } })
        : base(url, ...resto)
    ));
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.seatingTv' }));
    expect(await screen.findByText('ABC234')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'tv.openSeating' })).toHaveAttribute('href', '/tv/ABC234/mesas');
    // Clicar de novo esconde.
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.seatingTv' }));
    expect(screen.queryByText('ABC234')).toBeNull();
  });

  it('falha ao gerar o código vira aviso', async () => {
    await montar();
    const base = api.get.getMockImplementation();
    api.get.mockImplementation((url, ...resto) => (
      url === '/tournament-days/d1/broadcast-code' ? Promise.reject(new Error('x')) : base(url, ...resto)
    ));
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.seatingTv' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('tv.codeError'));
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


describe('eliminar no assento (modo por mesa)', () => {
  /** "Por posição nas mesas": o diretor elimina o jogador na cadeira. O
   *  servidor marca a eliminação, soma no contador que a TV lê e libera a
   *  cadeira — pela inscrição DO DIA, nunca a de outro dia do torneio. */
  const POR_MESA = { id: 't1', name: 'Main Event', elimination_mode: 'table' };
  const INSCRITOS = [
    { id: 'tp-a', player_id: 'p1', player_name: 'Ana', status: 'active' },
    { id: 'tp-z', player_id: 'p9', player_name: 'Zeca', status: 'eliminated',
      eliminated_at: '2026-06-08T22:00:00Z' },
  ];

  beforeEach(() => {
    offlineWrite.mockReset();
    offlineWrite.mockResolvedValue({ offline: false, data: {} });
  });

  it('em massa, o assento não tem botão de eliminar', async () => {
    await montar({ inscritos: INSCRITOS });
    expect(screen.queryByRole('button', { name: /tableManagement.eliminatePlayer/ })).toBeNull();
    expect(screen.queryByText('tableManagement.panelEliminated')).toBeNull();
  });

  it('por mesa, o ✕ elimina pela inscrição do dia', async () => {
    await montar({ torneio: POR_MESA, inscritos: INSCRITOS });
    await userEvent.click(await screen.findByRole('button', { name: 'tableManagement.eliminatePlayer: Ana' }));
    expect(confirmar).toHaveBeenCalledWith(
      'tableManagement.confirmEliminate:Ana', expect.objectContaining({ variant: 'danger' })
    );
    await waitFor(() =>
      expect(offlineWrite).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'eliminate', url: '/tournament-players/tp-a/eliminate',
      }))
    );
    expect(toast.success).toHaveBeenCalledWith('tableManagement.eliminatedSuccess:Ana');
  });

  it('desistir da confirmação não elimina', async () => {
    confirmar.mockResolvedValue(false);
    await montar({ torneio: POR_MESA, inscritos: INSCRITOS });
    await userEvent.click(await screen.findByRole('button', { name: 'tableManagement.eliminatePlayer: Ana' }));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(offlineWrite).not.toHaveBeenCalled();
  });

  it('jogador sem inscrição no dia não é eliminado às cegas', async () => {
    await montar({ torneio: POR_MESA, inscritos: [] });
    await userEvent.click(await screen.findByRole('button', { name: 'tableManagement.eliminatePlayer: Ana' }));
    expect(toast.error).toHaveBeenCalled();
    expect(offlineWrite).not.toHaveBeenCalled();
  });

  it('o painel lista os eliminados e desfaz a eliminação lançada por engano', async () => {
    await montar({ torneio: POR_MESA, inscritos: INSCRITOS });
    expect(await screen.findByText('Zeca')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.undoElimination: Zeca' }));
    await waitFor(() =>
      expect(offlineWrite).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'restore', url: '/tournament-players/tp-z/uneliminate',
      }))
    );
  });

  it('recusa do servidor chega ao diretor', async () => {
    const recusa = new Error('409');
    recusa.userMessage = 'Este jogador já está eliminado.';
    offlineWrite.mockRejectedValue(recusa);
    await montar({ torneio: POR_MESA, inscritos: INSCRITOS });
    await userEvent.click(await screen.findByRole('button', { name: 'tableManagement.eliminatePlayer: Ana' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Este jogador já está eliminado.'));
  });
});

describe('número da mesa', () => {
  // O número é o rótulo da mesa FÍSICA no salão. O app sugere o próximo
  // livre, mas quem manda é o operador: o salão pode já ter as mesas 1-4
  // de outro evento, ou a mesa 7 pode ter virado a 3 depois de um quebra.

  it('o número vem sugerido como o próximo livre e pode ser trocado', async () => {
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.addTable' }));
    const numero = document.querySelectorAll('.tm-input')[2];
    expect(numero).toHaveValue(3);
    fireEvent.change(numero, { target: { value: '7' } });
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.addTablesButtonSingle' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tables/day/d1', { table_number: 7, seats: 9 })
    );
  });

  it('o lote começa no número escolhido', async () => {
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.addTable' }));
    const campos = document.querySelectorAll('.tm-input');
    fireEvent.change(campos[0], { target: { value: '3' } });
    fireEvent.change(campos[2], { target: { value: '10' } });
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.addTablesButtonMulti:3' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tables/day/d1/bulk?count=3&seats=9&start_number=10')
    );
  });

  it('número vazio ao gravar volta ao próximo livre', async () => {
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.addTable' }));
    fireEvent.change(document.querySelectorAll('.tm-input')[2], { target: { value: '' } });
    await userEvent.click(screen.getByRole('button', { name: 'tableManagement.addTablesButtonSingle' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/tables/day/d1', { table_number: 3, seats: 9 })
    );
  });

  const abrirTroca = async (n) => {
    const mesa = mesaDoNumero(n);
    await userEvent.click(within(mesa).getByRole('button', { name: 'tableManagement.renameTable' }));
    const campo = within(mesa).getByRole('spinbutton', { name: 'tableManagement.tableNumberLabel' });
    return { mesa, campo };
  };

  it('mudar o número de uma mesa grava e avisa', async () => {
    await montar();
    const { mesa, campo } = await abrirTroca(2);
    expect(campo).toHaveValue(2);
    fireEvent.change(campo, { target: { value: '5' } });
    await userEvent.click(within(mesa).getByRole('button', { name: 'common.save' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/tables/m2', { table_number: 5 }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('tableManagement.tableRenamedSuccess:2,5')
    );
  });

  it('Enter no campo também grava', async () => {
    await montar();
    const { campo } = await abrirTroca(2);
    fireEvent.change(campo, { target: { value: '8' } });
    fireEvent.submit(campo.closest('form'));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/tables/m2', { table_number: 8 }));
  });

  it('número já usado mostra o motivo e mantém a edição aberta', async () => {
    // Duas "Mesa 1" no mesmo dia mandariam o jogador para a cadeira errada;
    // a API recusa e o operador corrige sem recomeçar.
    api.patch.mockRejectedValue(erroHttp('Já existe uma mesa com este número neste dia.'));
    await montar();
    const { mesa, campo } = await abrirTroca(2);
    fireEvent.change(campo, { target: { value: '1' } });
    await userEvent.click(within(mesa).getByRole('button', { name: 'common.save' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'tableManagement.errorRenameTable:Já existe uma mesa com este número neste dia.'
      )
    );
    expect(within(mesa).getByRole('spinbutton', { name: 'tableManagement.tableNumberLabel' })).toHaveValue(1);
  });

  it('a recusa com código usa a frase já traduzida pelo interceptor', async () => {
    const erro = erroHttp({ code: 'numero_de_mesa_repetido', message: 'Já existe' });
    erro.userMessage = 'Traduzida';
    api.patch.mockRejectedValue(erro);
    await montar();
    const { mesa, campo } = await abrirTroca(2);
    fireEvent.change(campo, { target: { value: '1' } });
    await userEvent.click(within(mesa).getByRole('button', { name: 'common.save' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('tableManagement.errorRenameTable:Traduzida')
    );
  });

  it('Esc cancela sem chamar a API', async () => {
    await montar();
    const { mesa, campo } = await abrirTroca(2);
    fireEvent.change(campo, { target: { value: '9' } });
    fireEvent.keyDown(campo, { key: 'Escape' });
    expect(within(mesa).queryByRole('spinbutton')).toBeNull();
    expect(within(mesa).getByText('tableManagement.tableTitle:2')).toBeInTheDocument();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('cancelar pelo botão também não chama a API', async () => {
    await montar();
    const { mesa } = await abrirTroca(2);
    await userEvent.click(within(mesa).getByRole('button', { name: 'common.cancel' }));
    expect(within(mesa).queryByRole('spinbutton')).toBeNull();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('gravar o mesmo número só fecha a edição', async () => {
    await montar();
    const { mesa } = await abrirTroca(2);
    await userEvent.click(within(mesa).getByRole('button', { name: 'common.save' }));
    expect(within(mesa).queryByRole('spinbutton')).toBeNull();
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('número zero ou vazio é recusado antes de ir à API', async () => {
    await montar();
    const { mesa, campo } = await abrirTroca(2);
    fireEvent.change(campo, { target: { value: '0' } });
    await userEvent.click(within(mesa).getByRole('button', { name: 'common.save' }));
    expect(toast.warning).toHaveBeenCalledWith('tableManagement.invalidTableNumber');
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('só uma mesa entra em edição por vez', async () => {
    await montar();
    await abrirTroca(1);
    const { mesa: segunda } = await abrirTroca(2);
    expect(within(mesaDoNumero(1)).queryByRole('spinbutton')).toBeNull();
    expect(within(segunda).getByRole('spinbutton')).toBeInTheDocument();
  });
});

describe('ativar e desativar assento', () => {
  // Cadeira quebrada, lugar encostado na parede: o assento sai de circulação
  // sem mudar o tamanho da mesa, e ninguém é alocado nele.
  const MESA_1_SEM_O_2 = { ...MESAS[0], blocked_seats: [2] };
  const botao = (mesa, nome) => within(mesa).queryByRole('button', { name: nome });

  it('desativar um assento vazio manda o comando e recarrega', async () => {
    await montar();
    const chamadasAntes = api.get.mock.calls.length;
    await userEvent.click(botao(mesaDoNumero(2), 'tableManagement.disableSeat:1'));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/tables/m2/seats/1', { active: false }));
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(chamadasAntes));
  });

  it('assento desativado aparece riscado e oferece reativar', async () => {
    await montar({ mesas: [MESA_1_SEM_O_2, MESAS[1]] });
    const assento = assentos(mesaDoNumero(1))[1];
    expect(assento).toHaveClass('blocked');
    expect(assento).toHaveTextContent('tableManagement.seatDisabled');
    await userEvent.click(botao(mesaDoNumero(1), 'tableManagement.enableSeat:2'));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/tables/m1/seats/2', { active: true }));
  });

  it('assento desativado não recebe jogador arrastado', async () => {
    await montar({ mesas: [MESA_1_SEM_O_2, MESAS[1]] });
    await arrastarParaAssento('Beto', mesaDoNumero(1), 1);
    expect(api.post).not.toHaveBeenCalled();
  });

  it('assento ocupado não oferece desativar', async () => {
    // O jogador ficaria numa cadeira que o sistema diz não existir.
    await montar();
    expect(botao(mesaDoNumero(1), 'tableManagement.disableSeat:1')).toBeNull();
    expect(botao(mesaDoNumero(1), 'tableManagement.disableSeat:2')).not.toBeNull();
  });

  it('mesa fechada não oferece desativar assento', async () => {
    await montar({ mesas: [MESAS[0], { ...MESAS[1], status: 'closed' }] });
    expect(within(mesaDoNumero(2)).queryAllByRole('button', { name: /disableSeat/ })).toEqual([]);
  });

  it('ocupação da mesa e do dia contam só os assentos ativos', async () => {
    // Mesa 1: 3 lugares, 1 desativado, 1 ocupado → 1/2. Dia: 2 + 3 = 5.
    await montar({ mesas: [MESA_1_SEM_O_2, MESAS[1]] });
    expect(within(mesaDoNumero(1)).getByText('1/2')).toBeInTheDocument();
    expect(document.querySelector('.tm-subtitle')).toHaveTextContent('Dia 1A,1,5');
  });

  it('recusa da API mostra o motivo', async () => {
    api.patch.mockRejectedValue(erroHttp('Este lugar já está ocupado.'));
    await montar();
    await userEvent.click(botao(mesaDoNumero(2), 'tableManagement.disableSeat:3'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('tableManagement.errorToggleSeat:Este lugar já está ocupado.')
    );
  });

  it('recusa com código usa a frase já traduzida pelo interceptor', async () => {
    const erro = erroHttp({ code: 'assento_ocupado', message: 'Este lugar já está ocupado.' });
    erro.userMessage = 'Este puesto ya está ocupado.';
    api.patch.mockRejectedValue(erro);
    await montar();
    await userEvent.click(botao(mesaDoNumero(2), 'tableManagement.disableSeat:3'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('tableManagement.errorToggleSeat:Este puesto ya está ocupado.')
    );
  });
});

describe('torneio KO: quem eliminou', () => {
  /** Em torneio com premiação por eliminação o ✕ pergunta QUEM eliminou (a
   *  pergunta já é a confirmação) e, online, mostra o KO para pagar na hora. */
  const PKO = { id: 't1', name: 'START UP PKO', elimination_mode: 'table', ko_format: 'pko', ko_percentage: 40 };
  const ALOC_KO = [
    { id: 'a1', table_id: 'm1', seat_number: 1, player_id: 'p1', players: { name: 'Ana' } },
    { id: 'a2', table_id: 'm1', seat_number: 2, player_id: 'p2', players: { name: 'Bruno' } },
    { id: 'a3', table_id: 'm2', seat_number: 1, player_id: 'p3', players: { name: 'Carla' } },
  ];
  const INSC_KO = [
    { id: 'tp-a', player_id: 'p1', player_name: 'Ana', status: 'active' },
    { id: 'tp-b', player_id: 'p2', player_name: 'Bruno', status: 'active' },
    { id: 'tp-c', player_id: 'p3', player_name: 'Carla', status: 'active' },
  ];
  const KNOCKOUT = {
    id: 'k1', format: 'pko', eliminated_name: 'Ana', bounty_value: '100.00',
    payouts: [{ id: 'po1', eliminator_player_id: 'p2', eliminator_name: 'Bruno', cash_amount: '50.00', added_to_bounty: '50.00', paid: false }],
  };

  const montarKo = async (torneio = PKO) => {
    responder({ torneio, alocacoes: ALOC_KO, inscritos: INSC_KO });
    const base = api.get.getMockImplementation();
    api.get.mockImplementation((url, ...resto) => (
      url === '/tournaments/t1/knockouts/summary'
        ? Promise.resolve({ data: { bounties: [{ tournament_player_id: 'tp-a', bounty: '150.00' }] } })
        : base(url, ...resto)
    ));
    render(<MemoryRouter><TableManagement /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
  };

  beforeEach(() => {
    offlineWrite.mockReset();
    offlineWrite.mockResolvedValue({ offline: false, data: { knockout: KNOCKOUT } });
    toast.info = jest.fn();
  });

  it('o assento mostra o bounty atual do jogador', async () => {
    await montarKo();
    expect(await screen.findByText('S/ 150.00')).toBeInTheDocument();
  });

  it('o ✕ pergunta quem eliminou e manda a resposta com o id da mutação', async () => {
    await montarKo();
    await userEvent.click(await screen.findByRole('button', { name: 'tableManagement.eliminatePlayer: Ana' }));
    const dialogo = await screen.findByRole('dialog');
    expect(confirmar).not.toHaveBeenCalled();
    // A mesma mesa da vítima vem primeiro.
    const nomes = within(dialogo).getAllByRole('checkbox').map((c) => c.closest('label').textContent);
    expect(nomes[0]).toContain('Bruno');
    await userEvent.click(within(dialogo).getByRole('checkbox', { name: /Bruno/ }));
    await userEvent.click(within(dialogo).getByRole('button', { name: 'ko.confirmEliminate' }));
    await waitFor(() => expect(offlineWrite).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'eliminate',
      url: '/tournament-players/tp-a/eliminate',
      clientMutationId: 'mut-fixa',
      body: { tournament_player_id: 'tp-a', client_mutation_id: 'mut-fixa', eliminated_by: ['tp-b'], no_eliminator: false },
    })));
    // Online: o KO aparece para pagar na hora.
    expect(await screen.findByText('ko.registeredTitle')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ko.payNow' })).toBeInTheDocument();
  });

  it('offline: avisa que o pagamento fica pendente', async () => {
    offlineWrite.mockResolvedValue({ offline: true, data: { ok: true } });
    await montarKo();
    await userEvent.click(await screen.findByRole('button', { name: 'tableManagement.eliminatePlayer: Ana' }));
    const dialogo = await screen.findByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('checkbox', { name: /ko.noEliminator/ }));
    await userEvent.click(within(dialogo).getByRole('button', { name: 'ko.confirmEliminate' }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('ko.offlinePending')));
    expect(screen.queryByText('ko.registeredTitle')).toBeNull();
  });

  it('fase Mystery iniciada depois de a tela abrir: o servidor pede o eliminador e a tela pergunta', async () => {
    await montarKo({ ...PKO, ko_format: 'mystery' });
    offlineWrite.mockRejectedValueOnce(erroHttp({ code: 'eliminador_obrigatorio', message: 'Informe quem eliminou.' }));
    await userEvent.click(await screen.findByRole('button', { name: 'tableManagement.eliminatePlayer: Ana' }));
    // Mystery antes da fase: confirmação comum, sem pergunta.
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
