/**
 * O painel da COMANDA: onde o barman entrega, recebe e fecha; onde o gerente
 * desconta, dá cortesia, estorna e cancela.
 *
 * O que trava:
 * 1. Item entregue só o gerente cancela; o operador vê o botão só no pendente.
 * 2. "Receber" aparece com saldo; "Fechar" aparece com saldo zero.
 * 3. Estorno só em perna de dinheiro, e só para o gerente.
 * 4. Cada ação manda o motivo e devolve o detalhe novo ao pai.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BarTabPanel from './BarTabPanel';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../config/api', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('./BarPaymentModal', () => ({ tab }) => <div data-testid="payment-modal">#{tab.number}</div>);
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
  id: 'c-1', number: 3, player_name: 'Ana', status: 'open', subtotal: 50, courtesy_amount: 0,
  discount_amount: 0, total: 50, paid_amount: 20, balance_due: 30,
};
const ITENS = [
  { id: 'i1', product_name: 'Cerveja', quantity: 2, line_total: 20, status: 'pending', is_courtesy: false },
  { id: 'i2', product_name: 'Porção', quantity: 1, line_total: 30, status: 'delivered', is_courtesy: false },
];
const PAGAMENTOS = [
  { id: 'p1', amount: 20, payment_method: 'pix', payment_source: 'cash', status: 'active' },
];
const DETALHE = { tab: TAB, items: ITENS, payments: PAGAMENTOS, player_available_credit: 0 };

let toast; let onChanged;

beforeEach(() => {
  jest.clearAllMocks();
  toast = { success: jest.fn(), error: jest.fn() };
  useToast.mockReturnValue({ toast });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  onChanged = jest.fn();
  api.post.mockResolvedValue({ data: DETALHE });
});

const montar = (props = {}) => render(
  <BarTabPanel detail={DETALHE} canAdmin={false} onChanged={onChanged} {...props} />,
);

it('mostra itens, totais e o saldo', () => {
  montar();
  expect(screen.getByText('Cerveja')).toBeInTheDocument();
  expect(screen.getByText('Pendente')).toBeInTheDocument();
  expect(screen.getByText('Entregue')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Receber R$ 30.00' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Fechar comanda' })).toBeNull();
});

it('operador entrega o pendente e cancela só o pendente', async () => {
  montar();
  await userEvent.click(screen.getByRole('button', { name: 'Entregar' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/bar/tabs/c-1/items/i1/deliver'));
  expect(onChanged).toHaveBeenCalledWith(DETALHE);
  // Só UM botão Cancelar (o do pendente); o entregue não oferece ao operador.
  expect(screen.getAllByRole('button', { name: 'Cancelar' })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Desconto' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Estornar' })).toBeNull();
});

it('cancelar item pede motivo e manda para o servidor', async () => {
  montar();
  await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
  const dialogo = screen.getByRole('dialog');
  await userEvent.type(within(dialogo).getByLabelText('Motivo'), 'lançou errado');
  await userEvent.click(within(dialogo).getByRole('button', { name: 'Confirmar' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/bar/tabs/c-1/items/i1/cancel', { reason: 'lançou errado' }));
  expect(toast.success).toHaveBeenCalled();
});

it('gerente vê desconto, cortesia, estorno e pode cancelar o entregue', async () => {
  montar({ canAdmin: true });
  expect(screen.getAllByRole('button', { name: 'Cancelar' })).toHaveLength(2);
  expect(screen.getAllByRole('button', { name: 'Cortesia' })).toHaveLength(2);
  expect(screen.getByRole('button', { name: 'Estornar' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Desconto' }));
  const dialogo = screen.getByRole('dialog');
  await userEvent.type(within(dialogo).getByLabelText('Valor do desconto'), '5');
  await userEvent.type(within(dialogo).getByLabelText('Motivo'), 'fidelidade');
  await userEvent.click(within(dialogo).getByRole('button', { name: 'Confirmar' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/bar/tabs/c-1/discount', { amount: 5, reason: 'fidelidade' }));
});

it('estorno é só de perna de dinheiro', () => {
  const detalhe = {
    ...DETALHE,
    payments: [{ id: 'p2', amount: 20, payment_method: 'credit', payment_source: 'credit', status: 'active' }],
  };
  montar({ detail: detalhe, canAdmin: true });
  expect(screen.getByText('Crédito do jogador')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Estornar' })).toBeNull();
});

it('com saldo zero oferece fechar, e fechar entrega os pendentes', async () => {
  const quitada = { ...DETALHE, tab: { ...TAB, paid_amount: 50, balance_due: 0 } };
  api.post.mockResolvedValue({ data: { ...TAB, status: 'closed' } });
  const onClosed = jest.fn();
  montar({ detail: quitada, onClosed });
  expect(screen.queryByRole('button', { name: /Receber/ })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Fechar comanda' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/bar/tabs/c-1/close', { deliver_pending: true }));
  expect(onClosed).toHaveBeenCalled();
});

it('receber abre o modal de pagamento', async () => {
  montar();
  await userEvent.click(screen.getByRole('button', { name: 'Receber R$ 30.00' }));
  expect(screen.getByTestId('payment-modal')).toHaveTextContent('#3');
});

it('comanda fechada só oferece reabrir ao gerente', () => {
  const fechada = { ...DETALHE, tab: { ...TAB, status: 'closed', paid_amount: 50, balance_due: 0 } };
  montar({ detail: fechada, canAdmin: true });
  expect(screen.getByRole('button', { name: 'Reabrir' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Entregar' })).toBeNull();
  expect(screen.queryByRole('button', { name: /Receber/ })).toBeNull();
});
