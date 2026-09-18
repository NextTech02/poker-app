/**
 * Sangi — consignação de fichas.
 *
 * O sangi anda pelo salão com fichas do clube e vende na mesa. É crédito de
 * confiança: o clube entrega fichas antes de receber o dinheiro. Daí a tela
 * ter **duas caras conforme quem entra**:
 *
 * - o **vendedor** vê só a própria consignação e registra as vendas;
 * - o **gerente** libera fichas e ACERTA a consignação no fim.
 *
 * O acerto é o momento crítico: ele fecha a conta e revela a divergência
 * entre o que foi liberado e o que voltou. Divergência zero e divergência de
 * 200 não podem produzir a mesma mensagem verde — a segunda é dinheiro que
 * faltou.
 *
 * Só quem tem a permissão `sangi` pode receber fichas: liberar para um caixa
 * misturaria dois controles de dinheiro diferentes.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Sangi from './Sangi';
import api from '../config/api';
import { usePermissions } from '../contexts/PermissionContext';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../components/PlayerSelect', () => ({ value, onChange }) => (
  <select
    aria-label="jogador"
    value={value}
    onChange={(e) => onChange({ target: { name: 'player_id', value: e.target.value } })}
  >
    <option value="">—</option>
    <option value="p1">Ana</option>
  </select>
));
jest.mock('../contexts/PermissionContext', () => ({ usePermissions: jest.fn() }));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
// A consignação é do DIA de cash: a sangeur é papel do cash game.
const diaDeCash = { cashDayId: 'dia-1', isOpen: true };
jest.mock('../contexts/CashDayContext', () => ({
  useCashDay: () => diaDeCash,
}));

const MESAS = [
  { id: 'm1', table_number: 3, game_type_name: 'NLH 1/2' },
  { id: 'm2', table_number: 5, game_type_name: 'PLO 2/5' },
];
jest.mock('react-i18next', () => {
  const t = (chave, vars) =>
    vars && typeof vars === 'object' ? `${chave}:${Object.values(vars).join(',')}` : chave;
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const CONSIGNACAO = {
  id: 'c1',
  released_amount: 5000,
  total_sold: 1200,
  remaining: 3800,
  status: 'open',
  sales: [
    { id: 's1', buyer_player_name: 'Ana', amount: 700, created_at: '2026-06-08T20:00:00Z' },
    { id: 's2', buyer_player_id: 'p9', amount: 500, created_at: '2026-06-08T21:00:00Z' },
  ],
};

const FUNCIONARIOS = [
  { id: 'f1', name: 'Zé Sangi', active: true, permissions: ['sangi'],
    permission_group_name: 'Sangi' },
  { id: 'f2', name: 'Caixa Ana', active: true, permissions: ['cashier'] },
  { id: 'f3', name: 'Antigo', active: false, permissions: ['sangi'] },
];

let toast;
let confirmar;

const comoVendedor = () =>
  usePermissions.mockReturnValue({ isAdmin: false, permissions: ['sangi'] });
const comoGerente = () =>
  usePermissions.mockReturnValue({ isAdmin: false, permissions: ['cashier'] });

const responder = ({ minha = CONSIGNACAO, lista = [CONSIGNACAO], staff = FUNCIONARIOS, detalhe } = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/sangi/me') {
      return minha instanceof Error ? Promise.reject(minha) : Promise.resolve({ data: minha });
    }
    if (url === '/staff') return Promise.resolve({ data: staff });
    if (url === '/cash-game/tables') return Promise.resolve({ data: MESAS });
    if (url === '/sangi/consignments') {
      return lista instanceof Error ? Promise.reject(lista) : Promise.resolve({ data: lista });
    }
    if (url.startsWith('/sangi/consignments/')) {
      return detalhe instanceof Error
        ? Promise.reject(detalhe)
        : Promise.resolve({ data: detalhe || CONSIGNACAO });
    }
    return Promise.resolve({ data: [] });
  });
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<Sangi />);
  await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
};

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  confirmar = jest.fn().mockResolvedValue(true);
  useToast.mockReturnValue({ toast, confirm: confirmar });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  api.post.mockResolvedValue({ data: {} });
  comoVendedor();
});

describe('quem vê o quê', () => {
  it('o vendedor vê a própria consignação', async () => {
    await montar();
    expect(screen.getByText('sangi.registerSale')).toBeInTheDocument();
    expect(screen.queryByText('sangi.releaseChipsTitle')).toBeNull();
  });

  it('o caixa vê a tela de gerente', async () => {
    comoGerente();
    await montar();
    expect(screen.getByText('sangi.releaseChipsTitle')).toBeInTheDocument();
  });

  it('o admin vê a tela de gerente', async () => {
    usePermissions.mockReturnValue({ isAdmin: true, permissions: [] });
    await montar();
    expect(screen.getByText('sangi.releaseChipsTitle')).toBeInTheDocument();
  });

  it.each(['general_cash', 'cashbox.admin', 'employees'])(
    'a permissão %s também abre a visão de gerente',
    async (permissao) => {
      usePermissions.mockReturnValue({ isAdmin: false, permissions: [permissao] });
      await montar();
      expect(screen.getByText('sangi.releaseChipsTitle')).toBeInTheDocument();
    }
  );

  it('sem permissão nenhuma cai na visão de vendedor', async () => {
    usePermissions.mockReturnValue({ isAdmin: false, permissions: null });
    await montar();
    expect(screen.queryByText('sangi.releaseChipsTitle')).toBeNull();
  });
});

describe('vendedor', () => {
  it('mostra liberado, vendido e o que resta em fichas', async () => {
    // É a conta que o sangi precisa fechar no fim da noite.
    await montar();
    expect(screen.getByText('R$ 5000.00')).toBeInTheDocument();
    expect(screen.getByText('R$ 1200.00')).toBeInTheDocument();
    expect(screen.getByText('R$ 3800.00')).toBeInTheDocument();
  });

  it('sem consignação aberta explica o que fazer', async () => {
    await montar({ minha: null });
    expect(screen.getByText('sangi.noConsignmentOpen')).toBeInTheDocument();
    expect(screen.queryByText('sangi.registerSale')).toBeNull();
  });

  it('falha ao carregar cai no mesmo estado vazio', async () => {
    await montar({ minha: new Error('403') });
    expect(screen.getByText('sangi.noConsignmentOpen')).toBeInTheDocument();
  });

  it('registra a venda com valor, comprador e MESA', async () => {
    // A mesa é obrigatória porque a venda vira uma recompra do jogador ali:
    // sem ela não há em qual sessão o dinheiro entra, e o resultado da noite
    // do jogador sairia errado.
    await montar();
    await userEvent.type(screen.getByRole('spinbutton'), '300');
    await userEvent.selectOptions(screen.getByLabelText('jogador'), 'p1');
    await userEvent.selectOptions(screen.getByLabelText('sangi.tableLabel'), 'm1');
    await userEvent.click(screen.getByRole('button', { name: 'sangi.registerBtn' }));
    await waitFor(() => expect(api.post).toHaveBeenCalled());

    const [rota, corpo] = api.post.mock.calls[0];
    expect(rota).toBe('/sangi/consignments/c1/sales');
    expect(corpo).toMatchObject({
      amount: 300, buyer_player_id: 'p1', table_id: 'm1',
    });
    // Duplo clique e retry não podem virar duas vendas — aqui isso custaria
    // fichas de verdade E um lançamento a mais no dinheiro do dia.
    expect(corpo.client_mutation_id).toBeTruthy();
    expect(toast.success).toHaveBeenCalled();
  });

  it('venda sem mesa é recusada antes de sair da tela', async () => {
    await montar();
    await userEvent.type(screen.getByRole('spinbutton'), '300');
    await userEvent.selectOptions(screen.getByLabelText('jogador'), 'p1');
    await userEvent.click(screen.getByRole('button', { name: 'sangi.registerBtn' }));
    expect(api.post).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it('venda sem comprador é recusada', async () => {
    // Sem saber quem levou as fichas, o acerto não fecha com ninguém.
    await montar();
    await userEvent.type(screen.getByRole('spinbutton'), '300');
    await userEvent.click(screen.getByRole('button', { name: 'sangi.registerBtn' }));
    expect(toast.error).toHaveBeenCalledWith('sangi.errorAmountBuyer');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('venda sem valor é recusada', async () => {
    await montar();
    await userEvent.selectOptions(screen.getByLabelText('jogador'), 'p1');
    await userEvent.click(screen.getByRole('button', { name: 'sangi.registerBtn' }));
    expect(toast.error).toHaveBeenCalledWith('sangi.errorAmountBuyer');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('venda acima do saldo mostra o motivo do servidor', async () => {
    // "Fichas insuficientes" é a recusa que importa: o sangi não pode vender
    // o que não tem em mãos.
    api.post.mockRejectedValue({ userMessage: 'Fichas insuficientes' });
    await montar();
    await userEvent.type(screen.getByRole('spinbutton'), '99999');
    await userEvent.selectOptions(screen.getByLabelText('jogador'), 'p1');
    await userEvent.selectOptions(screen.getByLabelText('sangi.tableLabel'), 'm1');
    await userEvent.click(screen.getByRole('button', { name: 'sangi.registerBtn' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Fichas insuficientes'));
  });

  it('limpa o formulário depois de registrar', async () => {
    // O sangi registra várias vendas seguidas; valor herdado geraria
    // lançamento errado.
    await montar();
    await userEvent.type(screen.getByRole('spinbutton'), '300');
    await userEvent.selectOptions(screen.getByLabelText('jogador'), 'p1');
    await userEvent.selectOptions(screen.getByLabelText('sangi.tableLabel'), 'm1');
    await userEvent.click(screen.getByRole('button', { name: 'sangi.registerBtn' }));
    await waitFor(() => expect(screen.getByRole('spinbutton')).toHaveValue(null));
    // A mesa também: a venda seguinte pode ser em outra, e herdar a anterior
    // lançaria o dinheiro na sessão errada.
    expect(screen.getByLabelText('sangi.tableLabel')).toHaveValue('');
  });

  it('lista as vendas já registradas', async () => {
    // "Ana" tambem e uma opcao do seletor de comprador; a tabela e o alvo.
    await montar();
    expect(document.querySelector('.sangi-table.compact')).toHaveTextContent('Ana');
    expect(screen.getByText('R$ 700.00')).toBeInTheDocument();
  });

  it('venda sem nome do comprador mostra o identificador', async () => {
    // Melhor um id do que uma célula vazia na hora de conferir.
    await montar();
    expect(screen.getByText('p9')).toBeInTheDocument();
  });

  it('sem venda nenhuma diz isso', async () => {
    await montar({ minha: { ...CONSIGNACAO, sales: [] } });
    expect(screen.getByText('sangi.noSalesYet')).toBeInTheDocument();
  });
});

describe('gerente — liberação de fichas', () => {
  beforeEach(comoGerente);

  it('só oferece funcionários com a permissão de sangi', async () => {
    // Liberar fichas para um caixa misturaria dois controles de dinheiro
    // diferentes.
    await montar();
    const opcoes = Array.from(
      document.querySelectorAll('.sangi-card select option')
    ).map((o) => o.textContent);
    expect(opcoes.join(' ')).toContain('Zé Sangi');
    expect(opcoes.join(' ')).not.toContain('Caixa Ana');
  });

  it('funcionário desativado não aparece', async () => {
    await montar();
    const opcoes = Array.from(
      document.querySelectorAll('.sangi-card select option')
    ).map((o) => o.textContent);
    expect(opcoes.join(' ')).not.toContain('Antigo');
  });

  it('libera o valor escolhido', async () => {
    await montar();
    await userEvent.selectOptions(document.querySelector('.sangi-card select'), 'f1');
    await userEvent.type(screen.getByRole('spinbutton'), '5000');
    await userEvent.click(screen.getByRole('button', { name: 'sangi.releaseBtn' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/sangi/consignments', {
        sangi_staff_id: 'f1',
        released_amount: 5000,
        // A consignação é do DIA: o id vai explícito, e não fica por conta do
        // backend adivinhar — era assim que a liberação caía em "dia fechado".
        cash_day_id: 'dia-1',
      })
    );
  });

  it('sem dia aberto avisa e não deixa liberar', async () => {
    diaDeCash.cashDayId = null;
    diaDeCash.isOpen = false;
    try {
      await montar();
      expect(screen.getByRole('alert')).toHaveTextContent('sangi.noDayOpen');
      expect(screen.getByRole('button', { name: 'sangi.releaseBtn' })).toBeDisabled();
    } finally {
      diaDeCash.cashDayId = 'dia-1';
      diaDeCash.isOpen = true;
    }
  });

  it('sem sangi escolhido é recusado', async () => {
    await montar();
    await userEvent.type(screen.getByRole('spinbutton'), '5000');
    await userEvent.click(screen.getByRole('button', { name: 'sangi.releaseBtn' }));
    expect(toast.error).toHaveBeenCalledWith('sangi.errorSelectSangi');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('erro do servidor aparece', async () => {
    api.post.mockRejectedValue({ userMessage: 'já possui consignação aberta' });
    await montar();
    await userEvent.selectOptions(document.querySelector('.sangi-card select'), 'f1');
    await userEvent.type(screen.getByRole('spinbutton'), '100');
    await userEvent.click(screen.getByRole('button', { name: 'sangi.releaseBtn' }));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('já possui consignação aberta')
    );
  });

  it('falha ao carregar a lista avisa', async () => {
    await montar({ lista: new Error('500') });
    expect(toast.error).toHaveBeenCalledWith('sangi.errorLoadConsignments');
  });
});

describe('gerente — lista de consignações', () => {
  beforeEach(comoGerente);

  it('mostra cada consignação com os valores', async () => {
    // "Ze Sangi" tambem e opcao do seletor de liberacao; a tabela e o alvo.
    await montar({ lista: [{ ...CONSIGNACAO, sangi_name: 'Zé Sangi' }] });
    const tabela = document.querySelector('.sangi-table');
    expect(tabela).toHaveTextContent('Zé Sangi');
    expect(tabela).toHaveTextContent('R$ 5000.00');
    expect(tabela).toHaveTextContent('R$ 3800.00');
  });

  it('consignação sem nome mostra travessão', async () => {
    await montar({ lista: [{ ...CONSIGNACAO, sangi_name: null }] });
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('sem consignação nenhuma diz isso', async () => {
    await montar({ lista: [] });
    expect(screen.getByText('sangi.noConsignmentsInStage')).toBeInTheDocument();
  });

  it('divergência ausente aparece como travessão, não como zero', async () => {
    // Consignação ainda aberta não TEM divergência; zero diria "fechou
    // certo".
    await montar({ lista: [{ ...CONSIGNACAO, sangi_name: 'Zé', divergence: null }] });
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('abre e fecha o detalhe de vendas', async () => {
    await montar({ lista: [{ ...CONSIGNACAO, sangi_name: 'Zé' }] });
    await userEvent.click(screen.getByText('sangi.viewSales'));
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith('/sangi/consignments/c1')
    );
    await userEvent.click(screen.getByText('sangi.closeDetail'));
    expect(screen.getByText('sangi.viewSales')).toBeInTheDocument();
  });

  it('falha ao abrir o detalhe avisa', async () => {
    await montar({ lista: [{ ...CONSIGNACAO, sangi_name: 'Zé' }], detalhe: new Error('500') });
    await userEvent.click(screen.getByText('sangi.viewSales'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('sangi.errorOpenConsignment')
    );
  });

  it('consignação já acertada não oferece acertar de novo', async () => {
    // Acertar duas vezes lançaria o mesmo dinheiro no caixa em dobro.
    await montar({ lista: [{ ...CONSIGNACAO, sangi_name: 'Zé', status: 'reconciled' }] });
    expect(screen.queryByText('sangi.reconcileAction')).toBeNull();
  });
});

describe('acerto da consignação', () => {
  beforeEach(comoGerente);

  const acertar = async (divergencia) => {
    api.post.mockResolvedValue({ data: { ...CONSIGNACAO, divergence: divergencia } });
    await montar({ lista: [{ ...CONSIGNACAO, sangi_name: 'Zé' }] });
    await userEvent.click(screen.getByText('sangi.reconcileAction'));
  };

  it('pede confirmação antes de fechar a conta', async () => {
    // O acerto encerra a consignação; não pode sair de um clique acidental.
    await acertar(0);
    expect(confirmar).toHaveBeenCalled();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/sangi/consignments/c1/reconcile', {})
    );
  });

  it('cancelar não acerta', async () => {
    confirmar.mockResolvedValue(false);
    await montar({ lista: [{ ...CONSIGNACAO, sangi_name: 'Zé' }] });
    await userEvent.click(screen.getByText('sangi.reconcileAction'));
    await waitFor(() => expect(confirmar).toHaveBeenCalled());
    expect(api.post).not.toHaveBeenCalled();
  });

  it('acerto sem divergência é sucesso', async () => {
    await acertar(0);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('divergência vira AVISO com o valor, não sucesso', async () => {
    // É dinheiro que faltou; a mesma mensagem verde esconderia o problema.
    await acertar(-200);
    await waitFor(() =>
      expect(toast.warning).toHaveBeenCalledWith(expect.stringContaining('200.00'))
    );
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('diferença de centavos conta como acerto certo', async () => {
    // Arredondamento de float não pode virar alarme falso a cada acerto.
    await acertar(0.0001);
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
  });

  it('erro ao acertar mostra o motivo', async () => {
    api.post.mockRejectedValue({ userMessage: 'consignação já acertada' });
    await montar({ lista: [{ ...CONSIGNACAO, sangi_name: 'Zé' }] });
    await userEvent.click(screen.getByText('sangi.reconcileAction'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('consignação já acertada')
    );
  });
});
