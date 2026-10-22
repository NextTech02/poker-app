/**
 * Página de FIADO do clube: devedores na ordem da cobrança, totais, abatimento
 * a menor e configuração.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Fiado from './Fiado';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useCashDay } from '../contexts/CashDayContext';
import { useBarShift } from '../contexts/BarShiftContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), put: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <div data-testid="sidebar" />);
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('../contexts/CashDayContext', () => ({ useCashDay: jest.fn() }));
jest.mock('../contexts/BarShiftContext', () => ({ useBarShift: jest.fn() }));
jest.mock('react-router-dom', () => ({
  Link: ({ to, children }) => <a href={to}>{children}</a>,
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

const DEVEDORES = {
  rows: [
    { player_id: 'p1', player_name: 'Ana', phone: '+55 11 99999-0000', enabled: true, credit_limit: 500,
      balance: 300, oldest_open_at: '2026-09-01T20:00:00Z', days_open: 51, overdue: true },
    { player_id: 'p2', player_name: 'Bia', phone: null, enabled: true, credit_limit: 1000,
      balance: 200, oldest_open_at: '2026-10-20T20:00:00Z', days_open: 2, overdue: false },
  ],
  total_open: 500, total_overdue: 300, count: 2, overdue_count: 1, due_days: 30,
};

beforeEach(() => {
  jest.clearAllMocks();
  useToast.mockReturnValue({ toast: { success: jest.fn(), error: jest.fn() } });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  useCashDay.mockReturnValue({ cashDayId: 'dia-1' });
  useBarShift.mockReturnValue({ barShiftId: null });
  api.get.mockImplementation((url) => {
    if (url === '/house-credit/debtors') return Promise.resolve({ data: DEVEDORES });
    if (url === '/house-credit/settings') return Promise.resolve({ data: { due_days: 30, block_overdue: true, default_limit: 0 } });
    return Promise.resolve({ data: [] });
  });
  api.put.mockResolvedValue({ data: {} });
});

it('mostra os devedores, os totais e o contato do WhatsApp', async () => {
  render(<Fiado />);
  expect(await screen.findByText('Ana')).toBeInTheDocument();
  expect(within(screen.getByText('Total em aberto').parentElement).getByText('R$ 500.00')).toBeInTheDocument();
  expect(within(screen.getByText('Vencido (mais de 30 dias)').parentElement).getByText('R$ 300.00')).toBeInTheDocument();
  expect(screen.getByText('+55 11 99999-0000').closest('a')).toHaveAttribute('href', 'https://wa.me/5511999990000');
  expect(screen.getAllByRole('button', { name: 'Receber' })).toHaveLength(2);
});

it('salva a configuração', async () => {
  render(<Fiado />);
  await screen.findByText('Ana');
  await userEvent.click(screen.getByRole('tab', { name: 'Configuração' }));
  const prazo = screen.getByLabelText('Prazo para pagar (dias)');
  await userEvent.clear(prazo);
  await userEvent.type(prazo, '15');
  await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
  await waitFor(() => expect(api.put).toHaveBeenCalledWith('/house-credit/settings', {
    due_days: 15, block_overdue: true, default_limit: 0,
  }));
});
