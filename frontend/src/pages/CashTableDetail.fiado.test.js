/**
 * FIADO na mesa de cash.
 *
 * O que estes testes travam:
 * 1. "Fiado" só aparece como opção para quem o gerente liberou, com saldo.
 * 2. Venda fiada vai como ORIGEM (`payment_source`), sem meio — e oferece o
 *    vale para assinatura.
 * 3. Cash-out de quem deve mostra fichas · dívida · líquido e manda o
 *    abatimento SEMPRE explícito; abater menos exige motivo.
 * 4. Se a tela não sabia da dívida, o 409 do servidor abre o quadro do
 *    abatimento em vez de pagar o bruto.
 */
import { render, screen, waitFor } from '@testing-library/react';
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
  if (onStateChange) onStateChange(global.__caixa);
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
jest.mock('../hooks/useRealtimeRefresh', () => () => {});
jest.mock('react-router-dom', () => ({
  useParams: () => ({ tableId: 'mesa-1' }),
  useNavigate: () => jest.fn(),
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
  id: 'mesa-1', cash_day_id: 'dia-1', table_number: 3, seats: 2, min_buy_in: 100,
  max_buy_in: 1000, status: 'open', game_type_name: 'NLH 1/2', rake_partial: 0,
};
const SENTADA = {
  id: 'a1', table_id: 'mesa-1', seat_number: 1, status: 'occupied', player_session_id: 's1',
  player_id: 'p1', player_name: 'Ana', total_buy_in: 500,
};
const LIVRE = { id: 'a2', table_id: 'mesa-1', seat_number: 2, status: 'free' };

const conta = (extra = {}) => ({
  player_id: 'p1', exists: true, enabled: true, credit_limit: 1000, balance: 0,
  available: 1000, blocked: false, ...extra,
});

let toast;
const montar = ({ contaJogador = conta(), saldos = [], caixa = { status: 'open', current_balance: 1000 } } = {}) => {
  global.__caixa = caixa;
  api.get.mockImplementation((url, config) => {
    if (url.endsWith('/seats')) return Promise.resolve({ data: [SENTADA, LIVRE] });
    if (url.endsWith('/rake-entries')) return Promise.resolve({ data: [] });
    if (url === '/house-credit/balances') return Promise.resolve({ data: saldos });
    if (url.startsWith('/house-credit/players/')) {
      return contaJogador ? Promise.resolve({ data: contaJogador }) : Promise.reject(new Error('rede'));
    }
    if (config?.params?.cash_day_id) return Promise.resolve({ data: [MESA] });
    return Promise.resolve({ data: MESA });
  });
  return render(<CashTableDetail />);
};

beforeEach(() => {
  jest.clearAllMocks();
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  useToast.mockReturnValue({ toast });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  usePaymentMethods.mockReturnValue({ activeMethods: [{ code: 'cash', label: 'Dinheiro' }] });
  useCashDay.mockReturnValue({ cashDayId: 'dia-1' });
  api.post.mockResolvedValue({ data: {} });
});

describe('vender no fiado', () => {
  it('opção aparece para quem tem fiado liberado e vai como origem, sem meio', async () => {
    montar({ contaJogador: conta({ available: 600 }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Recompra' }));
    const metodo = await screen.findByLabelText('Meio de pagamento');
    await waitFor(() => expect(screen.getByRole('option', { name: 'Fiado (disponível R$ 600.00)' })).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('Valor'), '300');
    await userEvent.selectOptions(metodo, 'house_credit');
    expect(screen.getByText(/nada entra no seu caixa/)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Recompra' }).pop());
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const [url, corpo] = api.post.mock.calls[0];
    expect(url).toBe('/cash-game/player-sessions/s1/rebuy');
    expect(corpo).toMatchObject({ amount: 300, payment_source: 'house_credit', payment_method: null });
    expect(corpo.client_mutation_id).toBeTruthy();
    expect(await screen.findByText('Venda no fiado registrada')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Imprimir vale' })).toBeInTheDocument();
  });

  it('sem fiado liberado não há a opção', async () => {
    montar({ contaJogador: conta({ enabled: false, available: 0 }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Recompra' }));
    await screen.findByLabelText('Meio de pagamento');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/house-credit/players/p1', expect.anything()));
    expect(screen.queryByRole('option', { name: /Fiado/ })).not.toBeInTheDocument();
  });

  it('fiado acima do disponível não deixa enviar', async () => {
    montar({ contaJogador: conta({ available: 200 }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Recompra' }));
    await waitFor(() => expect(screen.getByRole('option', { name: /Fiado/ })).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText('Valor'), '300');
    await userEvent.selectOptions(screen.getByLabelText('Meio de pagamento'), 'house_credit');
    expect(screen.getAllByRole('button', { name: 'Recompra' }).pop()).toBeDisabled();
  });
});

describe('cash-out de quem deve', () => {
  it('abate a dívida das fichas e paga só o líquido', async () => {
    montar({ contaJogador: conta({ balance: 500, available: 500 }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Levantar' }));
    await userEvent.type(await screen.findByLabelText('Cash-out'), '800');
    expect(await screen.findByText('Fiado em aberto')).toBeInTheDocument();
    expect(screen.getByText('R$ 300.00')).toBeInTheDocument();   // pagar ao jogador
    await userEvent.click(screen.getAllByRole('button', { name: 'Levantar' }).pop());
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1]).toMatchObject({ cash_out_amount: 800, debt_offset_amount: 500 });
  });

  it('abater menos exige motivo', async () => {
    montar({ contaJogador: conta({ balance: 500, available: 500 }) });
    await userEvent.click(await screen.findByRole('button', { name: 'Levantar' }));
    await userEvent.type(await screen.findByLabelText('Cash-out'), '800');
    const abater = await screen.findByLabelText('Abater do cash-out');
    await userEvent.clear(abater);
    await userEvent.type(abater, '100');
    const enviar = screen.getAllByRole('button', { name: 'Levantar' }).pop();
    expect(enviar).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Motivo para abater menos'), 'acordo');
    expect(enviar).toBeEnabled();
    await userEvent.click(enviar);
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1]).toMatchObject({ debt_offset_amount: 100, debt_offset_reason: 'acordo' });
  });

  it('gaveta é conferida contra o líquido', async () => {
    montar({ contaJogador: conta({ balance: 500 }), caixa: { status: 'open', current_balance: 350 } });
    await userEvent.click(await screen.findByRole('button', { name: 'Levantar' }));
    await userEvent.type(await screen.findByLabelText('Cash-out'), '800');
    await screen.findByText('Fiado em aberto');
    // Líquido 300 ≤ 350: pode pagar, embora as fichas (800) passem da gaveta.
    expect(screen.getAllByRole('button', { name: 'Levantar' }).pop()).toBeEnabled();
  });

  it('a recusa "jogador com fiado" abre o quadro do abatimento', async () => {
    montar({ contaJogador: null });
    api.post.mockRejectedValueOnce({
      userMessage: 'Este jogador deve fiado',
      response: { status: 409, data: { detail: { code: 'jogador_com_fiado', divida: 200, abatimento_sugerido: 200 } } },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Levantar' }));
    await userEvent.type(await screen.findByLabelText('Cash-out'), '500');
    await userEvent.click(screen.getAllByRole('button', { name: 'Levantar' }).pop());
    expect(await screen.findByText('Fiado em aberto')).toBeInTheDocument();
    expect(toast.warning).toHaveBeenCalled();
  });
});

describe('cadeira', () => {
  it('mostra quanto o jogador deve', async () => {
    montar({ saldos: [{ player_id: 'p1', balance: 250, enabled: true, available: 0, overdue: false }] });
    expect(await screen.findByRole('button', { name: 'Deve R$ 250.00' })).toBeInTheDocument();
  });
});
