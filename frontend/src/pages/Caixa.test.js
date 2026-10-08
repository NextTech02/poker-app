/**
 * Caixa — a tela onde o dinheiro entra.
 *
 * É a operação mais repetida da noite e a que menos pode errar. Três coisas
 * concentram o risco e por isso concentram os testes:
 *
 * 1. **O valor cobrado.** Ele vem da configuração do DIA, não do torneio — um
 *    Dia 1A de 1000 e um torneio de 500 são números diferentes, e cobrar o do
 *    torneio é cobrar errado do jogador na frente dele.
 * 2. **O bilhete.** Todo registro precisa terminar num bilhete: com mesa e
 *    assento se houve alocação, como *alternado* se não houve. Um registro sem
 *    bilhete é um jogador que pagou e não sabe onde sentar.
 * 3. **O caixa modular.** Se o operador não abriu o caixa dele, nada pode ser
 *    lançado — senão o dinheiro entra num caixa que não existe e a conferência
 *    do fim da noite não fecha.
 *
 * A tela também opera sem internet: a escrita vai para a fila com id gerado no
 * cliente (idempotência) e o bilhete sai como alternado, porque quem aloca o
 * assento é o servidor, no sync.
 */
import { render, screen, waitFor, fireEvent, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Caixa from './Caixa';
import api from '../config/api';
import { offlineWrite, offlineRead } from '../offline/apiOffline';
import { isOnline, subscribe as assinarConectividade } from '../offline/connectivity';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { usePaymentMethods } from '../contexts/PaymentMethodsContext';
import { useBuyTypes } from '../contexts/BuyTypesContext';
import { useStage } from '../contexts/StageContext';
import { usePermissions } from '../contexts/PermissionContext';
import { CAIXA_MUDOU } from '../utils/eventosDoCaixa';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../offline/apiOffline', () => ({ offlineWrite: jest.fn(), offlineRead: jest.fn() }));
jest.mock('../offline/connectivity', () => ({
  isOnline: jest.fn(() => true),
  subscribe: jest.fn(() => () => {}),
}));
/** Simula o heartbeat avisando a tela que a rede caiu ou voltou. */
const mudarConectividade = (online) => {
  isOnline.mockReturnValue(online);
  const ouvinte = assinarConectividade.mock.calls.at(-1)[0];
  act(() => ouvinte(online));
};
jest.mock('../offline/domainRules', () => ({
  applyRegister: jest.fn(), applyRebuy: jest.fn(), applyAddon: jest.fn(),
}));
jest.mock('../offline/db', () => {
  let n = 0;
  return {
    uuid: () => `uuid-${++n}`,
    putEntities: jest.fn(),
    getEntity: jest.fn(),
    getAllByTable: jest.fn(async () => []),
  };
});
jest.mock('../hooks/usePolling', () => ({ usePolling: jest.fn() }));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../components/PlayerSelect', () => ({ value, onChange, name, allowedIds }) => (
  <select
    aria-label="jogador"
    data-permitidos={Array.isArray(allowedIds) ? allowedIds.join(',') : 'todos'}
    value={value}
    onChange={(e) => onChange({ target: { name: name || 'player_id', value: e.target.value } })}
  >
    <option value="">—</option>
    <option value="p1">Ana</option>
    <option value="p2">Beto</option>
  </select>
));
jest.mock('../components/SeatTicket', () => ({ allocation, onPrint }) => (
  <div data-testid="bilhete">
    <span data-testid="bilhete-jogador">{allocation.player_name}</span>
    <span data-testid="bilhete-mesa">{allocation.table_number ?? '-'}</span>
    <span data-testid="bilhete-assento">{allocation.seat_number ?? '-'}</span>
    <span data-testid="bilhete-alternado">{String(!!allocation.is_alternate)}</span>
    <button onClick={onPrint}>imprimir</button>
  </div>
));
// O banner do caixa modular informa a tela sobre o caixa do operador; o teste
// controla esse estado para exercitar o bloqueio.
const mockCaixa = { valor: null };
jest.mock('../components/CashboxBanner', () => {
  const React = require('react');
  return ({ onStateChange }) => {
    React.useEffect(() => onStateChange(mockCaixa.valor));
    return <div data-testid="banner-caixa" />;
  };
});
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('../contexts/PaymentMethodsContext', () => ({ usePaymentMethods: jest.fn() }));
jest.mock('../contexts/BuyTypesContext', () => ({ useBuyTypes: jest.fn() }));
jest.mock('../contexts/StageContext', () => ({ useStage: jest.fn() }));
jest.mock('../contexts/PermissionContext', () => ({ usePermissions: jest.fn() }));
jest.mock('react-i18next', () => {
  const t = (chave, segundo) => {
    if (typeof segundo === 'string') return segundo;
    if (segundo && typeof segundo === 'object') return `${chave}:${Object.values(segundo).join(',')}`;
    return chave;
  };
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const TORNEIO = {
  id: 't1', name: 'Main Event', buy_in: 500, rebuy: 300, addon: 200,
  allocation_type: 'manual',
};

const DIA = {
  id: 'd1', day_name: 'Dia 1A', status: 'active', day_type: 'starting',
  buy_in: 1000, rebuy_amount: 600, addon_amount: 400,
  registered_players: 10, max_players: 100, allocation_type: 'manual',
};

const DIAS = [
  DIA,
  { ...DIA, id: 'd2', day_name: 'Dia 2', status: 'completed' },
  { ...DIA, id: 'd3', day_name: 'Final', day_type: 'final' },
];

const TRANSACOES = [
  { id: 'x1', player_name: 'Ana', player_nickname: 'Aninha', tournament_name: 'Main Event',
    type: 'buy_in', amount: 1000, created_at: '2026-06-08T20:00:00Z',
    tournament_id: 't1', player_id: 'p1' },
  { id: 'x2', player_name: 'Beto', tournament_name: 'Main Event',
    type: 'rebuy', amount: 600, created_at: '2026-06-08T21:00:00Z',
    tournament_id: 't1', player_id: 'p2' },
  { id: 'x3', player_name: 'Carla', tournament_name: 'Main Event',
    type: 'addon', amount: 400, created_at: '2026-06-08T22:00:00Z',
    tournament_id: 't1', player_id: 'p3' },
];

const JOGADOR_TORNEIO = { id: 'tp1', player_id: 'p1', tournament_id: 't1', status: 'active' };

// Os meios de entrada são a fonte da categoria, do VALOR, do rake e das FICHAS
// por transação — quando existem. Sem nenhum à mão a tela CONTINUA vendendo,
// pela categoria e com o valor/rake do dia. Eles pertencem ao DIA: o cenário
// padrão tem um de cada categoria mais o "Rebuy duplo", que é o caso que fez a
// mudança existir — ele tem preço e fichas próprios, e NÃO é rebuy × 2.
const TIPOS = [
  { id: 'b1', name: 'Entrada normal', category: 'buy_in', amount: 1000, rake_percentage: 20, chips: 30000, active: true },
  { id: 'b2', name: 'Recompra turbo', category: 'rebuy', amount: 600, rake_percentage: 10, chips: 30000, active: true },
  { id: 'b3', name: 'Add-on padrão', category: 'addon', amount: 400, rake_percentage: 15, chips: 15000, active: true },
  { id: 'b4', name: 'Rebuy duplo', category: 'rebuy', amount: 1500, rake_percentage: 10, chips: 70000, active: true },
];

const ETAPA = { id: 'e1', name: 'Etapa Rio' };

/** Mesa ativa: o estado normal de um dia já configurado. */
const MESA = { id: 'm1', table_number: 1, seats: 9, status: 'active' };

/** Dia com assento automático — o único modo em que faltar mesa vira bilhete. */
const DIA_AUTO = { ...DIA, allocation_type: 'automatic' };

let toast;
/** O Caixa avisa o contexto qual TORNEIO carregar; o espião confere esse aviso. */
let selectTournament;

const responder = ({
  transacoes = TRANSACOES,
  torneios = [TORNEIO],
  dias = DIAS,
  credito = 0,
  alocacoes = [],
  mesas = [MESA],
  etapa = { id: 'e1', sales_blocked: false },
} = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/transactions') {
      return transacoes instanceof Error ? Promise.reject(transacoes) : Promise.resolve({ data: transacoes });
    }
    if (url.startsWith('/stages/')) return Promise.resolve({ data: etapa });
    if (url.startsWith('/tournaments')) {
      return torneios instanceof Error ? Promise.reject(torneios) : Promise.resolve({ data: torneios });
    }
    if (url === '/players') return Promise.resolve({ data: [{ id: 'p1', name: 'Ana' }] });
    if (url.startsWith('/tournament-days/tournament/')) {
      return dias instanceof Error ? Promise.reject(dias) : Promise.resolve({ data: dias });
    }
    if (url.startsWith('/player-credits/')) return Promise.resolve({ data: { available_credit: credito } });
    if (url.startsWith('/players/')) return Promise.resolve({ data: { name: 'Ana' } });
    if (url.startsWith('/allocations/tournament/')) return Promise.resolve({ data: alocacoes });
    if (url.startsWith('/tables/')) {
      return mesas instanceof Error ? Promise.reject(mesas) : Promise.resolve({ data: mesas });
    }
    return Promise.resolve({ data: [] });
  });
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<Caixa />);
  // O titulo do cartao aparece JUNTO com o esqueleto; esperar por ele deixaria
  // o teste consultando a tela ainda em carregamento.
  await esperarCarga();
};

const esperarCarga = () =>
  waitFor(() => expect(document.querySelector('.skeleton-row')).toBeNull());

/** Os quatro indicadores do topo, na ordem: buy-in, rebuy, add-on, total. */
const indicadores = () =>
  Array.from(document.querySelectorAll('.stat-info h3')).map((e) => e.textContent);

const abrirModal = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'cashRegister.newTransaction' }));
  return screen.getByRole('button', { name: 'cashRegister.register' });
};

/** Espera os dias do torneio chegarem e escolhe um. Torneio de dia único
 *  entra com o dia já escolhido (linha "dia-unico", sem seletor); só o
 *  multi-day mostra o seletor. */
const escolherDia = async (dia) => {
  await waitFor(() =>
    expect(screen.queryByLabelText('cashRegister.day') || screen.queryByTestId('dia-unico')).not.toBeNull()
  );
  const seletor = screen.queryByLabelText('cashRegister.day');
  if (seletor) await userEvent.selectOptions(seletor, dia);
};

/** Preenche torneio → dia → jogador → meio de entrada, a ordem real de uso. */
const preencher = async ({ dia = 'd1', jogador = 'p1', tipo = 'b1' } = {}) => {
  await userEvent.selectOptions(screen.getByLabelText('cashRegister.tournament'), 't1');
  if (dia) await escolherDia(dia);
  if (jogador) await userEvent.selectOptions(screen.getByLabelText('jogador'), jogador);
  if (tipo) await userEvent.selectOptions(screen.getByLabelText('Meio de entrada'), tipo);
};

/** Sem meios de entrada cadastrados, o campo é "Categoria". */
const porCategoria = async (categoria) => {
  await userEvent.selectOptions(screen.getByLabelText('cashRegister.tournament'), 't1');
  await escolherDia('d1');
  await userEvent.selectOptions(screen.getByLabelText('jogador'), 'p1');
  await userEvent.selectOptions(screen.getByLabelText('Categoria'), categoria);
};

/** Dois dias que ainda vendem — é o caso em que o seletor aparece. */
const DOIS_DIAS = [DIA, { ...DIA, id: 'd1b', day_name: 'Dia 1B' }];

const enviar = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'cashRegister.register' }));
};

const chamada = (trecho) => offlineWrite.mock.calls.find((c) => c[0].url.includes(trecho));

beforeEach(() => {
  mockCaixa.valor = null;
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  useToast.mockReturnValue({ toast });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  usePaymentMethods.mockReturnValue({ activeMethods: [] });
  selectTournament = jest.fn();
  useBuyTypes.mockReturnValue({
    activeBuyTypes: TIPOS, tournamentId: 't1', tiposCarregados: true, selectTournament,
  });
  useStage.mockReturnValue({ selectedStage: ETAPA });
  usePermissions.mockReturnValue({ isAdmin: true, hasPermission: () => true });
  isOnline.mockReturnValue(true);
  assinarConectividade.mockReturnValue(() => {});
  offlineWrite.mockResolvedValue({ offline: false, data: { id: 'tp1' } });
  offlineRead.mockResolvedValue([JOGADOR_TORNEIO]);
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('carga da tela', () => {
  it('mostra o esqueleto antes dos dados', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Caixa />);
    expect(document.querySelectorAll('.skeleton-stat-card').length).toBe(4);
  });

  it('lista as transações do dia', async () => {
    await montar();
    expect(document.querySelector('.transactions-table tbody')).toHaveTextContent('Ana');
    expect(screen.getByText('(Aninha)')).toBeInTheDocument();
  });

  it('sem transação nenhuma explica o que fazer', async () => {
    await montar({ transacoes: [] });
    expect(screen.getByText('cashRegister.noTransactions')).toBeInTheDocument();
  });

  it('uma consulta que falha não derruba as outras', async () => {
    // ISSUE-004: as três chamadas são independentes; um 503 nos torneios não
    // pode apagar o extrato que já carregou.
    await montar({ torneios: new Error('503') });
    expect(document.querySelector('.transactions-table tbody')).toHaveTextContent('Ana');
  });

  it('lista vazia por falha não vira lista vazia silenciosa de torneios', async () => {
    await montar({ transacoes: new Error('503') });
    expect(screen.getByText('cashRegister.noTransactions')).toBeInTheDocument();
  });
});

describe('totais', () => {
  it('soma cada tipo separado e o total', async () => {
    // É a conferência do operador com a gaveta; misturar os tipos esconde de
    // onde o dinheiro veio.
    await montar();
    expect(indicadores()).toEqual(['R$ 1000.00', 'R$ 600.00', 'R$ 400.00', 'R$ 2000.00']);
  });

  it('tipo desconhecido entra no total mas não em nenhuma coluna', async () => {
    // Um tipo novo no backend não pode sumir do total geral.
    await montar({
      transacoes: [{ id: 'x9', type: 'tipo_novo', amount: 250, created_at: '2026-06-08T20:00:00Z' }],
    });
    expect(indicadores()).toEqual(['R$ 0.00', 'R$ 0.00', 'R$ 0.00', 'R$ 250.00']);
  });

  it('valor inválido não contamina a soma', async () => {
    await montar({
      transacoes: [
        { id: 'a', type: 'buy_in', amount: 'abc', created_at: '2026-06-08T20:00:00Z' },
        { id: 'b', type: 'buy_in', amount: 100, created_at: '2026-06-08T20:00:00Z' },
      ],
    });
    expect(indicadores()[0]).toBe('R$ 100.00');
  });
});

describe('caixa modular do operador', () => {
  it('caixa fechado bloqueia o botão de lançar', async () => {
    // Lançar num caixa fechado põe dinheiro num caixa que não existe, e a
    // conferência do fim da noite não fecha.
    mockCaixa.valor = { id: 'cb1', status: 'closed' };
    await montar();
    expect(screen.getByRole('button', { name: 'cashRegister.newTransaction' })).toBeDisabled();
  });

  it('caixa aberto libera', async () => {
    mockCaixa.valor = { id: 'cb1', status: 'open' };
    await montar();
    expect(screen.getByRole('button', { name: 'cashRegister.newTransaction' })).toBeEnabled();
  });

  it('operador sem caixa (admin) não é bloqueado', async () => {
    mockCaixa.valor = null;
    await montar();
    expect(screen.getByRole('button', { name: 'cashRegister.newTransaction' })).toBeEnabled();
  });

  it('caixa fechado recusa o envio mesmo com o formulário aberto', async () => {
    // Defesa em profundidade: o caixa pode fechar com o modal já aberto.
    await montar();
    await abrirModal();
    mockCaixa.valor = { id: 'cb1', status: 'closed' };
    await preencher();
    await enviar();
    await waitFor(() => expect(toast.warning).toHaveBeenCalledWith('cashbox.blockedHint'));
    expect(offlineWrite).not.toHaveBeenCalled();
  });
});

describe('escolha do torneio e do dia', () => {
  it('torneio de dia único entra com o dia já escolhido, sem seletor', async () => {
    // O operador não tem o que escolher: perguntar "qual dia?" num torneio de
    // um dia só é um clique a mais na fila do caixa.
    await montar();
    await abrirModal();
    await userEvent.selectOptions(screen.getByLabelText('cashRegister.tournament'), 't1');
    expect(await screen.findByTestId('dia-unico')).toHaveTextContent('Dia 1A');
    expect(screen.queryByLabelText('cashRegister.day')).toBeNull();
    await waitFor(() => expect(selectTournament).toHaveBeenCalledWith('t1'));
  });

  it('torneio com mais de um dia mostra o seletor, sem escolher por conta', async () => {
    await montar({ dias: DOIS_DIAS });
    await abrirModal();
    await userEvent.selectOptions(screen.getByLabelText('cashRegister.tournament'), 't1');
    expect(await screen.findByLabelText('cashRegister.day')).toHaveValue('');
    expect(screen.queryByTestId('dia-unico')).toBeNull();
  });

  it('só oferece dias que ainda recebem entrada', async () => {
    // Dia encerrado e FINAL não vendem buy-in; oferecê-los é convidar ao erro.
    await montar({ dias: [...DOIS_DIAS, ...DIAS.slice(1)] });
    await abrirModal();
    await userEvent.selectOptions(screen.getByLabelText('cashRegister.tournament'), 't1');
    const dia = await screen.findByLabelText('cashRegister.day');
    expect(within(dia).getByText(/Dia 1A/)).toBeInTheDocument();
    expect(within(dia).getByText(/Dia 1B/)).toBeInTheDocument();
    expect(within(dia).queryByText(/Dia 2/)).toBeNull();
    expect(within(dia).queryByText(/Final/)).toBeNull();
  });

  it('o dia mostra a lotação, para o operador ver se ainda cabe', async () => {
    await montar();
    await abrirModal();
    await userEvent.selectOptions(screen.getByLabelText('cashRegister.tournament'), 't1');
    expect(await screen.findByTestId('dia-unico')).toHaveTextContent('10/100');
  });

  it('torneio sem dia nenhum não mostra o seletor', async () => {
    await montar({ dias: [] });
    await abrirModal();
    await userEvent.selectOptions(screen.getByLabelText('cashRegister.tournament'), 't1');
    await waitFor(() => expect(screen.queryByLabelText('cashRegister.day')).toBeNull());
  });

  it('falha ao carregar os dias não trava o formulário', async () => {
    await montar({ dias: new Error('500') });
    await abrirModal();
    await userEvent.selectOptions(screen.getByLabelText('cashRegister.tournament'), 't1');
    await waitFor(() => expect(console.error).toHaveBeenCalled());
    expect(screen.getByLabelText('cashRegister.tournament')).toHaveValue('t1');
  });

  it('havendo mais de um dia, enviar sem escolher um é recusado', async () => {
    // O dia é quem define o valor e a lotação; sem ele a entrada não tem onde
    // ser contada. (fireEvent.submit pula a validação nativa do navegador,
    // que aqui esconderia a regra da aplicação.)
    await montar({ dias: DOIS_DIAS });
    await abrirModal();
    await userEvent.selectOptions(screen.getByLabelText('cashRegister.tournament'), 't1');
    await screen.findByLabelText('cashRegister.day');
    fireEvent.submit(document.querySelector('.modal form'));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('cashRegister.selectDayWarning')
    );
    expect(offlineWrite).not.toHaveBeenCalled();
  });
});

describe('valor cobrado', () => {
  it('o valor vem do meio de entrada, não das colunas do dia', async () => {
    // O meio de entrada do torneio cobra o que ele diz (1000); as colunas
    // antigas do dia são só reserva para quando não há meio escolhido.
    await montar();
    await abrirModal();
    await preencher();
    expect(screen.getByLabelText('cashRegister.amount')).toHaveValue(1000);
  });

  it.each([
    ['b2', 600],
    ['b3', 400],
  ])('escolher o meio de entrada %s cobra o preço dele (%i)', async (tipo, valor) => {
    // Categoria, valor, rake e fichas vêm todos do meio de entrada escolhido.
    await montar();
    await abrirModal();
    await preencher({ tipo });
    expect(screen.getByLabelText('cashRegister.amount')).toHaveValue(valor);
  });

  it('meio de entrada legado, sem valor próprio, cai na configuração do dia', async () => {
    // Cadastro antigo (por etapa) só dizia o rake. A venda não pode parar por
    // isso: o dia continua sendo a reserva.
    useBuyTypes.mockReturnValue({
      activeBuyTypes: [{ id: 'bL', name: 'Rebuy', category: 'rebuy', rake_percentage: 20, active: true }],
      tournamentId: 't1', tiposCarregados: true, selectTournament,
    });
    await montar();
    await abrirModal();
    await preencher({ tipo: 'bL' });
    expect(screen.getByLabelText('cashRegister.amount')).toHaveValue(600);
  });

  it('add-on SEM valor configurado mostra zero, não o preço do buy-in', async () => {
    /* O defeito que o dono do clube encontrou: "ADDON está puxando o valor do
       buyin". Era um `||` — `dia.addon_amount || dia.buy_in` — e zero/nulo é
       falsy. 31 dos 51 dias têm `addon_amount` NULO, porque o formulário do dia
       grava zero como nulo.

       O estrago era duplo: a tela mostrava o preço do BUY-IN, e o backend
       (`valor_do_dia or 0`) registrava ZERO. O operador cobrava 1000 do jogador
       e o caixa guardava 0 — diferença que só aparece no fechamento da noite.

       Zero na tela é o certo: é o que o servidor vai registrar, e é o que faz
       alguém perceber que o add-on não foi configurado. */
    useBuyTypes.mockReturnValue({ activeBuyTypes: [], tournamentId: 't1', tiposCarregados: true, selectTournament });
    await montar({ dias: [{ ...DIA, addon_amount: null }] });
    await abrirModal();
    await porCategoria('addon');
    expect(screen.getByLabelText('cashRegister.amount')).toHaveValue(0);
  });

  it('rebuy sem valor configurado também mostra zero', async () => {
    useBuyTypes.mockReturnValue({ activeBuyTypes: [], tournamentId: 't1', tiposCarregados: true, selectTournament });
    await montar({ dias: [{ ...DIA, rebuy_amount: null }] });
    await abrirModal();
    await porCategoria('rebuy');
    expect(screen.getByLabelText('cashRegister.amount')).toHaveValue(0);
  });

  it('add-on de graça (zero configurado) continua zero', async () => {
    // Zero é uma decisão — add-on de cortesia existe. Tratá-lo como "não
    // informado" cobraria o buy-in de quem não devia pagar nada.
    useBuyTypes.mockReturnValue({ activeBuyTypes: [], tournamentId: 't1', tiposCarregados: true, selectTournament });
    await montar({ dias: [{ ...DIA, addon_amount: 0 }] });
    await abrirModal();
    await porCategoria('addon');
    expect(screen.getByLabelText('cashRegister.amount')).toHaveValue(0);
  });

  it('com valor configurado, é ele que aparece', async () => {
    useBuyTypes.mockReturnValue({ activeBuyTypes: [], tournamentId: 't1', tiposCarregados: true, selectTournament });
    await montar();
    await abrirModal();
    await porCategoria('addon');
    expect(screen.getByLabelText('cashRegister.amount')).toHaveValue(400);
  });

  it('sem dia nenhum, o valor vem do torneio', async () => {
    await montar({ dias: [] });
    await abrirModal();
    await userEvent.selectOptions(screen.getByLabelText('cashRegister.tournament'), 't1');
    await waitFor(() => expect(screen.getByLabelText('cashRegister.amount')).toHaveValue(500));
  });
});

describe('registro de buy-in', () => {
  it('envia o registro com id gerado no cliente', async () => {
    // O id vem do cliente para a reexecução ser idempotente e para um rebuy
    // seguinte conseguir referenciar o jogador que ainda não subiu.
    await montar();
    await abrirModal();
    await preencher();
    await enviar();
    await waitFor(() => expect(chamada('/tournament-players')).toBeTruthy());
    const [op] = chamada('/tournament-players');
    expect(op.body).toMatchObject({
      tournament_id: 't1', tournament_day_id: 'd1', player_id: 'p1', buy_in_count: 1,
    });
    expect(op.body.client_id).toBeTruthy();
    expect(op.clientMutationId).toBeTruthy();
  });

  it('fecha o formulário e recarrega o extrato', async () => {
    await montar();
    await abrirModal();
    await preencher();
    await enviar();
    await waitFor(() => expect(screen.queryByLabelText('cashRegister.tournament')).toBeNull());
  });

  it('avisa que o caixa mudou, para o saldo não ficar parado na abertura', async () => {
    // O saldo aparece no banner, que é outro componente e busca sozinho. Sem
    // este aviso o operador vende a noite inteira olhando o valor da abertura
    // e só o F5 mostra o dinheiro que ele mesmo recebeu.
    const avisos = jest.fn();
    window.addEventListener(CAIXA_MUDOU, avisos);
    try {
      await montar();
      await abrirModal();
      await preencher();
      await enviar();
      await waitFor(() => expect(avisos).toHaveBeenCalled());
    } finally {
      window.removeEventListener(CAIXA_MUDOU, avisos);
    }
  });

  it('alocação automática imprime o bilhete com mesa e assento', async () => {
    api.post.mockResolvedValue({ data: { player_name: 'Ana', table_number: 3, seat_number: 5 } });
    await montar({ dias: [{ ...DIA, allocation_type: 'automatic' }] });
    await abrirModal();
    await preencher();
    await enviar();
    expect(await screen.findByTestId('bilhete')).toBeInTheDocument();
    expect(screen.getByTestId('bilhete-mesa')).toHaveTextContent('3');
    expect(screen.getByTestId('bilhete-assento')).toHaveTextContent('5');
  });

  it('mesas travadas geram bilhete de ALTERNADO, sem tentar alocar', async () => {
    // Depois de travar as mesas, quem chega entra na fila; forçar um assento
    // sentaria alguém numa mesa já fechada.
    await montar({ dias: [{ ...DIA, allocation_type: 'automatic', tables_locked: true }] });
    await abrirModal();
    await preencher();
    await enviar();
    expect(await screen.findByTestId('bilhete')).toBeInTheDocument();
    expect(screen.getByTestId('bilhete-alternado')).toHaveTextContent('true');
    expect(api.post).not.toHaveBeenCalledWith(expect.stringContaining('/auto'), undefined);
  });

  it('sem assento livre o jogador vira alternado, não erro', async () => {
    // "Tables are full" não é falha do registro: o dinheiro entrou, o jogador
    // só está na fila.
    api.post.mockRejectedValue({ response: { data: { detail: 'Tables are full' } } });
    await montar({ dias: [{ ...DIA, allocation_type: 'automatic' }] });
    await abrirModal();
    await preencher();
    await enviar();
    expect(await screen.findByTestId('bilhete-alternado')).toHaveTextContent('true');
    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('outro erro de alocação avisa para alocar na mão', async () => {
    api.post.mockRejectedValue({ response: { data: { detail: 'Explodiu' } } });
    await montar({ dias: [{ ...DIA, allocation_type: 'automatic' }] });
    await abrirModal();
    await preencher();
    await enviar();
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('cashRegister.allocationManualWarning:Explodiu')
    );
  });

  it('alocação por torneio quando não há dia selecionado', async () => {
    api.post.mockResolvedValue({ data: { player_name: 'Ana', table_number: 1, seat_number: 2 } });
    await montar({ torneios: [{ ...TORNEIO, allocation_type: 'automatic' }], dias: [] });
    await abrirModal();
    await preencher({ dia: null });
    await enviar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/allocations/tournament/t1/auto?player_id=p1')
    );
  });

  it('nome do jogador que não carrega vira travessão, não "undefined"', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/transactions') return Promise.resolve({ data: [] });
      if (url.startsWith('/tournaments')) return Promise.resolve({ data: [{ ...TORNEIO, allocation_type: 'automatic' }] });
      if (url.startsWith('/tournament-days/')) return Promise.resolve({ data: [{ ...DIA, allocation_type: 'automatic', tables_locked: true }] });
      if (url.startsWith('/players/')) return Promise.reject(new Error('404'));
      return Promise.resolve({ data: [] });
    });
    render(<Caixa />);
    await screen.findByText('cashRegister.recentTransactions');
    await abrirModal();
    await preencher();
    await enviar();
    expect(await screen.findByTestId('bilhete-jogador')).toHaveTextContent('—');
  });

  it('erro no registro é mostrado com a mensagem do servidor', async () => {
    offlineWrite.mockRejectedValue({ userMessage: 'Jogador já registrado neste dia' });
    await montar();
    await abrirModal();
    await preencher();
    await enviar();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Jogador já registrado neste dia')
    );
  });

  it('erro sem mensagem legível cai numa frase genérica', async () => {
    offlineWrite.mockRejectedValue(new Error('boom'));
    await montar();
    await abrirModal();
    await preencher();
    await enviar();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('cashRegister.registerError')
    );
  });
});

describe('rebuy', () => {
  const comoRebuy = async () => {
    await abrirModal();
    await preencher({ tipo: 'b2' });
  };

  it('envia o rebuy para o jogador já registrado', async () => {
    await montar();
    await comoRebuy();
    await enviar();
    await waitFor(() => expect(chamada('/rebuy')).toBeTruthy());
    expect(chamada('/rebuy')[0].url).toBe('/tournament-players/tp1/rebuy');
  });

  it('jogador que não está no torneio é recusado', async () => {
    // Sem registro não existe rebuy: seria dinheiro sem entrada correspondente.
    offlineRead.mockResolvedValue([]);
    await montar();
    await comoRebuy();
    await enviar();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('cashRegister.playerNotRegistered')
    );
    expect(offlineWrite).not.toHaveBeenCalled();
  });

  it('a recompra não leva mais quantidade nenhuma', async () => {
    // O campo "quantidade de rebuys" multiplicava valor e fichas do rebuy
    // simples — a conta certa só por acidente. Um rebuy duplo tem preço e
    // fichas próprios e hoje é um meio de entrada, escolhido no seletor.
    await montar();
    await comoRebuy();
    await enviar();
    await waitFor(() => expect(chamada('/rebuy')).toBeTruthy());
    const enviada = chamada('/rebuy')[0];
    expect(enviada.params.quantity).toBeUndefined();
    expect(enviada.body.quantity).toBeUndefined();
  });

  it('a recompra leva chave de idempotência, e ela chega ao servidor', async () => {
    // Sem a chave, uma retentativa (rede oscilou, operador clicou de novo)
    // registraria a mesma venda outra vez. Ela ia no CORPO, que a rota descarta;
    // agora vai também como parâmetro, que é o que o servidor lê.
    await montar();
    await comoRebuy();
    await enviar();
    await waitFor(() => expect(chamada('/rebuy')).toBeTruthy());
    const enviada = chamada('/rebuy')[0];
    expect(enviada.clientMutationId).toBeTruthy();
    expect(enviada.params.client_mutation_id).toBe(enviada.clientMutationId);
  });

  it('a tela não mexe no ranking: o servidor faz isso na própria venda', async () => {
    // Tirar do ranking ANTES da venda reativava o jogador, e a reentrada por
    // mesa — que exige o jogador ELIMINADO — era recusada.
    offlineRead.mockResolvedValue([{ ...JOGADOR_TORNEIO, status: 'eliminated' }]);
    await montar();
    await comoRebuy();
    await enviar();
    await waitFor(() => expect(chamada('/rebuy')).toBeTruthy());
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('o jogador é procurado no DIA da venda, não no torneio inteiro', async () => {
    // Quem joga o 1A e o 1B tem duas inscrições; pelo torneio a reentrada
    // caía na do outro dia.
    await montar();
    await comoRebuy();
    await enviar();
    await waitFor(() => expect(chamada('/rebuy')).toBeTruthy());
    expect(offlineRead).toHaveBeenCalledWith('/tournament-players/day/d1', expect.anything());
  });

  it('reentrada recusada pelo servidor mostra o motivo', async () => {
    const recusa = new Error('409');
    recusa.userMessage = 'Reentrada recusada: não há jogador eliminado para voltar.';
    offlineWrite.mockRejectedValue(recusa);
    await montar();
    await comoRebuy();
    await enviar();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Reentrada recusada: não há jogador eliminado para voltar.')
    );
  });

  it('rebuy com alocação automática também imprime bilhete', async () => {
    api.post.mockResolvedValue({ data: { player_name: 'Ana', table_number: 7, seat_number: 1 } });
    await montar({ dias: [{ ...DIA, allocation_type: 'automatic' }] });
    await comoRebuy();
    await enviar();
    expect(await screen.findByTestId('bilhete-mesa')).toHaveTextContent('7');
  });

  it('rebuy sem assento livre vira alternado', async () => {
    api.post.mockRejectedValue({ response: { data: { detail: 'No active tables' } } });
    await montar({ dias: [{ ...DIA, allocation_type: 'automatic' }] });
    await comoRebuy();
    await enviar();
    expect(await screen.findByTestId('bilhete-alternado')).toHaveTextContent('true');
  });

  it('outro erro na alocação do rebuy avisa', async () => {
    api.post.mockRejectedValue({ response: { data: { detail: 'Caiu' } } });
    await montar({ dias: [{ ...DIA, allocation_type: 'automatic' }] });
    await comoRebuy();
    await enviar();
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('cashRegister.rebuyAllocationManualWarning:Caiu')
    );
  });
});

describe('add-on', () => {
  const comoAddon = async () => {
    await abrirModal();
    await preencher({ tipo: 'b3' });
  };

  it('envia o add-on para o jogador registrado', async () => {
    await montar();
    await comoAddon();
    await enviar();
    await waitFor(() => expect(chamada('/addon')).toBeTruthy());
    expect(chamada('/addon')[0].url).toBe('/tournament-players/tp1/addon');
  });

  it('add-on não abre bilhete: o jogador já está sentado', async () => {
    await montar();
    await comoAddon();
    await enviar();
    await waitFor(() => expect(chamada('/addon')).toBeTruthy());
    expect(screen.queryByTestId('bilhete')).toBeNull();
  });

  it('jogador não registrado é recusado', async () => {
    offlineRead.mockResolvedValue([]);
    await montar();
    await comoAddon();
    await enviar();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('cashRegister.playerNotRegistered')
    );
  });
});

describe('sem internet', () => {
  it('o registro é aceito e vira bilhete de alternado', async () => {
    // Quem aloca o assento é o servidor, no sync; offline o bilhete sai como
    // alternado em vez de mentir uma mesa.
    offlineWrite.mockResolvedValue({ offline: true, data: { id: 'uuid-1' } });
    offlineRead.mockResolvedValue({ name: 'Ana' });
    await montar();
    await abrirModal();
    await preencher();
    await enviar();
    expect(await screen.findByTestId('bilhete-alternado')).toHaveTextContent('true');
    expect(toast.success).toHaveBeenCalledWith('Salvo offline — será enviado ao sincronizar');
  });

  it('offline não tenta alocar assento mesmo em torneio automático', async () => {
    offlineWrite.mockResolvedValue({ offline: true, data: {} });
    offlineRead.mockResolvedValue({ name: 'Ana' });
    await montar({ dias: [{ ...DIA, allocation_type: 'automatic' }] });
    await abrirModal();
    await preencher();
    await enviar();
    await screen.findByTestId('bilhete');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('jogador ausente da réplica não quebra o bilhete', async () => {
    offlineWrite.mockResolvedValue({ offline: true, data: {} });
    offlineRead.mockResolvedValue(null);
    await montar();
    await abrirModal();
    await preencher();
    await enviar();
    expect(await screen.findByTestId('bilhete-jogador')).toHaveTextContent('—');
  });

  it('rebuy offline avisa que ficou na fila', async () => {
    offlineRead.mockResolvedValue([JOGADOR_TORNEIO]);
    offlineWrite.mockResolvedValue({ offline: true, data: {} });
    await montar();
    await abrirModal();
    await preencher({ tipo: 'b2' });
    await enviar();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Salvo offline — será enviado ao sincronizar')
    );
  });

  it('add-on offline também avisa', async () => {
    offlineWrite.mockResolvedValue({ offline: true, data: {} });
    await montar();
    await abrirModal();
    await preencher({ tipo: 'b3' });
    await enviar();
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Salvo offline — será enviado ao sincronizar')
    );
  });
});

describe('reimpressão do bilhete', () => {
  it('reimprime com a mesa e o assento atuais do jogador', async () => {
    // A impressora falha e o jogador perde o papel; ele precisa do assento
    // REAL de agora, não do que estava no registro.
    await montar({
      alocacoes: [{ id: 'a1', player_id: 'p1', seat_number: 4, tournament_tables: { table_number: 9 } }],
    });
    await userEvent.click(screen.getAllByRole('button', { name: /cashRegister.reprint/ })[0]);
    expect(await screen.findByTestId('bilhete-mesa')).toHaveTextContent('9');
    expect(screen.getByTestId('bilhete-assento')).toHaveTextContent('4');
  });

  it('jogador sem assento reimprime como alternado', async () => {
    await montar({ alocacoes: [] });
    await userEvent.click(screen.getAllByRole('button', { name: /cashRegister.reprint/ })[0]);
    expect(await screen.findByTestId('bilhete-alternado')).toHaveTextContent('true');
  });

  it('só buy-in e rebuy podem ser reimpressos', async () => {
    // Add-on não tem bilhete de assento para reimprimir.
    await montar();
    expect(screen.getAllByRole('button', { name: /cashRegister.reprint/ }).length).toBe(2);
  });

  it('fechar o bilhete recarrega o extrato', async () => {
    await montar({ alocacoes: [] });
    const antes = api.get.mock.calls.length;
    await userEvent.click(screen.getAllByRole('button', { name: /cashRegister.reprint/ })[0]);
    await screen.findByTestId('bilhete');
    // O "X" do cabecalho e o botao do rodape tem o mesmo nome; o do rodape e o
    // ultimo.
    const fechar = screen.getAllByRole('button', { name: 'common.close' });
    await userEvent.click(fechar[fechar.length - 1]);
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(antes));
  });

  it('imprimir fecha o bilhete', async () => {
    await montar({ alocacoes: [] });
    await userEvent.click(screen.getAllByRole('button', { name: /cashRegister.reprint/ })[0]);
    await userEvent.click(await screen.findByText('imprimir'));
    await waitFor(() => expect(screen.queryByTestId('bilhete')).toBeNull());
  });
});

describe('meios de entrada', () => {
  it('só existe o seletor de MEIO DE ENTRADA — não há escolha solta de categoria', async () => {
    // O meio de entrada é a fonte única da categoria, do valor e do rake; um
    // select de categoria ao lado permitiria vender "add-on" com um meio de
    // buy-in, com rake que o clube nunca configurou.
    await montar();
    await abrirModal();
    expect(screen.getByLabelText('Meio de entrada')).toBeInTheDocument();
    expect(screen.queryByLabelText('cashRegister.type')).toBeNull();
  });

  it('não existe mais a opção "Manual"', async () => {
    // "Manual" virava buy-in em silêncio, com o rake do dia — era a 4ª opção
    // não homologada de que o clube reclamou.
    await montar();
    await abrirModal();
    const select = screen.getByLabelText('Meio de entrada');
    const opcoes = Array.from(select.querySelectorAll('option'));
    expect(opcoes.filter((o) => !o.disabled).map((o) => o.value)).toEqual(['b1', 'b2', 'b3', 'b4']);
    expect(opcoes[0].disabled).toBe(true);
  });

  it('o meio de entrada escolhido define a categoria da transação', async () => {
    await montar();
    await abrirModal();
    await preencher({ tipo: 'b2' });
    await enviar();
    await waitFor(() => expect(chamada('/rebuy')).toBeTruthy());
  });

  it('o valor cobrado vem do MEIO DE ENTRADA, não do dia', async () => {
    // "Recompra turbo" custa 600 porque é o preço DELE; se o valor viesse do
    // dia, dois meios de entrada de preços diferentes cobrariam o mesmo.
    await montar();
    await abrirModal();
    await preencher({ tipo: 'b2' });
    expect(screen.getByLabelText('cashRegister.amount')).toHaveValue(600);
  });

  it('"Rebuy duplo" cobra o preço dele, e não o dobro do rebuy simples', async () => {
    // É o caso que fez a mudança existir: 1500 é o que o clube configurou —
    // o dobro de 600 daria 1200, um número que ninguém aprovou.
    await montar();
    await abrirModal();
    await preencher({ tipo: 'b4' });
    expect(screen.getByLabelText('cashRegister.amount')).toHaveValue(1500);
  });

  it('não existe mais campo de quantidade de rebuys', async () => {
    // Ele multiplicava valor e fichas do rebuy simples; um rebuy duplo tem os
    // seus próprios e virou um meio de entrada.
    await montar();
    await abrirModal();
    await preencher({ tipo: 'b2' });
    expect(screen.queryByLabelText(/[Qq]uantidade/)).toBeNull();
  });

  it('o seletor mostra o nome configurado no dia e o valor do próprio meio', async () => {
    await montar();
    await abrirModal();
    const select = screen.getByLabelText('Meio de entrada');
    expect(within(select).getByText(/Rebuy duplo/)).toBeInTheDocument();
    expect(within(select).getByText(/1500\.00/)).toBeInTheDocument();
  });

  it('a tela avisa o contexto qual TORNEIO carregar — antes mesmo de escolher o dia', async () => {
    // Os meios de entrada são do torneio, e o torneio é escolhido aqui dentro:
    // sem este aviso a lista ficaria vazia e toda venda cairia no modo
    // categoria. Como a lista vale para todos os dias, ela já pode aparecer
    // antes do dia.
    await montar();
    await abrirModal();
    await userEvent.selectOptions(screen.getByLabelText('cashRegister.tournament'), 't1');
    await waitFor(() => expect(selectTournament).toHaveBeenCalledWith('t1'));
  });

  it('trocar de dia MANTÉM o meio de entrada escolhido', async () => {
    // A lista é a mesma em todos os dias do torneio; limpar a escolha a cada
    // troca de dia faria o operador escolher de novo o que já tinha escolhido.
    await montar({ dias: [DIA, { ...DIA, id: 'd1b', day_name: 'Dia 1B' }] });
    await abrirModal();
    await preencher({ tipo: 'b2' });
    await userEvent.selectOptions(screen.getByLabelText('cashRegister.day'), 'd1b');
    expect(screen.getByLabelText('Meio de entrada')).toHaveValue('b2');
    expect(screen.getByLabelText('cashRegister.amount')).toHaveValue(600);
  });

  it('trocar de TORNEIO limpa o meio de entrada escolhido', async () => {
    // Eles pertencem ao torneio: manter a escolha cobraria o preço do torneio
    // anterior, ou o de um cadastro que nem existe no novo.
    await montar({ torneios: [TORNEIO, { ...TORNEIO, id: 't2', name: 'Outro torneio' }] });
    await abrirModal();
    await preencher({ tipo: 'b2' });
    await userEvent.selectOptions(screen.getByLabelText('cashRegister.tournament'), 't2');
    expect(screen.getByLabelText('Meio de entrada')).toHaveValue('');
  });

  it('o recibo mostra o nome do meio de entrada vendido', async () => {
    // É por ele que o jogador confere o que comprou — "Rebuy duplo" e
    // "Recompra turbo" são vendas diferentes com a mesma categoria.
    api.post.mockResolvedValue({ data: { player_name: 'Ana', table_number: 3, seat_number: 5 } });
    await montar({ dias: [DIA_AUTO] });
    await abrirModal();
    await preencher({ tipo: 'b1' });
    await enviar();
    expect(await screen.findByTestId('bilhete')).toBeInTheDocument();
    expect(screen.getByText('Entrada normal')).toBeInTheDocument();
  });

  it('o meio de entrada vai junto na transação, porque ele carrega o rake', async () => {
    await montar();
    await abrirModal();
    await preencher({ tipo: 'b1' });
    await enviar();
    await waitFor(() => expect(chamada('/tournament-players')).toBeTruthy());
    expect(chamada('/tournament-players')[0].body.buy_type_id).toBe('b1');
  });

  it('mostra o rake de cada meio de entrada na hora de escolher', async () => {
    await montar();
    await abrirModal();
    const select = screen.getByLabelText('Meio de entrada');
    expect(within(select).getByText(/20% rake/)).toBeInTheDocument();
  });

  it('enviar sem escolher o meio de entrada é recusado e não chama a API', async () => {
    await montar();
    await abrirModal();
    await preencher({ tipo: null });
    fireEvent.submit(document.querySelector('.modal form'));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('Escolha o meio de entrada.')
    );
    expect(offlineWrite).not.toHaveBeenCalled();
  });

  it('o valor é somente leitura: quem manda é o meio de entrada', async () => {
    // O backend IGNORA o que for digitado aqui. Editável, o campo prometia um
    // desconto que nunca aconteceria.
    await montar();
    await abrirModal();
    await preencher();
    expect(screen.getByLabelText('cashRegister.amount')).toHaveAttribute('readonly');
  });

  it('sem etapa selecionada o aviso é sobre a etapa', async () => {
    // Falar de cadastro de meio de entrada quando o problema é não ter etapa
    // escolhida faz o operador procurar um cadastro que já existe.
    useStage.mockReturnValue({ selectedStage: null });
    await montar();
    expect(screen.getByText('Selecione uma etapa para vender.')).toBeInTheDocument();
  });

  it('o extrato mostra o NOME congelado na venda', async () => {
    // A lista carregada é a do dia escolhido no formulário, e o extrato mostra
    // vendas de todos os dias: procurar nela deixaria a maioria sem nome.
    await montar({
      transacoes: [{ ...TRANSACOES[0], buy_type_id: 'bX', buy_type_name: 'Buy-in VIP' }],
    });
    expect(screen.getByText('Buy-in VIP')).toBeInTheDocument();
  });

  it('venda antiga sem meio de entrada cai no rótulo da categoria', async () => {
    // Vendas anteriores aos meios de entrada não podem sumir do extrato.
    await montar({ transacoes: [TRANSACOES[1]] });
    expect(screen.getByText('Rebuy')).toBeInTheDocument();
  });
});

describe('sem meios de entrada à mão o caixa não pode parar', () => {
  /**
   * Lista vazia tinha três causas — dia sem cadastro, consulta que falhou
   * (sessão/RLS) e modo OFFLINE — e todas travavam a venda com a mesma
   * mensagem: "cadastre um meio de entrada". No evento isso é o operador sem
   * conseguir registrar ninguém, sendo mandado cadastrar o que já existe.
   * A saída é vender pela CATEGORIA, com o valor e o rake do dia — como antes
   * dos meios de entrada.
   */
  const semTipos = (extra = {}) =>
    useBuyTypes.mockReturnValue({
      activeBuyTypes: [], tournamentId: 't1', tiposCarregados: true, selectTournament, ...extra,
    });

  /** Preenche torneio → dia → jogador → categoria. */
  const preencherPorCategoria = async (categoria = 'buy_in') => {
    await userEvent.selectOptions(screen.getByLabelText('cashRegister.tournament'), 't1');
    await escolherDia('d1');
    await userEvent.selectOptions(screen.getByLabelText('jogador'), 'p1');
    await userEvent.selectOptions(screen.getByLabelText('Categoria'), categoria);
  };

  it('o botão de nova transação continua habilitado', async () => {
    semTipos();
    await montar();
    expect(screen.getByRole('button', { name: 'cashRegister.newTransaction' })).toBeEnabled();
  });

  it('registra o jogador escolhendo a categoria, sem meio de entrada', async () => {
    semTipos();
    await montar();
    await abrirModal();
    await preencherPorCategoria('buy_in');
    await enviar();
    await waitFor(() => expect(chamada('/tournament-players')).toBeTruthy());
    const corpo = chamada('/tournament-players')[0].body;
    expect(corpo.buy_type_id).toBeNull();
    expect(corpo.player_id).toBe('p1');
  });

  it('a categoria escolhida cobra o valor daquele dia', async () => {
    // Rebuy do Dia 1A custa 600, não os 1000 do buy-in.
    semTipos();
    await montar();
    await abrirModal();
    await preencherPorCategoria('rebuy');
    expect(screen.getByLabelText('cashRegister.amount')).toHaveValue(600);
  });

  it('enviar sem escolher a categoria é recusado', async () => {
    semTipos();
    await montar();
    await abrirModal();
    await userEvent.selectOptions(screen.getByLabelText('cashRegister.tournament'), 't1');
    await escolherDia('d1');
    await userEvent.selectOptions(screen.getByLabelText('jogador'), 'p1');
    fireEvent.submit(document.querySelector('.modal form'));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('Escolha a categoria da entrada.')
    );
    expect(offlineWrite).not.toHaveBeenCalled();
  });

  it('dia sem cadastro avisa dentro do formulário, mas não trava nada', async () => {
    // O aviso mora no formulário porque é lá que o dia é escolhido: no topo da
    // tela, antes da escolha, ele seria um palpite.
    semTipos();
    await montar();
    await abrirModal();
    expect(screen.getByText('Nenhum meio de entrada cadastrado')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'cashRegister.register' })).toBeEnabled();
  });

  it('lista vazia por falha de consulta NÃO vira "cadastre um meio de entrada"', async () => {
    // Offline / sessão expirada: mandar cadastrar o que já está cadastrado faz
    // o operador perder o evento procurando um problema que não existe.
    semTipos({ tiposCarregados: false });
    await montar();
    await abrirModal();
    expect(screen.queryByText('Nenhum meio de entrada cadastrado')).toBeNull();
    expect(screen.getByRole('button', { name: 'cashRegister.register' })).toBeEnabled();
  });

  it('offline, sem os meios de entrada carregados, ainda registra o jogador', async () => {
    semTipos({ tiposCarregados: false });
    isOnline.mockReturnValue(false);
    offlineWrite.mockResolvedValue({ offline: true, data: { id: 'uuid-1' } });
    await montar();
    await abrirModal();
    await preencherPorCategoria('buy_in');
    await enviar();
    await waitFor(() => expect(chamada('/tournament-players')).toBeTruthy());
    expect(await screen.findByTestId('bilhete')).toBeInTheDocument();
  });
});

describe('formas de pagamento', () => {
  it('sem métodos configurados sobra "dinheiro"', async () => {
    // Um select vazio impediria qualquer lançamento.
    await montar();
    await abrirModal();
    const select = screen.getByLabelText('cashRegister.paymentMethod');
    expect(within(select).getByText('cashRegister.cash')).toBeInTheDocument();
  });

  it('usa os métodos configurados pelo clube', async () => {
    // Método personalizado do clube (Yape, Nequi…) usa o rótulo do banco;
    // os embutidos passam por i18n.
    usePaymentMethods.mockReturnValue({
      activeMethods: [{ id: 'm1', code: 'yape', label: 'Yape' }],
    });
    await montar();
    await abrirModal();
    const select = screen.getByLabelText('cashRegister.paymentMethod');
    expect(within(select).getByText('Yape')).toBeInTheDocument();
  });

  it('método removido da configuração não fica selecionado', async () => {
    // "cash" é o padrão; se o clube tirou dinheiro da lista, o lançamento não
    // pode sair com uma forma de pagamento que não existe mais.
    usePaymentMethods.mockReturnValue({
      activeMethods: [{ id: 'm1', code: 'pix', name: 'PIX' }],
    });
    await montar();
    await abrirModal();
    expect(screen.getByLabelText('cashRegister.paymentMethod')).toHaveValue('pix');
  });

  it('a forma de pagamento vai junto na transação', async () => {
    usePaymentMethods.mockReturnValue({
      activeMethods: [{ id: 'm1', code: 'pix', name: 'PIX' }],
    });
    await montar();
    await abrirModal();
    await preencher();
    await enviar();
    await waitFor(() => expect(chamada('/tournament-players')).toBeTruthy());
    expect(chamada('/tournament-players')[0].body.payment_method).toBe('pix');
  });
});

describe('crédito do jogador', () => {
  it('jogador sem crédito não vê a opção', async () => {
    await montar({ credito: 0 });
    await abrirModal();
    await preencher();
    expect(screen.queryByText('cashRegister.paymentSource')).toBeNull();
  });

  it('jogador com crédito pode pagar com ele', async () => {
    await montar({ credito: 5000 });
    await abrirModal();
    await preencher();
    expect(await screen.findByText('cashRegister.paymentSource')).toBeInTheDocument();
    expect(screen.getByText('cashRegister.availableCredit:R$ 5000.00')).toBeInTheDocument();
  });

  it('crédito menor que a entrada abre o pagamento misto', async () => {
    // Sem "misto", o operador teria de recusar o crédito inteiro por faltar
    // uma parte.
    await montar({ credito: 300 });
    await abrirModal();
    await preencher();
    expect(await screen.findByText('cashRegister.paymentSourceMixed')).toBeInTheDocument();
  });

  it('crédito maior que a entrada não oferece misto', async () => {
    await montar({ credito: 5000 });
    await abrirModal();
    await preencher();
    await screen.findByText('cashRegister.paymentSource');
    expect(screen.queryByText('cashRegister.paymentSourceMixed')).toBeNull();
  });

  it('escolher crédito insuficiente mostra o aviso', async () => {
    await montar({ credito: 300 });
    await abrirModal();
    await preencher();
    await screen.findByText('cashRegister.paymentSource');
    await userEvent.selectOptions(
      document.querySelector('select[name="payment_source"]'),
      'credit'
    );
    expect(screen.getByText('cashRegister.insufficientCreditWarning')).toBeInTheDocument();
  });

  it('falha ao consultar crédito não bloqueia o lançamento', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/transactions') return Promise.resolve({ data: [] });
      if (url.startsWith('/tournaments')) return Promise.resolve({ data: [TORNEIO] });
      if (url.startsWith('/tournament-days/')) return Promise.resolve({ data: [DIA] });
      if (url.startsWith('/player-credits/')) return Promise.reject(new Error('500'));
      return Promise.resolve({ data: [] });
    });
    render(<Caixa />);
    await screen.findByText('cashRegister.recentTransactions');
    await abrirModal();
    await preencher();
    await enviar();
    await waitFor(() => expect(chamada('/tournament-players')).toBeTruthy());
  });

  it('trocar de jogador zera a origem do pagamento', async () => {
    // O crédito é de quem foi selecionado antes; manter "crédito" cobraria do
    // saldo do jogador errado.
    await montar({ credito: 5000 });
    await abrirModal();
    await preencher();
    await screen.findByText('cashRegister.paymentSource');
    await userEvent.selectOptions(document.querySelector('select[name="payment_source"]'), 'credit');
    await userEvent.selectOptions(screen.getByLabelText('jogador'), 'p2');
    await waitFor(() =>
      expect(document.querySelector('select[name="payment_source"]')).toHaveValue('cash')
    );
  });
});

describe('fechamento do formulário', () => {
  it('o X fecha sem lançar nada', async () => {
    await montar();
    await abrirModal();
    await userEvent.click(screen.getAllByRole('button', { name: 'common.close' })[0]);
    expect(screen.queryByLabelText('cashRegister.tournament')).toBeNull();
    expect(offlineWrite).not.toHaveBeenCalled();
  });

  it('clicar fora fecha', async () => {
    await montar();
    await abrirModal();
    await userEvent.click(document.querySelector('.modal-overlay'));
    expect(screen.queryByLabelText('cashRegister.tournament')).toBeNull();
  });

  it('Esc fecha sem lançar nada', async () => {
    /* O caixa do clube opera de Tab e Enter, com as duas mãos ocupadas: se a
       única saída fosse o clique no fundo, ele ficaria preso no modal. */
    await montar();
    await abrirModal();
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByLabelText('cashRegister.tournament')).toBeNull());
    expect(offlineWrite).not.toHaveBeenCalled();
  });

  it('clicar dentro do formulário NÃO fecha', async () => {
    // Um clique no meio do preenchimento não pode perder o que já foi digitado.
    await montar();
    await abrirModal();
    await userEvent.click(document.querySelector('.modal'));
    expect(screen.getByLabelText('cashRegister.tournament')).toBeInTheDocument();
  });
});


describe('bloqueio de vendas', () => {
  it('etapa bloqueada desabilita o botão e explica o motivo', async () => {
    // O bloqueio da ETAPA é o único que a tela enxerga antes de o operador
    // escolher o dia — por isso é ele que consegue travar o botão de fora.
    await montar({ etapa: { id: 'e1', sales_blocked: true, sales_blocked_reason: 'evento encerrado' } });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'cashRegister.newTransaction' })).toBeDisabled()
    );
    expect(screen.getByText('evento encerrado')).toBeInTheDocument();
  });

  it('dia bloqueado avisa dentro do formulário e recusa o envio', async () => {
    // O dia só é escolhido dentro do modal, então o aviso tem de aparecer ali.
    await montar({ dias: [{ ...DIA, sales_blocked: true, sales_blocked_reason: 'registro tardio encerrado' }] });
    await abrirModal();
    await preencher();
    expect(screen.getByText('registro tardio encerrado')).toBeInTheDocument();
    await enviar();
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('registro tardio encerrado')
    );
    expect(offlineWrite).not.toHaveBeenCalled();
  });

  it('dia bloqueado sem motivo ainda barra a venda', async () => {
    await montar({ dias: [{ ...DIA, sales_blocked: true }] });
    await abrirModal();
    await preencher();
    await enviar();
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('Vendas encerradas para este dia/etapa.')
    );
    expect(offlineWrite).not.toHaveBeenCalled();
  });

  it('dia liberado vende normalmente', async () => {
    await montar();
    await abrirModal();
    await preencher();
    await enviar();
    await waitFor(() => expect(chamada('/tournament-players')).toBeTruthy());
  });

  it('etapa sem a coluna nova não bloqueia nada', async () => {
    // Enquanto a migração não roda o campo nem existe: o Caixa tem de seguir
    // vendendo como hoje.
    await montar({ etapa: { id: 'e1' } });
    expect(screen.getByRole('button', { name: 'cashRegister.newTransaction' })).toBeEnabled();
  });
});

describe('cancelar venda', () => {
  const CANCELADA = {
    id: 'x9', player_name: 'Ana', tournament_name: 'Main Event', type: 'buy_in',
    amount: 1000, created_at: '2026-06-08T20:00:00Z', tournament_id: 't1',
    player_id: 'p1', status: 'cancelled',
  };

  const abrirCancelamento = async (indice = 0) => {
    await userEvent.click(screen.getAllByRole('button', { name: 'Cancelar venda' })[indice]);
  };

  it('pede o motivo e só então chama a API', async () => {
    // O motivo é o que explica a diferença no fechamento do caixa.
    await montar();
    await abrirCancelamento();
    await userEvent.type(screen.getByLabelText('Motivo do cancelamento'), 'cobrei duas vezes');
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar a venda' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/transactions/x1/cancel', { reason: 'cobrei duas vezes' })
    );
  });

  it('o estorno também avisa que o caixa mudou', async () => {
    // Estornar devolve dinheiro: o saldo cai na hora e o banner precisa saber.
    const avisos = jest.fn();
    window.addEventListener(CAIXA_MUDOU, avisos);
    try {
      await montar();
      await abrirCancelamento();
      await userEvent.type(screen.getByLabelText('Motivo do cancelamento'), 'cobrei duas vezes');
      await userEvent.click(screen.getByRole('button', { name: 'Cancelar a venda' }));
      await waitFor(() => expect(avisos).toHaveBeenCalled());
    } finally {
      window.removeEventListener(CAIXA_MUDOU, avisos);
    }
  });

  it('sem motivo não cancela', async () => {
    await montar();
    await abrirCancelamento();
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar a venda' }));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('Informe o motivo do cancelamento.')
    );
    expect(api.post).not.toHaveBeenCalled();
  });

  it('venda paga com crédito é recusada com explicação', async () => {
    // Não existe inversa do consumo de crédito: cancelar sem devolver
    // confiscaria o saldo do jogador.
    await montar({ transacoes: [{ ...TRANSACOES[0], payment_source: 'credit' }] });
    await abrirCancelamento();
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(
        'Venda paga com crédito ou ticket ainda não pode ser cancelada aqui.'
      )
    );
    expect(screen.queryByLabelText('Motivo do cancelamento')).toBeNull();
  });

  it('sem internet não cancela nem enfileira', async () => {
    // A fila offline só conhece registro/rebuy/addon; um cancelamento fora de
    // ordem em relação à venda original deixaria o caixa inconsistente.
    isOnline.mockReturnValue(false);
    await montar();
    await abrirCancelamento();
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('Cancelar uma venda exige conexão.')
    );
    expect(api.post).not.toHaveBeenCalled();
    expect(offlineWrite).not.toHaveBeenCalled();
  });

  it('quem não é admin não vê o botão de cancelar', async () => {
    // Cancelar mexe em caixa da etapa, premiação e rake — não é operação de
    // balcão.
    usePermissions.mockReturnValue({ isAdmin: false, hasPermission: () => false });
    await montar();
    expect(screen.queryAllByRole('button', { name: 'Cancelar venda' })).toEqual([]);
  });

  it('erro do servidor é mostrado ao operador', async () => {
    api.post.mockRejectedValue({ response: { data: { detail: 'Venda já sangrada' } } });
    await montar();
    await abrirCancelamento();
    await userEvent.type(screen.getByLabelText('Motivo do cancelamento'), 'erro');
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar a venda' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Venda já sangrada'));
  });

  it('linha cancelada aparece riscada, com selo e sem ações', async () => {
    await montar({ transacoes: [CANCELADA] });
    expect(document.querySelector('.cx-row-cancelled')).toBeInTheDocument();
    expect(screen.getByText('Cancelada')).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: 'Cancelar venda' })).toEqual([]);
    expect(screen.queryAllByRole('button', { name: /cashRegister.reprint/ })).toEqual([]);
  });

  it('venda cancelada sai dos totais', async () => {
    // Contá-la faria o operador procurar na gaveta um dinheiro que já voltou
    // para o jogador.
    await montar({ transacoes: [TRANSACOES[0], CANCELADA] });
    expect(indicadores()).toEqual(['R$ 1000.00', 'R$ 0.00', 'R$ 0.00', 'R$ 1000.00']);
  });

  // ── Avisos do estorno (o backend devolve em cancel_warnings) ──────────────
  // São TAREFAS MANUAIS de dinheiro: acertar o caixa geral, o rake acumulado ou
  // o crédito do jogador. Se a tela não as mostrar, o clube só descobre a
  // pendência quando a próxima sangria for recusada por saldo insuficiente.
  const AVISOS = [
    'O caixa da etapa ficou negativo em R$ 50.00: este dinheiro já tinha sido sangrado.',
    'O cashback de R$ 3.00 desta venda já tinha virado crédito do jogador.',
  ];

  it('avisos do estorno aparecem na tela e não somem sozinhos', async () => {
    api.post.mockResolvedValue({ data: { cancel_warnings: AVISOS } });
    await montar();
    await abrirCancelamento();
    await userEvent.type(screen.getByLabelText('Motivo do cancelamento'), 'cobrei duas vezes');
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar a venda' }));

    const painel = await screen.findByRole('alertdialog');
    expect(painel).toHaveTextContent(AVISOS[0]);
    expect(painel).toHaveTextContent(AVISOS[1]);
    // O toast genérico "cancelada e estornada" MENTIRIA aqui: sobrou trabalho.
    expect(toast.success).not.toHaveBeenCalled();

    // Só sai da tela quando o admin confirma que leu.
    await userEvent.click(screen.getByRole('button', { name: 'Entendi, vou acertar' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('estorno limpo continua avisando com o toast de sempre', async () => {
    api.post.mockResolvedValue({ data: { cancel_warnings: [] } });
    await montar();
    await abrirCancelamento();
    await userEvent.type(screen.getByLabelText('Motivo do cancelamento'), 'cobrei duas vezes');
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar a venda' }));
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith('Venda cancelada e valores estornados')
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

// ── Estorno pela metade: status 'cancelling' ────────────────────────────────
// O backend tira a venda de TODAS as somas assim que o estorno começa. A tela
// que só conhece 'cancelled' mostra um total e o relatório mostra outro para a
// mesma noite — e ainda oferece uma ação que o backend recusa com 400.
describe('venda com estorno pela metade', () => {
  const EM_CANCELAMENTO = {
    id: 'x8', player_name: 'Ana', tournament_name: 'Main Event', type: 'buy_in',
    amount: 1000, created_at: '2026-06-08T20:00:00Z', tournament_id: 't1',
    player_id: 'p1', status: 'cancelling', cancel_reason: 'cobrei duas vezes',
  };

  it('sai dos totais como o backend já a tirou', async () => {
    await montar({ transacoes: [TRANSACOES[1], EM_CANCELAMENTO] });
    expect(indicadores()).toEqual(['R$ 0.00', 'R$ 600.00', 'R$ 0.00', 'R$ 600.00']);
  });

  it('a linha diz que o estorno parou no meio e pede a conclusão', async () => {
    await montar({ transacoes: [EM_CANCELAMENTO] });
    expect(document.querySelector('.cx-row-cancelling')).toBeInTheDocument();
    expect(screen.getByText('Estorno incompleto')).toBeInTheDocument();
    expect(
      screen.getByText('O estorno parou no meio. Conclua para o caixa fechar certo.')
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Concluir estorno' })).toBeInTheDocument();
  });

  it('não oferece trocar pagamento nem reimprimir', async () => {
    // O backend recusa a troca com 400 "Venda cancelada não pode ser alterada",
    // sem explicar; e o bilhete seria de um jogador que saiu do dia.
    await montar({ transacoes: [EM_CANCELAMENTO] });
    expect(screen.queryAllByRole('button', { name: 'Trocar pagamento' })).toEqual([]);
    expect(screen.queryAllByRole('button', { name: /cashRegister.reprint/ })).toEqual([]);
  });

  it('concluir retoma o estorno com o motivo já gravado', async () => {
    // Exigir digitar o motivo de novo só atrasaria um estorno que já começou —
    // o backend nem reaproveita o texto na retomada.
    await montar({ transacoes: [EM_CANCELAMENTO] });
    await userEvent.click(screen.getByRole('button', { name: 'Concluir estorno' }));
    await userEvent.click(screen.getByRole('button', { name: 'Concluir o estorno' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/transactions/x8/cancel', { reason: 'cobrei duas vezes' })
    );
    expect(toast.warning).not.toHaveBeenCalledWith('Informe o motivo do cancelamento.');
  });
});

describe('trocar a forma de pagamento', () => {
  it('troca só o rótulo, sem mexer em valor', async () => {
    usePaymentMethods.mockReturnValue({
      activeMethods: [{ id: 'm1', code: 'pix', name: 'PIX' }, { id: 'm2', code: 'cash', name: 'Dinheiro' }],
    });
    await montar();
    await userEvent.click(screen.getAllByRole('button', { name: 'Trocar pagamento' })[0]);
    await userEvent.selectOptions(screen.getByLabelText('cashRegister.paymentMethod'), 'pix');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(api.patch).toHaveBeenCalledWith('/transactions/x1/payment-method', { payment_method: 'pix' })
    );
  });

  it('sem internet não troca', async () => {
    isOnline.mockReturnValue(false);
    await montar();
    await userEvent.click(screen.getAllByRole('button', { name: 'Trocar pagamento' })[0]);
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('Cancelar uma venda exige conexão.')
    );
    expect(api.patch).not.toHaveBeenCalled();
  });

  it('erro do servidor é mostrado', async () => {
    api.patch.mockRejectedValue({ response: { data: { detail: 'Venda cancelada não pode ser alterada' } } });
    await montar();
    await userEvent.click(screen.getAllByRole('button', { name: 'Trocar pagamento' })[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Venda cancelada não pode ser alterada')
    );
  });
});


/**
 * Mesas do dia — o aviso que precede o bilhete de ALTERNADO.
 *
 * O dono do clube vendeu uma entrada num dia SEM NENHUMA MESA CRIADA e a
 * impressora cuspiu um bilhete de alternado. Tecnicamente coerente (não havia
 * assento livre), operacionalmente péssimo: ele só descobriu que faltava
 * configurar as mesas com o jogador na frente dele esperando para sentar.
 *
 * Os dois casos NÃO são o mesmo problema e por isso não podem ter a mesma
 * mensagem: "mesas cheias/travadas" é fila de alternados de verdade e o
 * bilhete está certo; "nenhuma mesa cadastrada" é etapa por configurar. E o
 * aviso nunca bloqueia: em evento ao vivo o clube às vezes vende antes de
 * montar as mesas, e travar o caixa é pior que o bilhete errado.
 */
describe('mesas do dia', () => {
  const avisoSemMesa = () => screen.queryByText('Nenhuma mesa cadastrada');
  const avisoTravadas = () => screen.queryByText('Mesas travadas');

  it('dia sem mesa cadastrada avisa ANTES de vender', async () => {
    await montar({ dias: [DIA_AUTO], mesas: [] });
    await abrirModal();
    await preencher();
    expect(await screen.findByText('Nenhuma mesa cadastrada')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/tables/day/d1');
  });

  it('o aviso não bloqueia a venda', async () => {
    // Vender antes de montar as mesas é rotina em evento ao vivo; travar o
    // caixa custaria mais que o bilhete errado.
    await montar({ dias: [DIA_AUTO], mesas: [] });
    await abrirModal();
    await preencher();
    await screen.findByText('Nenhuma mesa cadastrada');
    expect(screen.getByRole('button', { name: 'cashRegister.register' })).toBeEnabled();
    await enviar();
    await waitFor(() => expect(offlineWrite).toHaveBeenCalled());
  });

  it('dia com mesa ativa não avisa nada', async () => {
    await montar({ dias: [DIA_AUTO] });
    await abrirModal();
    await preencher();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/tables/day/d1'));
    expect(avisoSemMesa()).toBeNull();
    expect(avisoTravadas()).toBeNull();
  });

  it('mesa fechada conta como sem mesa: o servidor não aloca nela', async () => {
    await montar({ dias: [DIA_AUTO], mesas: [{ ...MESA, status: 'closed' }] });
    await abrirModal();
    await preencher();
    expect(await screen.findByText('Nenhuma mesa cadastrada')).toBeInTheDocument();
  });

  it('mesas travadas avisam FILA, não falta de mesa', async () => {
    // Aqui o alternado é o certo — o operador não tem nada a configurar.
    await montar({ dias: [{ ...DIA_AUTO, tables_locked: true }] });
    await abrirModal();
    await preencher();
    expect(await screen.findByText('Mesas travadas')).toBeInTheDocument();
    expect(avisoSemMesa()).toBeNull();
  });

  it('travadas E sem mesa nenhuma: manda configurar, que é a ação real', async () => {
    await montar({ dias: [{ ...DIA_AUTO, tables_locked: true }], mesas: [] });
    await abrirModal();
    await preencher();
    expect(await screen.findByText('Nenhuma mesa cadastrada')).toBeInTheDocument();
    expect(avisoTravadas()).toBeNull();
  });

  it('alocação manual não avisa: o staff senta o jogador na mão', async () => {
    await montar({ mesas: [] });
    await abrirModal();
    await preencher();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/tables/day/d1'));
    expect(avisoSemMesa()).toBeNull();
  });

  it('falha ao conferir as mesas não vira aviso falso', async () => {
    // Consulta quebrada não é prova de que falta mesa; calar é melhor que
    // mandar o operador configurar o que já está configurado.
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await montar({ dias: [DIA_AUTO], mesas: new Error('rede') });
    await abrirModal();
    await preencher();
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/tables/day/d1'));
    expect(avisoSemMesa()).toBeNull();
    console.warn.mockRestore();
  });

  it('torneio sem dias confere as mesas do torneio', async () => {
    await montar({ torneios: [{ ...TORNEIO, allocation_type: 'automatic' }], dias: [], mesas: [] });
    await abrirModal();
    await preencher({ dia: null });
    expect(await screen.findByText('Nenhuma mesa cadastrada')).toBeInTheDocument();
    expect(api.get).toHaveBeenCalledWith('/tables/tournament/t1');
  });

  it('sem internet a tela admite que não sabe, em vez de inventar', async () => {
    isOnline.mockReturnValue(false);
    await montar({ dias: [DIA_AUTO], mesas: [] });
    await abrirModal();
    await preencher();
    expect(await screen.findByText('Sem conexão')).toBeInTheDocument();
    expect(avisoSemMesa()).toBeNull();
    expect(api.get).not.toHaveBeenCalledWith('/tables/day/d1');
  });

  it('a tarja "Sem conexão" sai quando a internet volta com o formulário aberto', async () => {
    // O balcão abre o Caixa offline e a internet volta com o formulário ainda
    // na tela. Lida uma vez só na abertura, a tarja ficava presa mentindo — e
    // aviso que mente é aviso que o operador aprende a ignorar, junto com o de
    // mesa não configurada, que é o que o cliente pediu para aparecer.
    isOnline.mockReturnValue(false);
    await montar({ dias: [DIA_AUTO], mesas: [] });
    await abrirModal();
    await preencher();
    expect(await screen.findByText('Sem conexão')).toBeInTheDocument();

    mudarConectividade(true);

    expect(await screen.findByText('Nenhuma mesa cadastrada')).toBeInTheDocument();
    expect(screen.queryByText('Sem conexão')).toBeNull();
    expect(api.get).toHaveBeenCalledWith('/tables/day/d1');
  });

  it('a tarja "Sem conexão" aparece quando a internet cai com o formulário aberto', async () => {
    await montar({ dias: [DIA_AUTO], mesas: [] });
    await abrirModal();
    await preencher();
    expect(await screen.findByText('Nenhuma mesa cadastrada')).toBeInTheDocument();

    mudarConectividade(false);

    expect(await screen.findByText('Sem conexão')).toBeInTheDocument();
    expect(avisoSemMesa()).toBeNull();
  });
});

/**
 * O bilhete tem de dizer POR QUE saiu sem assento: "mesas cheias" é fila de
 * alternados; "nenhuma mesa cadastrada" é configuração faltando, e o staff
 * fica procurando uma fila que não existe se os dois papéis forem iguais.
 */
describe('bilhete sem assento: por que saiu assim', () => {
  it('sem mesa ativa o bilhete diz que falta configurar, não que há fila', async () => {
    api.post.mockRejectedValue({
      response: { data: { detail: 'No active tables available for this day' } },
    });
    await montar({ dias: [DIA_AUTO], mesas: [] });
    await abrirModal();
    await preencher();
    await enviar();
    expect(await screen.findByTestId('bilhete')).toBeInTheDocument();
    expect(screen.getByText('Registrado — nenhuma mesa cadastrada')).toBeInTheDocument();
    expect(screen.getByText(/não entrou em fila de alternados/)).toBeInTheDocument();
  });

  it('mesas cheias mantêm o bilhete de alternado, que aí está certo', async () => {
    api.post.mockRejectedValue({ response: { data: { detail: 'All tables are full' } } });
    await montar({ dias: [DIA_AUTO] });
    await abrirModal();
    await preencher();
    await enviar();
    expect(await screen.findByTestId('bilhete-alternado')).toHaveTextContent('true');
    expect(screen.getByText('cashRegister.registeredAsAlternate')).toBeInTheDocument();
    expect(screen.queryByText(/não entrou em fila de alternados/)).toBeNull();
  });

  it('offline o bilhete promete o assento no sync, não uma fila', async () => {
    offlineWrite.mockResolvedValue({ offline: true, data: { id: 'uuid-1' } });
    offlineRead.mockResolvedValue({ name: 'Ana' });
    isOnline.mockReturnValue(false);
    await montar({ dias: [DIA_AUTO] });
    await abrirModal();
    await preencher();
    await enviar();
    expect(await screen.findByTestId('bilhete')).toBeInTheDocument();
    expect(screen.getByText(/assento é definido na sincronização/)).toBeInTheDocument();
    expect(screen.queryByText(/não entrou em fila de alternados/)).toBeNull();
  });

  it('rebuy sem mesa ativa também explica o motivo', async () => {
    api.post.mockRejectedValue({ response: { data: { detail: 'No active tables available' } } });
    await montar({ dias: [DIA_AUTO], mesas: [] });
    await abrirModal();
    await preencher({ tipo: 'b2' });
    await enviar();
    expect(await screen.findByText('Registrado — nenhuma mesa cadastrada')).toBeInTheDocument();
  });
});


describe('reentrada traz de volta um eliminado', () => {
  /** Toda reentrada traz de volta UM jogador eliminado; sem eliminado o
   *  servidor recusa. A tela antecipa isso para o operador não descobrir só
   *  depois de cobrar: por MESA, o seletor oferece só os eliminados do dia;
   *  em MASSA, avisa quando o contador do dia está em zero. */
  const comoRebuy = async () => {
    await abrirModal();
    await preencher({ tipo: 'b2' });
  };

  it('por mesa, o seletor oferece só os eliminados do dia', async () => {
    offlineRead.mockResolvedValue([
      { id: 'tp1', player_id: 'p1', tournament_day_id: 'd1', status: 'eliminated' },
      { id: 'tp2', player_id: 'p2', tournament_day_id: 'd1', status: 'active' },
    ]);
    await montar({ torneios: [{ ...TORNEIO, elimination_mode: 'table' }] });
    await comoRebuy();
    await waitFor(() =>
      expect(screen.getByLabelText('jogador')).toHaveAttribute('data-permitidos', 'p1')
    );
    expect(screen.getByText('cashRegister.reentryOnlyEliminated')).toBeInTheDocument();
  });

  it('por mesa, sem eliminado no dia, o operador é avisado', async () => {
    offlineRead.mockResolvedValue([
      { id: 'tp1', player_id: 'p1', tournament_day_id: 'd1', status: 'active' },
    ]);
    await montar({ torneios: [{ ...TORNEIO, elimination_mode: 'table' }] });
    await comoRebuy();
    expect(await screen.findByText('cashRegister.reentryNoEliminatedTable')).toBeInTheDocument();
  });

  it('em massa, contador em zero gera aviso (o servidor decide)', async () => {
    await montar({ dias: [{ ...DIA, eliminations_count: 0 }] });
    await comoRebuy();
    expect(await screen.findByText('cashRegister.reentryNoEliminatedBulk')).toBeInTheDocument();
    expect(screen.getByLabelText('jogador')).toHaveAttribute('data-permitidos', 'todos');
  });

  it('em massa, com eliminação no contador, não há aviso', async () => {
    await montar({ dias: [{ ...DIA, eliminations_count: 2 }] });
    await comoRebuy();
    await waitFor(() => expect(screen.getByLabelText('jogador')).toBeInTheDocument());
    expect(screen.queryByText('cashRegister.reentryNoEliminatedBulk')).toBeNull();
  });

  it('add-on não exige eliminado', async () => {
    await montar({ dias: [{ ...DIA, eliminations_count: 0 }] });
    await abrirModal();
    await preencher({ tipo: 'b3' });
    expect(screen.queryByText('cashRegister.reentryNoEliminatedBulk')).toBeNull();
  });
});
