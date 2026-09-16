/**
 * FATURAMENTO DO BAR: a tela não deixa confundir vendas, margem e recebido,
 * e exporta as mesmas seções que mostra.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BarRelatorios from './BarRelatorios';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { exportSections } from '../utils/reportExport';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../components/Sidebar', () => () => <div data-testid="sidebar" />);
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('../utils/reportExport', () => ({ exportSections: jest.fn() }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (chave, padrao, vars) => {
      if (typeof padrao !== 'string') return chave;
      return padrao.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars ? vars[k] : ''));
    },
  }),
}));

const RESUMO = {
  shifts: 2, tabs: 4, items: 7, gross: 85, discounts: 5, courtesy: 5, net: 75, paid: 75,
  paid_cash: 60, paid_credit: 15, cogs: 31, margin: 44, average_tab: 18.75,
  by_method: [{ payment_method: 'pix', amount: 20, count: 1 }, { payment_method: 'cash', amount: 40, count: 3 }],
  daily: [
    { business_date: '2026-09-18', shifts: 1, tabs: 3, items: 5, gross: 75, discounts: 5, courtesy: 0, net: 70, paid: 70, paid_cash: 55, paid_credit: 15, cogs: 29.5, margin: 40.5 },
    { business_date: '2026-09-19', shifts: 1, tabs: 1, items: 2, gross: 10, discounts: 0, courtesy: 5, net: 5, paid: 5, paid_cash: 5, paid_credit: 0, cogs: 1.5, margin: 3.5 },
  ],
  top_products: [{ product_id: 'p1', product_name: 'Cerveja', category_name: 'Cervejas', quantity: 5, courtesy_quantity: 0, revenue: 50, cogs: 20, margin: 30 }],
};

beforeEach(() => {
  jest.clearAllMocks();
  useToast.mockReturnValue({ toast: { error: jest.fn() } });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  api.get.mockImplementation((url) => {
    if (url === '/bar/reports/summary') return Promise.resolve({ data: RESUMO });
    if (url === '/bar/reports/players') return Promise.resolve({ data: [{ player_id: 'j1', player_name: 'Ana', tabs: 2, items: 4, spent: 70 }] });
    return Promise.resolve({ data: [] });
  });
  exportSections.mockResolvedValue();
});

it('mostra vendas, margem com o CMV e o recebido por origem', async () => {
  render(<BarRelatorios />);
  // 75 aparece em Vendas e em Recebido (comanda só fecha quitada).
  expect(await screen.findAllByText('R$ 75.00')).toHaveLength(2);
  expect(screen.getByText('R$ 44.00')).toBeInTheDocument();                 // margem
  expect(screen.getByText(/CMV R\$ 31\.00 \(cortesia inclusa\)/)).toBeInTheDocument();
  expect(screen.getByText(/dinheiro R\$ 60\.00 · crédito R\$ 15\.00/)).toBeInTheDocument();
  expect(screen.getByText(/Ticket médio R\$ 18\.75 · 4 comanda\(s\)/)).toBeInTheDocument();
});

it('o melhor dia vem primeiro, pelas vendas', async () => {
  render(<BarRelatorios />);
  await screen.findAllByText('R$ 75.00');
  const itens = document.querySelectorAll('.cr-rank li');
  expect(itens[0]).toHaveTextContent('2026-09-18');
  expect(itens[0]).toHaveTextContent('R$ 70.00');
});

it('exporta as seções com o período no nome do arquivo', async () => {
  render(<BarRelatorios />);
  await screen.findAllByText('R$ 75.00');
  await userEvent.click(screen.getByRole('button', { name: 'XLSX' }));
  await waitFor(() => expect(exportSections).toHaveBeenCalled());
  const [secoes, opcoes] = exportSections.mock.calls[0];
  expect(secoes.map((s) => s.kind)).toEqual(['keyvalue', 'table', 'table', 'table', 'table']);
  expect(opcoes.format).toBe('xlsx');
  expect(opcoes.filename).toMatch(/^bar-\d{4}-\d{2}-\d{2}-a-\d{4}-\d{2}-\d{2}$/);
});

it('sem comanda fechada, diz isso e desabilita a exportação', async () => {
  api.get.mockImplementation(() => Promise.resolve({ data: { ...RESUMO, tabs: 0, daily: [] } }));
  render(<BarRelatorios />);
  expect(await screen.findByText('Nenhuma comanda fechada no período')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'XLSX' })).toBeDisabled();
});
