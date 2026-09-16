/**
 * As telas de GESTÃO do bar: produtos/estoque e turnos.
 *
 * O que estas telas afirmam, e que os testes travam:
 *
 * 1. **Estoque só muda por movimento.** O formulário do produto NÃO tem campo
 *    de estoque; a entrada/ajuste/perda é um modal próprio, que manda
 *    `client_mutation_id` (duplo clique não lança duas vezes).
 * 2. **Estoque baixo grita.** A linha ganha o aviso e há um resumo no topo —
 *    o barman descobre a falta antes do cliente.
 * 3. **Fechar o turno congela**, e a recusa vem com a LISTA do que segura o
 *    fechamento (comandas abertas com saldo, gavetas abertas) — é isso que o
 *    gerente precisa para resolver no balcão, não só a frase.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import BarProducts from './BarProducts';
import BarShifts from './BarShifts';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useBarShift } from '../contexts/BarShiftContext';
import { usePermissions } from '../contexts/PermissionContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <div data-testid="sidebar" />);
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('../contexts/BarShiftContext', () => ({ useBarShift: jest.fn() }));
jest.mock('../contexts/PermissionContext', () => ({ usePermissions: jest.fn() }));
jest.mock('react-router-dom', () => ({
  Link: ({ to, children, ...rest }) => <a href={to} {...rest}>{children}</a>,
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (chave, padrao, vars) => {
      if (typeof padrao !== 'string') return chave;
      return padrao.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars ? vars[k] : ''));
    },
  }),
}));

const CERVEJA = {
  id: 'p-1', name: 'Cerveja', sku: 'CERV', category_id: 'c-1', category_name: 'Cervejas',
  price: 10, cost_price: 4, track_stock: true, stock_qty: 22, min_stock: 6, low_stock: false,
  active: true, sort_order: 1,
};
const AGUA = {
  id: 'p-2', name: 'Água', sku: null, category_id: 'c-1', category_name: 'Cervejas',
  price: 5, cost_price: 1.5, track_stock: true, stock_qty: 3, min_stock: 6, low_stock: true,
  active: true, sort_order: 2,
};
const PORCAO = {
  id: 'p-3', name: 'Porção', sku: null, category_id: null, category_name: null,
  price: 30, cost_price: 12, track_stock: false, stock_qty: 0, min_stock: 0, low_stock: false,
  active: true, sort_order: 3,
};
const CATEGORIA = { id: 'c-1', name: 'Cervejas', sort_order: 2, active: true, products_count: 2 };

const TURNO_ABERTO = {
  id: 't-2', business_date: '2026-09-16', status: 'open', label: 'Noite',
  opened_at: '2026-09-16T19:00:00Z', total_net: null, total_paid: null,
  total_discounts: null, total_courtesy: null, total_cogs: null, tabs_count: null,
};
const TURNO_FECHADO = {
  id: 't-1', business_date: '2026-09-15', status: 'closed', label: null,
  opened_at: '2026-09-15T19:00:00Z', total_net: 75, total_paid: 75,
  total_discounts: 5, total_courtesy: 0, total_cogs: 31, tabs_count: 4,
};

let toast;

beforeEach(() => {
  jest.clearAllMocks();
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  useToast.mockReturnValue({ toast });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  useBarShift.mockReturnValue({ shift: null, reload: jest.fn() });
  usePermissions.mockReturnValue({ hasPermission: () => true });
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
});

// ══════════════════════════════════════════════════════════════════════
describe('produtos e estoque', () => {
  const montar = (produtos = [CERVEJA, AGUA, PORCAO]) => {
    api.get.mockImplementation((url) => {
      if (url === '/bar/products') return Promise.resolve({ data: produtos });
      if (url === '/bar/categories') return Promise.resolve({ data: [CATEGORIA] });
      return Promise.resolve({ data: [] });
    });
    return render(<BarProducts />);
  };

  it('lista os produtos com preço, custo e estoque', async () => {
    montar();
    expect(await screen.findByText('Cerveja')).toBeInTheDocument();
    expect(screen.getByText('R$ 10.00')).toBeInTheDocument();
    expect(screen.getByText('R$ 4.00')).toBeInTheDocument();
    // Produto sem controle diz isso, em vez de mostrar um zero enganoso.
    expect(screen.getByText('sem controle')).toBeInTheDocument();
  });

  it('estoque baixo grita na linha e no topo', async () => {
    montar();
    await screen.findByText('Água');
    expect(screen.getByText('baixo')).toBeInTheDocument();
    expect(screen.getByText(/1 produto\(s\) com estoque no mínimo ou abaixo/)).toBeInTheDocument();
  });

  it('só produto com controle de estoque oferece o botão Estoque', async () => {
    montar();
    await screen.findByText('Cerveja');
    expect(screen.getAllByRole('button', { name: 'Estoque' })).toHaveLength(2);
  });

  it('o formulário do produto não tem campo de estoque', async () => {
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Novo produto' }));
    const dialogo = screen.getByRole('dialog');
    expect(within(dialogo).getByLabelText('Preço')).toBeInTheDocument();
    expect(within(dialogo).queryByLabelText(/Estoque atual/)).toBeNull();
  });

  it('cadastrar manda preço, custo e controle de estoque', async () => {
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Novo produto' }));
    const dialogo = screen.getByRole('dialog');
    await userEvent.type(within(dialogo).getByLabelText('Nome'), 'Refrigerante');
    await userEvent.type(within(dialogo).getByLabelText('Preço'), '7');
    await userEvent.clear(within(dialogo).getByLabelText('Custo'));
    await userEvent.type(within(dialogo).getByLabelText('Custo'), '2.5');
    await userEvent.click(within(dialogo).getByLabelText('Controlar estoque'));
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/bar/products', expect.objectContaining({
      name: 'Refrigerante', price: 7, cost_price: 2.5, track_stock: true,
    })));
    expect(toast.success).toHaveBeenCalled();
  });

  it('a entrada de estoque leva client_mutation_id', async () => {
    montar();
    await screen.findByText('Cerveja');
    await userEvent.click(screen.getAllByRole('button', { name: 'Estoque' })[0]);
    const dialogo = screen.getByRole('dialog');
    expect(within(dialogo).getByText('Estoque atual: 22')).toBeInTheDocument();
    await userEvent.type(within(dialogo).getByLabelText('Quantidade'), '24');
    await userEvent.type(within(dialogo).getByLabelText('Custo unitário'), '4.5');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Lançar' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/bar/products/p-1/stock-movements',
      expect.objectContaining({ kind: 'in', quantity: 24, unit_cost: 4.5, client_mutation_id: expect.any(String) }),
    ));
  });

  it('a busca filtra por nome', async () => {
    montar();
    await screen.findByText('Cerveja');
    await userEvent.type(screen.getByLabelText('Buscar'), 'por');
    expect(screen.getByText('Porção')).toBeInTheDocument();
    expect(screen.queryByText('Cerveja')).toBeNull();
  });

  it('produto vendido avisa que foi desativado, não apagado', async () => {
    api.delete.mockResolvedValue({ data: { deactivated: true } });
    montar();
    await screen.findByText('Cerveja');
    await userEvent.click(screen.getAllByRole('button', { name: 'Excluir' })[0]);
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/desativado/)));
  });

  it('a aba de categorias não deixa apagar categoria com produtos', async () => {
    montar();
    await screen.findByText('Cerveja');
    await userEvent.click(screen.getByRole('tab', { name: 'Categorias' }));
    expect(await screen.findByText('Cervejas')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Excluir' })).toBeDisabled();
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('turnos', () => {
  const montar = (turnos = [TURNO_ABERTO, TURNO_FECHADO], aberto = TURNO_ABERTO) => {
    useBarShift.mockReturnValue({ shift: aberto, reload: jest.fn() });
    api.get.mockResolvedValue({ data: turnos });
    return render(<BarShifts />);
  };

  it('mostra as vendas do turno fechado e a margem', async () => {
    montar();
    expect(await screen.findByText('2026-09-15')).toBeInTheDocument();
    // 75 aparece em Vendas e em Recebido (turno fechado = tudo quitado).
    expect(screen.getAllByText('R$ 75.00')).toHaveLength(2);
    expect(screen.getByText('R$ 44.00')).toBeInTheDocument();    // 75 − 31 de CMV
  });

  it('o turno aberto aparece sem totais e explica por quê', async () => {
    montar();
    await screen.findByText('2026-09-16');
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText(/Os totais aparecem quando o turno é encerrado/)).toBeInTheDocument();
  });

  it('sem turno aberto, oferece abrir; com um aberto, não', async () => {
    montar([TURNO_FECHADO], null);
    expect(await screen.findByRole('button', { name: 'Abrir turno' })).toBeInTheDocument();
  });

  it('com turno aberto o botão de abrir some', async () => {
    montar();
    await screen.findByText('2026-09-16');
    expect(screen.queryByRole('button', { name: 'Abrir turno' })).toBeNull();
  });

  it('abrir manda a data escolhida', async () => {
    montar([TURNO_FECHADO], null);
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir turno' }));
    const dialogo = screen.getByRole('dialog');
    const data = within(dialogo).getByLabelText('Data');
    await userEvent.clear(data);
    await userEvent.type(data, '2026-09-20');
    await userEvent.type(within(dialogo).getByLabelText('Rótulo'), 'Noite');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Abrir turno' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/bar/shifts', { business_date: '2026-09-20', label: 'Noite' }));
  });

  it('a recusa por comanda aberta lista as comandas com saldo', async () => {
    api.post.mockRejectedValue({
      userMessage: 'Há comandas abertas.',
      response: { data: { detail: {
        code: 'turno_com_comanda_aberta', quantidade: 1,
        comandas: [{ id: 'c-4', number: 4, player_name: 'Ana', balance_due: 5 }],
      } } },
    });
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Encerrar' }));
    const dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Encerrar' }));
    const bloqueio = await screen.findByTestId('bloqueio-fechamento');
    expect(bloqueio).toHaveTextContent('1 comanda(s) aberta(s)');
    expect(bloqueio).toHaveTextContent('#4 · Ana · R$ 5.00');
    expect(toast.error).toHaveBeenCalled();
  });

  it('a recusa por gaveta aberta lista quem está com o caixa aberto', async () => {
    api.post.mockRejectedValue({
      userMessage: 'Há caixas abertos.',
      response: { data: { detail: { code: 'turno_com_caixa_aberto', quantidade: 1, caixas: ['Barman'] } } },
    });
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Encerrar' }));
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Encerrar' }));
    const bloqueio = await screen.findByTestId('bloqueio-fechamento');
    expect(bloqueio).toHaveTextContent('1 caixa(s) aberto(s)');
    expect(bloqueio).toHaveTextContent('Barman');
  });
});
