/**
 * Bar × FIADO: o bar não vende no fiado, mas RECEBE o que o jogador deve —
 * separado da comanda (pagamento de dívida não é venda do bar) e na gaveta do
 * TURNO, inclusive quando a comanda já não tem saldo.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BarTabPanel from './BarTabPanel';
import { buscarContaFiado } from '../utils/fiado';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../config/api', () => ({ __esModule: true, default: { post: jest.fn(), get: jest.fn() } }));
jest.mock('./BarPaymentModal', () => () => <div data-testid="payment-modal" />);
jest.mock('./fiado/ReceberFiadoModal', () => ({ ancora, conta }) => (
  <div data-testid="receber-fiado">{JSON.stringify(ancora)}|{conta?.balance}</div>
));
jest.mock('../utils/fiado', () => ({ buscarContaFiado: jest.fn() }));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('../utils/eventosDoCaixa', () => ({ avisarQueOCaixaMudou: jest.fn() }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (chave, padrao, vars) => {
      if (typeof padrao !== 'string') return chave;
      return padrao.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars ? vars[k] : ''));
    },
  }),
}));

const TAB = {
  id: 'c-1', number: 3, player_id: 'p1', player_name: 'Ana', bar_shift_id: 'turno-1',
  status: 'open', subtotal: 50, courtesy_amount: 0, discount_amount: 0, total: 50,
  paid_amount: 50, balance_due: 0,
};

beforeEach(() => {
  jest.clearAllMocks();
  useToast.mockReturnValue({ toast: { success: jest.fn(), error: jest.fn() } });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
});

it('quem deve fiado pode quitar no bar, mesmo com a comanda paga', async () => {
  buscarContaFiado.mockResolvedValue({ player_id: 'p1', exists: true, balance: 120 });
  render(<BarTabPanel detail={{ tab: TAB, items: [{ id: 'i', status: 'delivered', line_total: 50 }], payments: [] }} />);
  const botao = await screen.findByRole('button', { name: 'Quitar fiado (deve R$ 120.00)' });
  await userEvent.click(botao);
  // Na gaveta do TURNO do bar — nunca adivinhada.
  expect(screen.getByTestId('receber-fiado')).toHaveTextContent('{"bar_shift_id":"turno-1"}|120');
});

it('sem dívida, nada de fiado na comanda', async () => {
  buscarContaFiado.mockResolvedValue({ player_id: 'p1', exists: false, balance: 0 });
  render(<BarTabPanel detail={{ tab: TAB, items: [], payments: [] }} />);
  await waitFor(() => expect(buscarContaFiado).toHaveBeenCalledWith('p1'));
  expect(screen.queryByRole('button', { name: /Quitar fiado/ })).toBeNull();
});

it('gaveta fechada trava o recebimento', async () => {
  buscarContaFiado.mockResolvedValue({ player_id: 'p1', exists: true, balance: 50 });
  render(<BarTabPanel cashboxBlocked detail={{ tab: TAB, items: [], payments: [] }} />);
  expect(await screen.findByRole('button', { name: /Quitar fiado/ })).toBeDisabled();
});
