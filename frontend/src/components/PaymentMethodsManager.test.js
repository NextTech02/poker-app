/**
 * Cadastro das formas de pagamento. O operador digita o nome e o banco recusa
 * código repetido: a tela precisa dizer que o método já existe, porque "erro"
 * sozinho fazia o clube tentar de novo a mesma coisa, sem saber o motivo.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import PaymentMethodsManager from './PaymentMethodsManager';
import { usePaymentMethods } from '../contexts/PaymentMethodsContext';
import { useToast } from '../contexts/ToastContext';

jest.mock('../contexts/PaymentMethodsContext', () => ({ usePaymentMethods: jest.fn() }));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('react-i18next', () => {
  const t = (chave) => chave;
  return { useTranslation: () => ({ t, i18n: { language: 'pt-BR' } }) };
});

let toast;
let createMethod;

const adicionar = async (nome) => {
  render(<PaymentMethodsManager />);
  await userEvent.type(screen.getByLabelText('paymentMethods.name'), nome);
  await userEvent.click(screen.getByRole('button', { name: /paymentMethods.add/ }));
};

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn() };
  createMethod = jest.fn().mockResolvedValue();
  useToast.mockReturnValue({ toast, confirm: jest.fn() });
  usePaymentMethods.mockReturnValue({
    methods: [], loading: false, createMethod, updateMethod: jest.fn(), deleteMethod: jest.fn(),
  });
});

it('adiciona o método e limpa o campo', async () => {
  await adicionar('USDC');
  await waitFor(() => expect(toast.success).toHaveBeenCalledWith('paymentMethods.added'));
  expect(createMethod).toHaveBeenCalledWith('USDC');
  expect(screen.getByLabelText('paymentMethods.name')).toHaveValue('');
});

it('método repetido diz que já existe', async () => {
  createMethod.mockRejectedValue({ code: '23505' });
  await adicionar('USDT');
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('paymentMethods.alreadyExists'));
});

it('outro erro continua genérico', async () => {
  createMethod.mockRejectedValue(new Error('sem rede'));
  await adicionar('USDT');
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('common.error'));
});
