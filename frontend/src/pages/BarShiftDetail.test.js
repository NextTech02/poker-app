/**
 * O detalhe do TURNO: os números ao vivo, o que ainda segura o fechamento e
 * as gavetas do turno (o painel de caixas e o demonstrativo do Financeiro,
 * ancorados aqui em vez da etapa).
 */
import { render, screen } from '@testing-library/react';
import BarShiftDetail from './BarShiftDetail';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useBarShift } from '../contexts/BarShiftContext';
import { usePermissions } from '../contexts/PermissionContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <div data-testid="sidebar" />);
jest.mock('../components/Breadcrumb', () => () => <nav data-testid="breadcrumb" />);
jest.mock('../components/CashboxAdminPanel', () => ({ anchor }) => (
  <div data-testid="cashbox-admin">{anchor?.barShiftId}</div>
));
jest.mock('../components/CashboxDemonstrativo', () => ({ anchor }) => (
  <div data-testid="cashbox-demo">{anchor?.barShiftId}</div>
));
jest.mock('../hooks/useRealtimeRefresh', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../utils/eventosDoCaixa', () => ({ aoMudarOCaixa: () => () => {} }));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('../contexts/BarShiftContext', () => ({ useBarShift: jest.fn() }));
jest.mock('../contexts/PermissionContext', () => ({ usePermissions: jest.fn() }));
jest.mock('react-router-dom', () => ({
  useParams: () => ({ id: 't-2' }),
  Link: ({ to, children }) => <a href={to}>{children}</a>,
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (chave, padrao, vars) => {
      if (typeof padrao !== 'string') return chave;
      return padrao.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars ? vars[k] : ''));
    },
  }),
}));

const TURNO = { id: 't-2', business_date: '2026-09-16', status: 'open', label: 'Noite' };
const RESUMO = {
  bar_shift_id: 't-2', business_date: '2026-09-16', status: 'open',
  total_gross: 80, total_discounts: 5, total_courtesy: 0, total_net: 75,
  total_paid: 45, total_paid_cash: 30, total_paid_credit: 15, total_cogs: 31,
  gross_margin: 44, tabs_open: 1, tabs_total: 2, items_pending: 1, items_count: 3,
  balance_due: 30, by_method: [{ payment_method: 'pix', amount: 20, count: 1 }], low_stock_count: 0,
};
const ABERTA = { id: 'c-1', number: 1, player_name: 'Ana', total: 50, paid_amount: 20, balance_due: 30 };

beforeEach(() => {
  jest.clearAllMocks();
  useToast.mockReturnValue({ toast: { success: jest.fn(), error: jest.fn() } });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  useBarShift.mockReturnValue({ reload: jest.fn() });
  usePermissions.mockReturnValue({ hasPermission: () => true });
  api.get.mockImplementation((url) => {
    if (url === '/bar/shifts/t-2') return Promise.resolve({ data: TURNO });
    if (url === '/bar/shifts/t-2/summary') return Promise.resolve({ data: RESUMO });
    if (url === '/bar/tabs') return Promise.resolve({ data: [ABERTA] });
    return Promise.resolve({ data: [] });
  });
});

it('mostra os números ao vivo e a margem', async () => {
  render(<BarShiftDetail />);
  expect(await screen.findByText('R$ 75.00')).toBeInTheDocument();
  expect(screen.getByText('R$ 44.00')).toBeInTheDocument();
  expect(screen.getByText(/dinheiro R\$ 30\.00 · crédito R\$ 15\.00/)).toBeInTheDocument();
});

it('lista as comandas abertas com o saldo que segura o fechamento', async () => {
  render(<BarShiftDetail />);
  expect(await screen.findByText('Ana')).toBeInTheDocument();
  expect(screen.getByText('R$ 30.00')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Detalhes' })).toHaveAttribute('href', '/bar/comandas/c-1');
});

it('as gavetas do turno são as do Financeiro, ancoradas no turno', async () => {
  // A prop `anchor` é o que impede a etapa selecionada no header de esconder
  // as gavetas do bar.
  render(<BarShiftDetail />);
  expect(await screen.findByTestId('cashbox-admin')).toHaveTextContent('t-2');
  expect(screen.getByTestId('cashbox-demo')).toHaveTextContent('t-2');
});
