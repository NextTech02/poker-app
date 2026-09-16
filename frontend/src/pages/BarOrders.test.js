/**
 * PEDIDOS: o que foi lançado e ainda não saiu do balcão.
 * Um card por comanda; entregar tira da lista sem esperar o servidor
 * reenviar tudo.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BarOrders from './BarOrders';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useBarShift } from '../contexts/BarShiftContext';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
jest.mock('../components/Sidebar', () => () => <div data-testid="sidebar" />);
jest.mock('../hooks/useRealtimeRefresh', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/BarShiftContext', () => ({ useBarShift: jest.fn() }));
jest.mock('react-router-dom', () => ({ Link: ({ to, children }) => <a href={to}>{children}</a> }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (chave, padrao, vars) => {
      if (typeof padrao !== 'string') return chave;
      return padrao.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars ? vars[k] : ''));
    },
  }),
}));

const PEDIDOS = [
  { item_id: 'i1', tab_id: 'c-1', tab_number: 1, player_name: 'Ana', product_name: 'Cerveja', quantity: 2, created_at: '2026-09-16T20:01:00Z' },
  { item_id: 'i2', tab_id: 'c-1', tab_number: 1, player_name: 'Ana', product_name: 'Água', quantity: 1, created_at: '2026-09-16T20:02:00Z' },
  { item_id: 'i3', tab_id: 'c-2', tab_number: 2, player_name: 'Bruno', product_name: 'Porção', quantity: 1, created_at: '2026-09-16T20:03:00Z' },
];

beforeEach(() => {
  jest.clearAllMocks();
  useToast.mockReturnValue({ toast: { error: jest.fn() } });
  useBarShift.mockReturnValue({ barShiftId: 't-1', isOpen: true, loading: false });
  api.get.mockResolvedValue({ data: PEDIDOS });
  api.post.mockResolvedValue({ data: {} });
});

it('agrupa por comanda e conta os itens', async () => {
  render(<BarOrders />);
  expect(await screen.findByText('#1 · Ana')).toBeInTheDocument();
  expect(screen.getByText('#2 · Bruno')).toBeInTheDocument();
  expect(screen.getByText('3 item(ns) aguardando entrega')).toBeInTheDocument();
});

it('entregar um item o tira da lista', async () => {
  render(<BarOrders />);
  const card = (await screen.findByText('#1 · Ana')).closest('article');
  await userEvent.click(within(card).getAllByRole('button', { name: 'Entregar' })[0]);
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/bar/tabs/c-1/items/i1/deliver'));
  await waitFor(() => expect(screen.queryByText('Cerveja')).toBeNull());
  expect(screen.getByText('Água')).toBeInTheDocument();
});

it('entregar todos limpa a comanda inteira', async () => {
  render(<BarOrders />);
  const card = (await screen.findByText('#1 · Ana')).closest('article');
  await userEvent.click(within(card).getByRole('button', { name: 'Entregar todos' }));
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/bar/tabs/c-1/deliver-all'));
  await waitFor(() => expect(screen.queryByText('#1 · Ana')).toBeNull());
  expect(screen.getByText('#2 · Bruno')).toBeInTheDocument();
});

it('sem pendentes diz que está tudo entregue', async () => {
  api.get.mockResolvedValue({ data: [] });
  render(<BarOrders />);
  expect(await screen.findByText('Tudo entregue')).toBeInTheDocument();
});
