/**
 * O modal de RECEBER: parcial, dividido e crédito, num POST só.
 *
 * O que trava:
 * 1. A soma das pernas nunca passa do saldo (o botão desabilita e diz por quê).
 * 2. A perna de crédito só existe com saldo de crédito, e é limitada a ele.
 * 3. Gaveta fechada trava dinheiro, não crédito.
 * 4. Quando o saldo zera, o modal oferece fechar a comanda na hora.
 * 5. Todo envio leva `client_mutation_id`.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BarPaymentModal from './BarPaymentModal';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { usePaymentMethods } from '../contexts/PaymentMethodsContext';

jest.mock('../config/api', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('../contexts/PaymentMethodsContext', () => ({ usePaymentMethods: jest.fn() }));
jest.mock('../utils/eventosDoCaixa', () => ({ avisarQueOCaixaMudou: jest.fn() }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (chave, padrao, vars) => {
      if (typeof padrao !== 'string') return chave;
      return padrao.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars ? vars[k] : ''));
    },
  }),
}));

const TAB = { id: 'c-1', number: 1, total: 50, paid_amount: 20, pending_count: 1 };
const METODOS = [{ code: 'pix', label: 'PIX' }, { code: 'cash', label: 'Dinheiro' }];

let toast; let onClose; let onPaid; let onCloseTab;

beforeEach(() => {
  jest.clearAllMocks();
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  useToast.mockReturnValue({ toast });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  usePaymentMethods.mockReturnValue({ activeMethods: METODOS });
  onClose = jest.fn(); onPaid = jest.fn(); onCloseTab = jest.fn();
});

const montar = (props = {}) => render(
  <BarPaymentModal tab={TAB} availableCredit={0} onClose={onClose} onPaid={onPaid} onCloseTab={onCloseTab} {...props} />,
);

it('abre com uma perna no valor do saldo', () => {
  montar();
  expect(screen.getByLabelText('Valor')).toHaveValue(30);
  expect(screen.getByRole('button', { name: 'Receber R$ 30.00' })).toBeEnabled();
});

it('não deixa passar do saldo', async () => {
  montar();
  const valor = screen.getByLabelText('Valor');
  await userEvent.clear(valor);
  await userEvent.type(valor, '31');
  expect(screen.getByRole('alert')).toHaveTextContent(/excede o saldo/);
  expect(screen.getByRole('button', { name: /Receber/ })).toBeDisabled();
});

it('dividir cria outra perna e envia as duas num POST só, com client_mutation_id', async () => {
  api.post.mockResolvedValue({ data: { tab: { ...TAB, paid_amount: 50 } } });
  montar();
  const valor = screen.getByLabelText('Valor');
  await userEvent.clear(valor);
  await userEvent.type(valor, '20');
  await userEvent.click(screen.getByRole('button', { name: '+ Outra forma' }));
  const pernas = screen.getAllByTestId('perna');
  expect(pernas).toHaveLength(2);
  // A segunda perna nasce com o que falta.
  expect(within(pernas[1]).getByLabelText('Valor')).toHaveValue(10);
  await userEvent.selectOptions(within(pernas[1]).getByLabelText('Forma de pagamento'), 'cash');
  await userEvent.click(screen.getByRole('button', { name: 'Receber R$ 30.00' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/bar/tabs/c-1/payments', {
    legs: [
      { payment_method: 'pix', amount: 20, payment_source: 'cash' },
      { payment_method: 'cash', amount: 10, payment_source: 'cash' },
    ],
    client_mutation_id: expect.any(String),
  }));
});

it('sem crédito não oferece a perna de crédito', () => {
  montar({ availableCredit: 0 });
  expect(screen.queryByRole('button', { name: /Usar crédito/ })).toBeNull();
});

it('crédito é limitado ao disponível e avisa que é do patrocinador', async () => {
  montar({ availableCredit: 15 });
  await userEvent.click(screen.getByRole('button', { name: 'Usar crédito (R$ 15.00)' }));
  const pernas = screen.getAllByTestId('perna');
  expect(pernas).toHaveLength(2);
  expect(within(pernas[1]).getByText('Crédito do jogador')).toBeInTheDocument();
  // 30 de saldo − 30 da primeira perna = 0 restante → usa o próprio saldo, limitado a 15.
  expect(within(pernas[1]).getByLabelText('Valor')).toHaveValue(15);
  expect(screen.getByText(/crédito é do patrocinador/)).toBeInTheDocument();
  // Passar do crédito é recusado.
  await userEvent.clear(within(pernas[1]).getByLabelText('Valor'));
  await userEvent.type(within(pernas[1]).getByLabelText('Valor'), '16');
  await userEvent.clear(within(pernas[0]).getByLabelText('Valor'));
  await userEvent.type(within(pernas[0]).getByLabelText('Valor'), '10');
  expect(screen.getByRole('alert')).toHaveTextContent(/crédito suficiente/);
});

it('gaveta fechada trava dinheiro mas não crédito', async () => {
  montar({ availableCredit: 30, cashboxBlocked: true });
  expect(screen.getByText(/Seu caixa está fechado/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Receber/ })).toBeDisabled();
  // Zera a perna de dinheiro e usa só crédito.
  await userEvent.clear(screen.getByLabelText('Valor'));
  await userEvent.type(screen.getByLabelText('Valor'), '0');
  await userEvent.click(screen.getByRole('button', { name: /Usar crédito/ }));
  expect(screen.getByRole('button', { name: 'Receber R$ 30.00' })).toBeEnabled();
});

it('ao quitar, oferece fechar a comanda e avisa dos pendentes', async () => {
  api.post.mockResolvedValue({ data: { tab: { ...TAB, paid_amount: 50, pending_count: 1 } } });
  montar();
  await userEvent.click(screen.getByRole('button', { name: 'Receber R$ 30.00' }));
  expect(await screen.findByText('Comanda quitada.')).toBeInTheDocument();
  expect(screen.getByText(/1 item\(ns\) ainda pendente/)).toBeInTheDocument();
  expect(onPaid).toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Fechar comanda' }));
  expect(onCloseTab).toHaveBeenCalled();
});

it('pagamento parcial fecha o modal e mantém a comanda', async () => {
  api.post.mockResolvedValue({ data: { tab: { ...TAB, paid_amount: 30 } } });
  montar();
  await userEvent.clear(screen.getByLabelText('Valor'));
  await userEvent.type(screen.getByLabelText('Valor'), '10');
  await userEvent.click(screen.getByRole('button', { name: 'Receber R$ 10.00' }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(screen.queryByText('Comanda quitada.')).toBeNull();
});

it('a recusa do servidor vira toast', async () => {
  api.post.mockRejectedValue({ userMessage: 'Abra o seu caixa antes de vender.' });
  montar();
  await userEvent.click(screen.getByRole('button', { name: /Receber/ }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Abra o seu caixa antes de vender.'));
});
