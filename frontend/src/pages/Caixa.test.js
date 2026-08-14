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
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Caixa from './Caixa';
import api from '../config/api';
import { offlineWrite, offlineRead } from '../offline/apiOffline';
import { isOnline } from '../offline/connectivity';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { usePaymentMethods } from '../contexts/PaymentMethodsContext';
import { useBuyTypes } from '../contexts/BuyTypesContext';
import { useStage } from '../contexts/StageContext';
import { usePermissions } from '../contexts/PermissionContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../offline/apiOffline', () => ({ offlineWrite: jest.fn(), offlineRead: jest.fn() }));
jest.mock('../offline/connectivity', () => ({ isOnline: jest.fn(() => true) }));
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
jest.mock('../components/PlayerSelect', () => ({ value, onChange, name }) => (
  <select
    aria-label="jogador"
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

// Os tipos de buy são a fonte da categoria e do rake por transação — quando
// existem. Sem nenhum à mão a tela CONTINUA vendendo, pela categoria e com o
// rake do dia. O cenário padrão dos testes tem um tipo de cada categoria.
const TIPOS = [
  { id: 'b1', name: 'Entrada normal', category: 'buy_in', rake_percentage: 20, active: true },
  { id: 'b2', name: 'Recompra turbo', category: 'rebuy', rake_percentage: 10, active: true },
  { id: 'b3', name: 'Add-on padrão', category: 'addon', rake_percentage: 15, active: true },
];

const ETAPA = { id: 'e1', name: 'Etapa Rio' };

let toast;

const responder = ({
  transacoes = TRANSACOES,
  torneios = [TORNEIO],
  dias = DIAS,
  credito = 0,
  alocacoes = [],
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

/** Preenche torneio → dia → jogador → tipo de buy, a ordem real de uso. */
const preencher = async ({ dia = 'd1', jogador = 'p1', tipo = 'b1' } = {}) => {
  await userEvent.selectOptions(screen.getByLabelText('cashRegister.tournament'), 't1');
  if (dia) {
    await userEvent.selectOptions(await screen.findByLabelText('cashRegister.day'), dia);
  }
  if (jogador) await userEvent.selectOptions(screen.getByLabelText('jogador'), jogador);
  if (tipo) await userEvent.selectOptions(screen.getByLabelText('Tipo de Buy'), tipo);
};

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
  useBuyTypes.mockReturnValue({ activeBuyTypes: TIPOS, stageId: 'e1', tiposCarregados: true });
  useStage.mockReturnValue({ selectedStage: ETAPA });
  usePermissions.mockReturnValue({ isAdmin: true, hasPermission: () => true });
  isOnline.mockReturnValue(true);
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
  it('escolher o torneio carrega os dias', async () => {
    await montar();
    await abrirModal();
    await userEvent.selectOptions(screen.getByLabelText('cashRegister.tournament'), 't1');
    expect(await screen.findByLabelText('cashRegister.day')).toBeInTheDocument();
  });

  it('só oferece dias que ainda recebem entrada', async () => {
    // Dia encerrado e FINAL não vendem buy-in; oferecê-los é convidar ao erro.
    await montar();
    await abrirModal();
    await userEvent.selectOptions(screen.getByLabelText('cashRegister.tournament'), 't1');
    const dia = await screen.findByLabelText('cashRegister.day');
    expect(within(dia).getByText(/Dia 1A/)).toBeInTheDocument();
    expect(within(dia).queryByText(/Dia 2/)).toBeNull();
    expect(within(dia).queryByText(/Final/)).toBeNull();
  });

  it('o dia mostra a lotação, para o operador ver se ainda cabe', async () => {
    await montar();
    await abrirModal();
    await userEvent.selectOptions(screen.getByLabelText('cashRegister.tournament'), 't1');
    const dia = await screen.findByLabelText('cashRegister.day');
    expect(within(dia).getByText(/10\/100/)).toBeInTheDocument();
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

  it('havendo dias, enviar sem escolher um é recusado', async () => {
    // O dia é quem define o valor e a lotação; sem ele a entrada não tem onde
    // ser contada. (fireEvent.submit pula a validação nativa do navegador,
    // que aqui esconderia a regra da aplicação.)
    await montar();
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
  it('o valor vem do DIA, não do torneio', async () => {
    // Cobrar os 500 do torneio num Dia 1A de 1000 é cobrar errado do jogador
    // na frente dele.
    await montar();
    await abrirModal();
    await preencher();
    expect(screen.getByLabelText('cashRegister.amount')).toHaveValue(1000);
  });

  it.each([
    ['b2', 600],
    ['b3', 400],
  ])('escolher o tipo %s recobra o valor do dia (%i)', async (tipo, valor) => {
    // A categoria vem do TIPO de buy; o VALOR continua vindo do dia.
    await montar();
    await abrirModal();
    await preencher({ tipo });
    expect(screen.getByLabelText('cashRegister.amount')).toHaveValue(valor);
  });

  it('dia sem valor próprio de rebuy cai no buy-in do dia', async () => {
    await montar({ dias: [{ ...DIA, rebuy_amount: null }] });
    await abrirModal();
    await preencher({ tipo: 'b2' });
    expect(screen.getByLabelText('cashRegister.amount')).toHaveValue(1000);
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

  it('recompra dupla envia um rebuy por unidade', async () => {
    // O jogador pede duas de uma vez; contar uma só cobraria metade.
    await montar();
    await comoRebuy();
    const qtd = screen.getByLabelText('Quantidade de rebuys');
    await userEvent.clear(qtd);
    await userEvent.type(qtd, '3');
    await enviar();
    await waitFor(() =>
      expect(offlineWrite.mock.calls.filter((c) => c[0].url.includes('/rebuy')).length).toBe(3)
    );
  });

  it('quantidade inválida vira uma recompra, não zero', async () => {
    await montar();
    await comoRebuy();
    const qtd = screen.getByLabelText('Quantidade de rebuys');
    await userEvent.clear(qtd);
    await enviar();
    await waitFor(() =>
      expect(offlineWrite.mock.calls.filter((c) => c[0].url.includes('/rebuy')).length).toBe(1)
    );
  });

  it('cada rebuy leva chave de idempotência própria', async () => {
    // Duas recompras iguais no mesmo segundo não podem colapsar numa só no
    // replay da fila.
    await montar();
    await comoRebuy();
    const qtd = screen.getByLabelText('Quantidade de rebuys');
    await userEvent.clear(qtd);
    await userEvent.type(qtd, '2');
    await enviar();
    await waitFor(() =>
      expect(offlineWrite.mock.calls.filter((c) => c[0].url.includes('/rebuy')).length).toBe(2)
    );
    const ids = offlineWrite.mock.calls
      .filter((c) => c[0].url.includes('/rebuy'))
      .map((c) => c[0].clientMutationId);
    expect(new Set(ids).size).toBe(2);
  });

  it('jogador eliminado sai do ranking antes de voltar ao jogo', async () => {
    // Se ele recomprou, não terminou naquela posição — deixar o ranking
    // antigo daria prêmio a quem ainda está jogando.
    offlineRead.mockResolvedValue([{ ...JOGADOR_TORNEIO, status: 'eliminated' }]);
    await montar();
    await comoRebuy();
    await enviar();
    await waitFor(() =>
      expect(api.delete).toHaveBeenCalledWith('/rankings/tournament-player/tp1/ranking')
    );
  });

  it('offline não tenta mexer no ranking', async () => {
    // A remoção do ranking é online-only; tentar sem rede só geraria erro.
    isOnline.mockReturnValue(false);
    offlineRead.mockResolvedValue([{ ...JOGADOR_TORNEIO, status: 'eliminated' }]);
    await montar();
    await comoRebuy();
    await enviar();
    await waitFor(() => expect(chamada('/rebuy')).toBeTruthy());
    expect(api.delete).not.toHaveBeenCalled();
  });

  it('falha ao sair do ranking não impede a recompra', async () => {
    offlineRead.mockResolvedValue([{ ...JOGADOR_TORNEIO, status: 'eliminated' }]);
    api.delete.mockRejectedValue(new Error('500'));
    await montar();
    await comoRebuy();
    await enviar();
    await waitFor(() => expect(chamada('/rebuy')).toBeTruthy());
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

describe('tipos de buy', () => {
  it('só existe o seletor de TIPO — não há mais escolha solta de categoria', async () => {
    // O tipo de buy é a fonte única da categoria e do rake; um select de
    // categoria ao lado permitiria vender "add-on" com um tipo de buy-in, com
    // rake que o financeiro nunca configurou.
    await montar();
    await abrirModal();
    expect(screen.getByLabelText('Tipo de Buy')).toBeInTheDocument();
    expect(screen.queryByLabelText('cashRegister.type')).toBeNull();
  });

  it('não existe mais a opção "Manual"', async () => {
    // "Manual" virava buy-in em silêncio, com o rake do dia — era a 4ª opção
    // não homologada de que o clube reclamou.
    await montar();
    await abrirModal();
    const select = screen.getByLabelText('Tipo de Buy');
    const opcoes = Array.from(select.querySelectorAll('option'));
    expect(opcoes.filter((o) => !o.disabled).map((o) => o.value)).toEqual(['b1', 'b2', 'b3']);
    expect(opcoes[0].disabled).toBe(true);
  });

  it('o tipo escolhido define a categoria da transação', async () => {
    await montar();
    await abrirModal();
    await preencher({ tipo: 'b2' });
    // categoria virou rebuy → o campo de quantidade de recompras aparece
    expect(screen.getByLabelText('Quantidade de rebuys')).toBeInTheDocument();
  });

  it('o tipo vai junto na transação, porque ele carrega o rake', async () => {
    await montar();
    await abrirModal();
    await preencher({ tipo: 'b1' });
    await enviar();
    await waitFor(() => expect(chamada('/tournament-players')).toBeTruthy());
    expect(chamada('/tournament-players')[0].body.buy_type_id).toBe('b1');
  });

  it('mostra o rake de cada tipo na hora de escolher', async () => {
    await montar();
    await abrirModal();
    const select = screen.getByLabelText('Tipo de Buy');
    expect(within(select).getByText(/20% rake/)).toBeInTheDocument();
  });

  it('enviar sem escolher o tipo é recusado e não chama a API', async () => {
    await montar();
    await abrirModal();
    await preencher({ tipo: null });
    fireEvent.submit(document.querySelector('.modal form'));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('Escolha o tipo de buy.')
    );
    expect(offlineWrite).not.toHaveBeenCalled();
  });

  it('o valor é somente leitura: quem manda é a configuração do dia', async () => {
    // O backend IGNORA o que for digitado aqui. Editável, o campo prometia um
    // desconto que nunca aconteceria.
    await montar();
    await abrirModal();
    await preencher();
    expect(screen.getByLabelText('cashRegister.amount')).toHaveAttribute('readonly');
  });

  it('sem etapa selecionada a mensagem é outra', async () => {
    // Mandar o operador ao Financeiro quando o problema é não ter etapa
    // escolhida faz ele procurar um cadastro que já existe.
    useBuyTypes.mockReturnValue({ activeBuyTypes: [], stageId: null, tiposCarregados: false });
    await montar();
    expect(screen.getByText('Selecione uma etapa para vender.')).toBeInTheDocument();
    expect(screen.queryByText(/Tipos de Buy/)).toBeNull();
  });

  it('quem não mexe no financeiro não recebe o atalho', async () => {
    useBuyTypes.mockReturnValue({ activeBuyTypes: [], stageId: 'e1', tiposCarregados: true });
    usePermissions.mockReturnValue({ isAdmin: false, hasPermission: () => false });
    await montar();
    expect(screen.queryByText('Ir para o Financeiro')).toBeNull();
  });

  it('o extrato mostra o NOME do tipo vendido', async () => {
    await montar({
      transacoes: [{ ...TRANSACOES[0], buy_type_id: 'b1' }],
    });
    expect(screen.getByText('Entrada normal')).toBeInTheDocument();
  });

  it('venda antiga sem tipo cai no rótulo da categoria', async () => {
    // Vendas anteriores aos tipos de buy não podem sumir do extrato.
    await montar({ transacoes: [TRANSACOES[1]] });
    expect(screen.getByText('Rebuy')).toBeInTheDocument();
  });
});

describe('sem tipos de buy à mão o caixa não pode parar', () => {
  /**
   * Lista vazia tinha três causas — etapa sem cadastro, consulta que falhou
   * (sessão/RLS) e modo OFFLINE — e todas travavam a venda com a mesma
   * mensagem: "cadastre um tipo de buy". No evento isso é o operador sem
   * conseguir registrar ninguém, sendo mandado cadastrar o que já existe.
   * A saída é vender pela CATEGORIA, com o rake do dia — como antes dos
   * tipos de buy.
   */
  const semTipos = (extra = {}) =>
    useBuyTypes.mockReturnValue({
      activeBuyTypes: [], stageId: 'e1', tiposCarregados: true, ...extra,
    });

  /** Preenche torneio → dia → jogador → categoria. */
  const preencherPorCategoria = async (categoria = 'buy_in') => {
    await userEvent.selectOptions(screen.getByLabelText('cashRegister.tournament'), 't1');
    await userEvent.selectOptions(await screen.findByLabelText('cashRegister.day'), 'd1');
    await userEvent.selectOptions(screen.getByLabelText('jogador'), 'p1');
    await userEvent.selectOptions(screen.getByLabelText('Categoria'), categoria);
  };

  it('o botão de nova transação continua habilitado', async () => {
    semTipos();
    await montar();
    expect(screen.getByRole('button', { name: 'cashRegister.newTransaction' })).toBeEnabled();
  });

  it('registra o jogador escolhendo a categoria, sem tipo de buy', async () => {
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
    await userEvent.selectOptions(await screen.findByLabelText('cashRegister.day'), 'd1');
    await userEvent.selectOptions(screen.getByLabelText('jogador'), 'p1');
    fireEvent.submit(document.querySelector('.modal form'));
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith('Escolha a categoria da entrada.')
    );
    expect(offlineWrite).not.toHaveBeenCalled();
  });

  it('etapa sem cadastro avisa, mas o aviso não trava nada', async () => {
    semTipos();
    await montar();
    expect(screen.getByText(/Tipos de Buy/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'cashRegister.newTransaction' })).toBeEnabled();
  });

  it('lista vazia por falha de consulta NÃO vira "cadastre um tipo"', async () => {
    // Offline / sessão expirada: mandar cadastrar o que já está cadastrado faz
    // o operador perder o evento procurando um problema que não existe.
    semTipos({ tiposCarregados: false });
    await montar();
    expect(screen.queryByText(/Tipos de Buy/)).toBeNull();
    expect(screen.getByRole('button', { name: 'cashRegister.newTransaction' })).toBeEnabled();
  });

  it('offline, sem os tipos carregados, ainda registra o jogador', async () => {
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
