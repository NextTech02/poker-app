/**
 * Cartão de FIADO na ficha do jogador.
 *
 * Trava: (1) quem não é gerente não vê nada de jogador sem conta; (2) o gerente
 * libera com limite; (3) receber exige a gaveta do módulo (sem ela, o botão
 * explica); (4) baixa pede motivo e vai para a rota do gerente; (5) estorno só
 * aparece em recebimento ainda não estornado.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import FiadoCard from './FiadoCard';
import api from '../../config/api';
import { useToast } from '../../contexts/ToastContext';
import { useCurrency } from '../../contexts/CurrencyContext';
import { usePermissions } from '../../contexts/PermissionContext';
import { useCashDay } from '../../contexts/CashDayContext';
import { useBarShift } from '../../contexts/BarShiftContext';

jest.mock('../../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), put: jest.fn() },
}));
jest.mock('../../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('../../contexts/PermissionContext', () => ({ usePermissions: jest.fn() }));
jest.mock('../../contexts/CashDayContext', () => ({ useCashDay: jest.fn() }));
jest.mock('../../contexts/BarShiftContext', () => ({ useBarShift: jest.fn() }));
jest.mock('../../contexts/PaymentMethodsContext', () => ({
  usePaymentMethods: () => ({ activeMethods: [{ code: 'cash', label: 'Dinheiro' }] }),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'pt-BR' },
    t: (chave, padrao, vars) => {
      if (typeof padrao !== 'string') return chave;
      return padrao.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars ? vars[k] : ''));
    },
  }),
}));

const montar = ({ conta, extrato = [], gerente = true, cashDayId = 'dia-1' }) => {
  usePermissions.mockReturnValue({ hasPermission: (p) => (p === 'fiado.manage' ? gerente : true) });
  useCashDay.mockReturnValue({ cashDayId });
  useBarShift.mockReturnValue({ barShiftId: null });
  api.get.mockImplementation((url) => {
    if (url.endsWith('/entries')) return Promise.resolve({ data: extrato });
    return Promise.resolve({ data: conta });
  });
  return render(<FiadoCard playerId="p1" playerName="Ana" />);
};

beforeEach(() => {
  jest.clearAllMocks();
  useToast.mockReturnValue({ toast: { success: jest.fn(), error: jest.fn() } });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  api.post.mockResolvedValue({ data: {} });
  api.put.mockResolvedValue({ data: {} });
});

it('sem conta e sem ser gerente não mostra nada', async () => {
  const { container } = montar({ conta: { player_id: 'p1', exists: false, balance: 0 }, gerente: false });
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  expect(container).toBeEmptyDOMElement();
});

it('gerente libera o jogador com limite', async () => {
  montar({ conta: { player_id: 'p1', exists: false, balance: 0, credit_limit: 0, available: 0 } });
  await userEvent.click(await screen.findByRole('button', { name: 'Liberar fiado' }));
  const limite = screen.getByLabelText('Limite');
  await userEvent.clear(limite);
  await userEvent.type(limite, '800');
  await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/house-credit/players/p1', {
    enabled: true, credit_limit: 800, notes: null,
  }));
});

it('receber exige a gaveta do módulo', async () => {
  montar({ conta: { player_id: 'p1', exists: true, enabled: true, balance: 300, credit_limit: 500 }, cashDayId: null });
  expect(await screen.findByRole('button', { name: 'Receber' })).toBeDisabled();
});

it('baixa pede motivo e vai para a rota do gerente', async () => {
  montar({ conta: { player_id: 'p1', exists: true, enabled: true, balance: 300, credit_limit: 500 } });
  await userEvent.click(await screen.findByRole('button', { name: 'Dar baixa' }));
  await userEvent.type(screen.getByLabelText('Motivo'), 'jogador sumiu');
  await userEvent.click(screen.getAllByRole('button', { name: 'Dar baixa' }).pop());
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/house-credit/players/p1/write-offs', {
    amount: 300, reason: 'jogador sumiu',
  }));
});

it('estorno só em recebimento ainda não estornado', async () => {
  montar({
    conta: { player_id: 'p1', exists: true, enabled: true, balance: 100, credit_limit: 500 },
    extrato: [
      { id: 'e1', type: 'payment', amount: 50, signed_amount: -50, balance_after: 100, created_at: '2026-10-20T20:00:00Z', reversed: false },
      { id: 'e2', type: 'payment', amount: 70, signed_amount: -70, balance_after: 150, created_at: '2026-10-19T20:00:00Z', reversed: true },
    ],
  });
  expect(await screen.findAllByRole('button', { name: 'Estornar' })).toHaveLength(1);
  expect(screen.getByText('estornado')).toBeInTheDocument();
});
