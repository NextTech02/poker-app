/**
 * A POS do bar — a tela-mãe do módulo.
 *
 * O que trava:
 * 1. Sem turno, a tela oferece abrir (e nada mais).
 * 2. Gaveta fechada NÃO impede lançar item (item não é dinheiro); ela trava
 *    só o RECEBER, dentro do painel.
 * 3. Um toque no produto lança UMA unidade na comanda selecionada, com
 *    `client_mutation_id`; sem comanda selecionada, a grade fica travada.
 * 4. Abrir comanda para um jogador reaproveita a aberta (o servidor decide;
 *    a tela só seleciona o que voltou).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BarPOS from './BarPOS';
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
jest.mock('../components/CashboxBanner', () => ({ onStateChange, barShiftId }) => {
  const React = require('react');
  React.useEffect(() => { onStateChange(global.__caixa); }, [onStateChange]);
  return <div data-testid="cashbox-banner">{barShiftId}</div>;
});
jest.mock('../components/PlayerSelect', () => ({ value, onChange }) => (
  <select aria-label="jogador" value={value} onChange={(e) => onChange({ target: { name: 'player_id', value: e.target.value } })}>
    <option value="">--</option>
    <option value="j-1">Ana Silva (jogadora)</option>
  </select>
));
jest.mock('../components/BarTabPanel', () => ({ detail, cashboxBlocked }) => (
  <div data-testid="tab-panel">#{detail.tab.number} · {String(cashboxBlocked)}</div>
));
jest.mock('../hooks/useRealtimeRefresh', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../utils/eventosDoCaixa', () => ({ aoMudarOCaixa: () => () => {} }));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('../contexts/BarShiftContext', () => ({ useBarShift: jest.fn() }));
jest.mock('../contexts/PermissionContext', () => ({ usePermissions: jest.fn() }));
jest.mock('react-router-dom', () => ({
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

const TURNO = { id: 't-1', business_date: '2026-09-16', status: 'open', label: null };
const CERVEJA = { id: 'p-1', name: 'Cerveja', price: 10, active: true, category_id: 'c-1', track_stock: true, stock_qty: 22 };
const COMANDA = { id: 'c-1', number: 1, player_name: 'Ana', total: 20, paid_amount: 0, pending_count: 1, status: 'open' };
const DETALHE = { tab: COMANDA, items: [], payments: [], player_available_credit: 0 };

let toast;

beforeEach(() => {
  jest.clearAllMocks();
  global.__caixa = { id: 'cb-1', status: 'open' };
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  useToast.mockReturnValue({ toast });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  usePermissions.mockReturnValue({ hasPermission: () => true });
  api.post.mockResolvedValue({ data: DETALHE });
  api.get.mockImplementation((url) => {
    if (url === '/bar/products') return Promise.resolve({ data: [CERVEJA] });
    if (url === '/bar/categories') return Promise.resolve({ data: [{ id: 'c-1', name: 'Cervejas', active: true }] });
    if (url === '/bar/tabs') return Promise.resolve({ data: [COMANDA] });
    if (url === '/bar/tabs/c-1') return Promise.resolve({ data: DETALHE });
    return Promise.resolve({ data: [] });
  });
});

const montar = ({ shift = TURNO } = {}) => {
  useBarShift.mockReturnValue({
    shift, barShiftId: shift?.id || null, isOpen: !!shift && shift.status === 'open',
    loading: false, reload: jest.fn(),
  });
  return render(<BarPOS />);
};

it('sem turno, oferece abrir e não mostra a operação', async () => {
  montar({ shift: null });
  expect(await screen.findByText('O bar está fechado')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Abrir turno' })).toBeInTheDocument();
  expect(screen.queryByTestId('cashbox-banner')).toBeNull();
});

it('com turno, mostra a gaveta ancorada no turno e as comandas abertas', async () => {
  montar();
  expect(await screen.findByTestId('cashbox-banner')).toHaveTextContent('t-1');
  const comanda = await screen.findByRole('button', { name: /#1/ });
  expect(comanda).toHaveTextContent('Ana');
  expect(comanda).toHaveTextContent('R$ 20.00');
});

it('a grade fica travada até selecionar uma comanda', async () => {
  montar();
  const tile = await screen.findByRole('button', { name: /Cerveja/ });
  expect(tile).toBeDisabled();
  expect(screen.getByText(/Escolha ou abra uma comanda/)).toBeInTheDocument();
});

it('tocar no produto lança uma unidade na comanda selecionada', async () => {
  montar();
  await userEvent.click(await screen.findByRole('button', { name: /#1/ }));
  expect(await screen.findByTestId('tab-panel')).toHaveTextContent('#1');
  await userEvent.click(screen.getByRole('button', { name: /Cerveja/ }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/bar/tabs/c-1/items', {
    product_id: 'p-1', quantity: 1, client_mutation_id: expect.any(String),
  }));
});

it('gaveta fechada NÃO trava o lançamento, só avisa e passa o bloqueio ao painel', async () => {
  global.__caixa = { id: 'cb-1', status: 'closed' };
  montar();
  expect(await screen.findByText(/Seu caixa está fechado/)).toBeInTheDocument();
  await userEvent.click(await screen.findByRole('button', { name: /#1/ }));
  expect(await screen.findByTestId('tab-panel')).toHaveTextContent('true');
  const tile = screen.getByRole('button', { name: /Cerveja/ });
  expect(tile).toBeEnabled();
});

it('abrir comanda manda o jogador e seleciona a que voltou', async () => {
  api.post.mockResolvedValue({ data: COMANDA });
  montar();
  await screen.findByRole('button', { name: /#1/ });
  await userEvent.selectOptions(screen.getByLabelText('jogador'), 'j-1');
  await userEvent.click(screen.getByRole('button', { name: 'Abrir comanda' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/bar/tabs/open', {
    player_id: 'j-1', client_mutation_id: expect.any(String),
  }));
  expect(await screen.findByTestId('tab-panel')).toHaveTextContent('#1');
});

it('abrir comanda sem jogador só avisa', async () => {
  montar();
  await screen.findByRole('button', { name: /#1/ });
  await userEvent.click(screen.getByRole('button', { name: 'Abrir comanda' }));
  expect(toast.warning).toHaveBeenCalled();
  expect(api.post).not.toHaveBeenCalled();
});
