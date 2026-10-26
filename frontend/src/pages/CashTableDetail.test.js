/**
 * A MESA de cash game — onde o dinheiro entra e sai.
 *
 * O que estes testes travam:
 *
 * 1. **Sentar e pagar são um passo só.** Cadeira ocupada por quem ainda não
 *    pagou é um estado que não existe na mesa real — e criá-lo produziria
 *    jogador sentado sem fichas na tela e fichas sem dono no caixa.
 * 2. **Cash-out de ZERO é válido.** Quem perdeu tudo levanta do mesmo jeito. Um
 *    `required` que rejeitasse zero travaria o caso mais comum da mesa.
 * 3. **Idempotência em toda escrita de dinheiro.** Duplo clique e retry
 *    acontecem com rede boa; cobrar duas vezes pelo mesmo buy-in é o erro mais
 *    caro que o caixa comete.
 * 4. **Não se fecha mesa com gente sentada.** Sobrariam fichas compradas sem
 *    cash-out, e a variância acusaria um rombo que não existe.
 * 5. **A apuração de rake NÃO move o saldo** — e a tela precisa DIZER isso,
 *    senão o operador procura o dinheiro que "sumiu".
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CashTableDetail from './CashTableDetail';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { usePaymentMethods } from '../contexts/PaymentMethodsContext';
import { useCashDay } from '../contexts/CashDayContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <div data-testid="sidebar" />);
jest.mock('../components/Breadcrumb', () => () => <nav data-testid="breadcrumb" />);
jest.mock('../components/CashboxBanner', () => ({ onStateChange }) => {
  const cb = global.__caixa === undefined ? null : global.__caixa;
  if (onStateChange) onStateChange(cb);
  return <div data-testid="cashbox-banner" />;
});
jest.mock('../components/PlayerSelect', () => ({ value, onChange }) => (
  <input
    aria-label="Jogador"
    value={value || ''}
    onChange={(e) => onChange({ target: { name: 'player_id', value: e.target.value } })}
  />
));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('../contexts/PaymentMethodsContext', () => ({ usePaymentMethods: jest.fn() }));
jest.mock('../contexts/CashDayContext', () => ({ useCashDay: jest.fn() }));
jest.mock('../hooks/usePolling', () => () => {});
const mockNavegar = jest.fn();
jest.mock('react-router-dom', () => ({
  useParams: () => ({ tableId: 'mesa-1' }),
  useNavigate: () => mockNavegar,
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (chave, padrao, vars) => {
      if (typeof padrao !== 'string') return chave;
      return padrao.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars ? vars[k] : ''));
    },
  }),
}));

const MESA = {
  id: 'mesa-1', cash_day_id: 'dia-1', table_number: 3, seats: 3,
  game_variant: 'nlh', small_blind: 1, big_blind: 2, min_buy_in: 100,
  max_buy_in: 400, status: 'open', opened_at: '2026-09-10T21:00:00Z',
  game_type_name: 'NLH 1/2', occupied_seats: 1, free_seats: 2,
  rake_partial: 40, jackpot_partial: 8,
};

const assento = (n, ocupado = false) => ({
  id: `a${n}`, table_id: 'mesa-1', seat_number: n,
  status: ocupado ? 'occupied' : 'free',
  player_session_id: ocupado ? `s${n}` : null,
  player_name: ocupado ? 'Ana' : null,
  total_buy_in: ocupado ? 300 : null,
});

const OUTRA_MESA = {
  id: 'mesa-2', cash_day_id: 'dia-1', table_number: 5, seats: 6,
  game_type_name: 'PLO 2/5', status: 'open', free_seats: 4,
};

const montar = ({
  mesa = MESA, assentos = [assento(1, true), assento(2), assento(3)],
  rakes = [], caixa = { status: 'open' },
  outras = [MESA, OUTRA_MESA],
} = {}) => {
  global.__caixa = caixa;
  api.get.mockImplementation((url, config) => {
    if (url.endsWith('/seats')) return Promise.resolve({ data: assentos });
    if (url.endsWith('/rake-entries')) return Promise.resolve({ data: rakes });
    // A listagem do dia (com params) alimenta o destino da troca de mesa; a
    // busca por id devolve esta mesa.
    if (config?.params?.cash_day_id) return Promise.resolve({ data: outras });
    return Promise.resolve({ data: mesa });
  });
  return render(<CashTableDetail />);
};

beforeEach(() => {
  jest.clearAllMocks();
  global.__caixa = { status: 'open' };
  useToast.mockReturnValue({ toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn() } });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  usePaymentMethods.mockReturnValue({ activeMethods: [{ code: 'cash', label: 'Dinheiro' }] });
  useCashDay.mockReturnValue({ cashDayId: 'dia-1' });
  api.post.mockResolvedValue({ data: {} });
});

describe('mapa de assentos', () => {
  it('cadeira livre oferece sentar', async () => {
    montar();
    expect(await screen.findAllByRole('button', { name: 'Sentar' })).toHaveLength(2);
  });

  it('cadeira ocupada mostra quem está e quanto comprou', async () => {
    montar();
    expect(await screen.findByText('Ana')).toBeInTheDocument();
    expect(screen.getByText('Comprou R$ 300.00')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recompra' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Levantar' })).toBeInTheDocument();
  });

  it('caixa fechado desabilita tudo', async () => {
    montar({ caixa: { status: 'closed' } });
    const sentar = await screen.findAllByRole('button', { name: 'Sentar' });
    sentar.forEach((b) => expect(b).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Recompra' })).toBeDisabled();
  });
});

describe('sentar', () => {
  it('vende as fichas no mesmo passo', async () => {
    montar();
    const botoes = await screen.findAllByRole('button', { name: 'Sentar' });
    await userEvent.click(botoes[0]);

    await userEvent.type(screen.getByLabelText('Jogador'), 'jogador-1');
    const valor = screen.getByLabelText('Buy-in');
    await userEvent.clear(valor);
    await userEvent.type(valor, '200');

    const dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Sentar' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/cash-game/tables/mesa-1/seats/2/sit',
      expect.objectContaining({
        player_id: 'jogador-1',
        buy_in_amount: 200,
        payment_method: 'cash',
      }),
    ));
  });

  it('manda um id de idempotência', async () => {
    // Sem ele, um duplo clique cobra duas vezes o mesmo buy-in.
    montar();
    const botoes = await screen.findAllByRole('button', { name: 'Sentar' });
    await userEvent.click(botoes[0]);
    await userEvent.type(screen.getByLabelText('Jogador'), 'jogador-1');
    const dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Sentar' }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].client_mutation_id).toBeTruthy();
  });

  it('sem jogador escolhido não envia', async () => {
    montar();
    const botoes = await screen.findAllByRole('button', { name: 'Sentar' });
    await userEvent.click(botoes[0]);
    const dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Sentar' }));
    expect(api.post).not.toHaveBeenCalled();
  });

  it('o modal já vem com o buy-in mínimo da mesa', async () => {
    montar();
    const botoes = await screen.findAllByRole('button', { name: 'Sentar' });
    await userEvent.click(botoes[0]);
    expect(screen.getByLabelText('Buy-in')).toHaveValue(100);
  });
});

describe('levantar', () => {
  it('cash-out de zero é aceito', async () => {
    // Quem perdeu tudo levanta do mesmo jeito — é o caso mais comum da mesa.
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Levantar' }));
    const valor = screen.getByLabelText('Cash-out');
    await userEvent.clear(valor);
    await userEvent.type(valor, '0');

    const dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Levantar' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/cash-game/player-sessions/s1/stand',
      expect.objectContaining({ cash_out_amount: 0 }),
    ));
  });

  it('mostra quanto o jogador comprou, para conferir na hora', async () => {
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Levantar' }));
    // Escopado ao diálogo: a cadeira no fundo mostra o mesmo valor.
    const dialogo = screen.getByRole('dialog');
    expect(within(dialogo).getByText(/Comprou R\$ 300\.00/)).toBeInTheDocument();
  });

  it('não paga mais do que a gaveta tem', async () => {
    // O cash-out sai em dinheiro vivo: acima do saldo o botão trava e avisa.
    montar({ caixa: { status: 'open', current_balance: 150 } });
    await userEvent.click(await screen.findByRole('button', { name: 'Levantar' }));
    const dialogo = screen.getByRole('dialog');
    expect(within(dialogo).getByText('Saldo do seu caixa: R$ 150.00')).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('Cash-out'), '150.01');
    expect(within(dialogo).getByRole('alert')).toBeInTheDocument();
    expect(within(dialogo).getByRole('button', { name: 'Levantar' })).toBeDisabled();

    await userEvent.clear(screen.getByLabelText('Cash-out'));
    await userEvent.type(screen.getByLabelText('Cash-out'), '150');
    expect(within(dialogo).queryByRole('alert')).not.toBeInTheDocument();
    expect(within(dialogo).getByRole('button', { name: 'Levantar' })).toBeEnabled();
  });
});

describe('recompra', () => {
  it('envia o valor', async () => {
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Recompra' }));
    await userEvent.type(screen.getByLabelText('Valor'), '100');
    const dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Recompra' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/cash-game/player-sessions/s1/rebuy',
      expect.objectContaining({ amount: 100 }),
    ));
  });

  it('avisa que o teto da mesa não vale para a recompra', async () => {
    // O teto limita quanto o jogador põe na mesa ao SENTAR; sem o aviso o
    // operador recusaria uma recompra legítima.
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Recompra' }));
    expect(screen.getByText(/não é limitada pelo teto/i)).toBeInTheDocument();
  });
});

describe('rake', () => {
  it('explica que a apuração não move o saldo', async () => {
    montar();
    expect(await screen.findByText(/não move o saldo/i)).toBeInTheDocument();
  });

  it('lança a apuração parcial', async () => {
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Apurar' }));
    await userEvent.type(screen.getByLabelText('Rake contado'), '40');
    await userEvent.type(screen.getByLabelText('Jackpot contado'), '8');
    const dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Apurar' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/cash-game/tables/mesa-1/rake-entries',
      expect.objectContaining({ rake_amount: 40, jackpot_amount: 8 }),
    ));
  });

  it('lista as apurações separando parcial de fechamento', async () => {
    montar({ rakes: [
      { id: 'r1', kind: 'partial', rake_amount: 40, jackpot_amount: 8, counted_at: 'x' },
      { id: 'r2', kind: 'closing', rake_amount: 90, jackpot_amount: 18, counted_at: 'y' },
    ] });
    expect(await screen.findByText('Parcial')).toBeInTheDocument();
    expect(screen.getByText('Fechamento')).toBeInTheDocument();
  });
});

describe('fechar a mesa', () => {
  it('fica bloqueado com jogador sentado', async () => {
    montar();
    expect(await screen.findByRole('button', { name: 'Fechar mesa' })).toBeDisabled();
  });

  it('libera com a mesa vazia e envia a contagem', async () => {
    montar({ assentos: [assento(1), assento(2), assento(3)] });
    await userEvent.click(await screen.findByRole('button', { name: 'Fechar mesa' }));
    await userEvent.type(screen.getByLabelText('Rake contado'), '90');
    const dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Fechar mesa' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/cash-game/tables/mesa-1/close',
      expect.objectContaining({ rake_amount: 90 }),
    ));
    expect(mockNavegar).toHaveBeenCalledWith('/cash');
  });

  it('mesa fechada não oferece nenhuma ação', async () => {
    montar({
      mesa: { ...MESA, status: 'closed', rake_counted: 130, jackpot_counted: 26 },
      assentos: [assento(1), assento(2), assento(3)],
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Fechar mesa' })).toBeNull());
    (await screen.findAllByRole('button', { name: 'Sentar' }))
      .forEach((b) => expect(b).toBeDisabled());
    expect(screen.getByText(/Rake apurado: R\$ 130\.00/)).toBeInTheDocument();
  });
});

describe('trocar de mesa', () => {
  it('não gera lançamento de dinheiro', async () => {
    // O jogador leva as fichas com ele. Tratar como cash-out + buy-in inflaria
    // o giro do dia com dinheiro que nunca passou pela gaveta.
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Mover de mesa' }));
    await userEvent.selectOptions(screen.getByLabelText('Lugar'), '2');
    const dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Mover de mesa' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/cash-game/player-sessions/s1/move',
      { to_table_id: 'mesa-2', to_seat: 2 },
    ));
    // Nenhuma chamada de venda, recompra ou cash-out.
    expect(api.post).toHaveBeenCalledTimes(1);
  });

  it('o modal explica que o dinheiro não se mexe', async () => {
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Mover de mesa' }));
    expect(screen.getByText(/Nada entra nem sai do caixa/)).toBeInTheDocument();
  });

  it('a própria mesa não é destino', async () => {
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Mover de mesa' }));
    const destino = screen.getByLabelText('Mesa de destino');
    expect(within(destino).queryByText(/Mesa 3/)).toBeNull();
    expect(within(destino).getByText(/Mesa 5/)).toBeInTheDocument();
  });

  it('sem outra mesa aberta a ação não aparece', async () => {
    // Mover para lugar nenhum não é uma opção; o botão só confundiria.
    montar({ outras: [MESA] });
    await screen.findByText('Ana');
    expect(screen.queryByRole('button', { name: 'Mover de mesa' })).toBeNull();
  });

  it('mesa fechada não oferece mover', async () => {
    montar({ mesa: { ...MESA, status: 'closed' } });
    await screen.findByText('Ana');
    expect(screen.queryByRole('button', { name: 'Mover de mesa' })).toBeNull();
  });
});


describe('pagamento dividido', () => {
  beforeEach(() => {
    usePaymentMethods.mockReturnValue({
      activeMethods: [{ code: 'cash', label: 'Dinheiro' }, { code: 'transfer', label: 'Transferência' }],
    });
  });

  it('senta com 250 em dinheiro + 150 em transferência', async () => {
    montar();
    const botoes = await screen.findAllByRole('button', { name: 'Sentar' });
    await userEvent.click(botoes[0]);
    await userEvent.type(screen.getByLabelText('Jogador'), 'jogador-1');
    const valor = screen.getByLabelText('Buy-in');
    await userEvent.clear(valor);
    await userEvent.type(valor, '400');

    await userEvent.click(screen.getByLabelText('Dividir pagamento'));
    const parte1 = screen.getByLabelText('Valor da parte 1');
    expect(parte1).toHaveValue(400);
    await userEvent.clear(parte1);
    await userEvent.type(parte1, '250');
    const dialogo = screen.getByRole('dialog');
    // Enquanto as partes não fecham o buy-in, não senta.
    expect(within(dialogo).getByRole('button', { name: 'Sentar' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: '+ Outra forma' }));
    expect(screen.getByLabelText('Valor da parte 2')).toHaveValue(150);
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Sentar' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/cash-game/tables/mesa-1/seats/2/sit',
      expect.objectContaining({
        buy_in_amount: 400,
        // A maior parte é a reserva para um servidor que ainda não divide.
        payment_method: 'cash',
        payment_split: [
          { payment_method: 'cash', amount: 250 },
          { payment_method: 'transfer', amount: 150 },
        ],
      }),
    ));
  });

  it('recompra dividida', async () => {
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Recompra' }));
    await userEvent.type(screen.getByLabelText('Valor'), '100');
    await userEvent.click(screen.getByLabelText('Dividir pagamento'));
    const parte1 = screen.getByLabelText('Valor da parte 1');
    await userEvent.clear(parte1);
    await userEvent.type(parte1, '30');
    await userEvent.click(screen.getByRole('button', { name: '+ Outra forma' }));
    const dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Recompra' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/cash-game/player-sessions/s1/rebuy',
      expect.objectContaining({
        amount: 100,
        payment_method: 'transfer',
        payment_split: [
          { payment_method: 'cash', amount: 30 },
          { payment_method: 'transfer', amount: 70 },
        ],
      }),
    ));
  });

  it('venda de um meio só não manda partes', async () => {
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Recompra' }));
    await userEvent.type(screen.getByLabelText('Valor'), '100');
    const dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Recompra' }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1].payment_split).toBeUndefined();
  });

  it('levantar não oferece dividir', async () => {
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Levantar' }));
    expect(screen.queryByLabelText('Dividir pagamento')).toBeNull();
  });
});
