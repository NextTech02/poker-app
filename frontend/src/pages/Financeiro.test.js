/**
 * Financeiro — o DRE da operação e o painel de configuração do dinheiro.
 *
 * A tela é sobretudo um roteador de sub-abas (caixas, demonstrativo, despesas,
 * receitas, métodos de pagamento), com o DRE como aba padrão.
 * O que ela tem de próprio e os testes prendem:
 *
 * - **O rótulo da forma de pagamento tem uma hierarquia.** Códigos embutidos
 *   (dinheiro/PIX/cartão) passam por i18n e traduzem com o idioma;
 *   personalizados (Yape, Nequi) usam o rótulo salvo pelo clube; e um código
 *   desconhecido aparece como veio, em vez de virar "--" e esconder o dado.
 * - **A forma real vence a origem.** Se a transação tem `payment_method`
 *   diferente de dinheiro, é ela que aparece; "dinheiro" ou vazio (registros
 *   antigos) cai para a origem — crédito, misto, ticket.
 * - **Resultado líquido negativo é marcado como negativo.** Verde num prejuízo
 *   daria a leitura oposta da realidade.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Financeiro from './Financeiro';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { usePaymentMethods } from '../contexts/PaymentMethodsContext';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../components/CashboxAdminPanel', () => () => <div data-testid="aba-caixas" />);
jest.mock('../components/CashboxDemonstrativo', () => () => <div data-testid="aba-demonstrativo" />);
jest.mock('../components/PaymentMethodsManager', () => () => <div data-testid="aba-metodos" />);
jest.mock('../components/ExpensesManager', () => () => <div data-testid="aba-despesas" />);
jest.mock('../components/RevenuesManager', () => () => <div data-testid="aba-receitas" />);
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('../contexts/PaymentMethodsContext', () => ({ usePaymentMethods: jest.fn() }));
jest.mock('../contexts/ModuleContext', () => ({ useModule: () => ({ hasModule: () => false }) }));
jest.mock('react-i18next', () => {
  const t = (chave, segundo) => (typeof segundo === 'string' ? segundo : chave);
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const RELATORIO = {
  gross_revenue: 50000, prizes: 30000, operational_result: 20000, net_result: 12000,
  rake: 10000, pending_credits: 2000, available_tickets: 3,
  tickets_redeemed_value: 1000,
  revenue: { buy_ins: 30000, rebuys: 15000, addons: 5000 },
  other_revenue: 4000,
  other_revenue_by_source: [{ category: 'Bar', amount: 4000 }],
  expenses: 2500,
  expenses_by_category: [{ category: 'Aluguel', amount: 2500 }],
  by_tournament: [{
    tournament_id: 't1', tournament_name: 'Main Event', players: 80,
    buy_ins_count: 80, rebuys_count: 30, addons_count: 10,
    revenue: 50000, prizes: 30000, net: 20000,
  }],
  transactions: [
    { id: 'x1', type: 'buy_in', amount: 500, payment_method: 'pix', payment_source: 'cash' },
    { id: 'x2', type: 'rebuy', amount: 300, payment_method: 'cash', payment_source: 'credit' },
    { id: 'x3', type: 'addon', amount: 200, payment_method: 'yape', payment_source: 'cash' },
    { id: 'x4', type: 'prize', amount: 5000, payment_source: 'cash' },
  ],
};

const ETAPAS = [{ id: 'e1', name: 'Etapa 1' }];
const TORNEIOS = [
  { id: 't1', name: 'Main Event', stage_id: 'e1' },
  { id: 't2', name: 'De outra etapa', stage_id: 'e9' },
];

let toast;
let trocarMoeda;

const responder = ({ relatorio = RELATORIO, etapas = ETAPAS, torneios = TORNEIOS } = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/stages') return Promise.resolve({ data: etapas });
    if (url === '/tournaments') return Promise.resolve({ data: torneios });
    if (url === '/reports/financial') {
      return relatorio instanceof Error
        ? Promise.reject(relatorio)
        : Promise.resolve({ data: relatorio });
    }
    return Promise.resolve({ data: [] });
  });
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<Financeiro />);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/stages'));
};

const gerar = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'common.generate' }));
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/reports/financial', expect.anything()));
};

const linhaDaTransacao = (texto) =>
  Array.from(document.querySelectorAll('tbody tr')).find((tr) => tr.textContent.includes(texto));

const aba = (chave) => screen.getByRole('button', { name: chave });

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  trocarMoeda = jest.fn();
  useToast.mockReturnValue({ toast });
  useCurrency.mockReturnValue({
    currency: 'BRL',
    setCurrency: trocarMoeda,
    currencies: { BRL: { code: 'BRL', name: 'Real' }, USD: { code: 'USD', name: 'Dólar' } },
    formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}`,
    language: 'pt-BR',
  });
  usePaymentMethods.mockReturnValue({ labelFor: (c) => (c === 'yape' ? 'Yape' : null) });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('sub-abas', () => {
  it('o DRE é a aba inicial', async () => {
    await montar();
    expect(screen.getByRole('button', { name: 'common.generate' })).toBeInTheDocument();
  });

  it.each([
    ['cashbox.tabCashboxes', 'aba-caixas'],
    ['cashbox.tabDemonstrativo', 'aba-demonstrativo'],
    ['Despesas', 'aba-despesas'],
    ['Outras receitas', 'aba-receitas'],
    ['Métodos de Pagamento', 'aba-metodos'],
  ])('a aba %s monta o painel correspondente', async (rotulo, id) => {
    await montar();
    await userEvent.click(aba(rotulo));
    expect(screen.getByTestId(id)).toBeInTheDocument();
  });

  it('trocar de aba tira o DRE da tela', async () => {
    // Os painéis são exclusivos; deixar dois somaria números diferentes na
    // mesma vista.
    await montar();
    await userEvent.click(aba('Despesas'));
    expect(screen.queryByRole('button', { name: 'common.generate' })).toBeNull();
  });
});

describe('moeda do sistema', () => {
  it('a moeda atual vem selecionada', async () => {
    await montar();
    expect(screen.getByLabelText('Moeda do sistema')).toHaveValue('BRL');
  });

  it('trocar a moeda é uma decisão GLOBAL, não por tela', async () => {
    // Ela reformata valores em todo o sistema.
    await montar();
    await userEvent.selectOptions(screen.getByLabelText('Moeda do sistema'), 'USD');
    expect(trocarMoeda).toHaveBeenCalledWith('USD');
  });
});

describe('idioma', () => {
  it('o Financeiro NÃO tem seletor de idioma', () => {
    /* Ele já existe na barra lateral, na bandeira. Dois lugares para a mesma
       decisão só geram a dúvida de qual dos dois manda — ainda mais porque não
       mandavam na mesma coisa: a bandeira guarda a preferência da PESSOA, e
       este seletor mexia no padrão do CLUBE. O clube define o idioma dele na
       criação da organização. */
    return montar().then(() => {
      expect(screen.queryByLabelText('Idioma do sistema')).toBeNull();
      expect(screen.getByLabelText('Moeda do sistema')).toBeInTheDocument();
    });
  });
});

describe('geração do DRE', () => {
  it('os filtros escolhidos viajam na consulta', async () => {
    await montar();
    await userEvent.selectOptions(document.querySelectorAll('.fn-filters select')[0], 'e1');
    await userEvent.selectOptions(document.querySelectorAll('.fn-filters select')[1], 't1');
    await gerar();
    // A tela já gera um relatório na carga; a chamada de interesse é a ÚLTIMA.
    const chamadas = api.get.mock.calls.filter((c) => c[0] === '/reports/financial');
    expect(chamadas.at(-1)[1].params).toMatchObject({ stage_id: 'e1', tournament_id: 't1' });
  });

  it('escolher a etapa restringe os torneios oferecidos', async () => {
    // Oferecer torneio de outra etapa produziria um relatório vazio sem
    // explicação.
    await montar();
    await userEvent.selectOptions(document.querySelectorAll('.fn-filters select')[0], 'e1');
    const porTorneio = document.querySelectorAll('.fn-filters select')[1];
    expect(within(porTorneio).getByText('Main Event')).toBeInTheDocument();
    expect(within(porTorneio).queryByText('De outra etapa')).toBeNull();
  });

  it('o período padrão vai do início do mês até hoje', async () => {
    // É o recorte que o gerente olha todo dia.
    await montar();
    await gerar();
    const chamadas = api.get.mock.calls.filter((c) => c[0] === '/reports/financial');
    expect(chamadas.at(-1)[1].params.start).toMatch(/^\d{4}-\d{2}-01$/);
    expect(chamadas.at(-1)[1].params.end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('falha ao gerar avisa', async () => {
    await montar({ relatorio: new Error('500') });
    await gerar();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('financial.loadDataError'));
  });
});

describe('indicadores', () => {
  it('mostra faturamento, prêmios e resultado', async () => {
    await montar();
    await gerar();
    const cartoes = await waitFor(() => {
      const c = document.querySelectorAll('.stat-card');
      expect(c.length).toBeGreaterThan(3);
      return c;
    });
    expect(cartoes[0]).toHaveTextContent('R$ 50000.00');
    expect(cartoes[1]).toHaveTextContent('R$ 30000.00');
  });

  it('resultado líquido NEGATIVO é marcado como negativo', async () => {
    // Verde num prejuízo daria a leitura oposta da realidade.
    await montar({ relatorio: { ...RELATORIO, net_result: -4000 } });
    await gerar();
    await waitFor(() => expect(document.querySelector('.fn-dre-negative')).toBeInTheDocument());
  });

  it('resultado zero conta como positivo', async () => {
    await montar({ relatorio: { ...RELATORIO, net_result: 0 } });
    await gerar();
    await waitFor(() => expect(document.querySelector('.fn-dre-positive')).toBeInTheDocument());
  });

  it('o DRE detalha buy-ins, rebuys e add-ons', async () => {
    await montar();
    await gerar();
    const dre = await waitFor(() => {
      const el = document.querySelector('.fn-dre');
      expect(el).not.toBeNull();
      return el;
    });
    expect(dre).toHaveTextContent('R$ 30000.00');
    expect(dre).toHaveTextContent('R$ 15000.00');
    expect(dre).toHaveTextContent('R$ 5000.00');
  });

  it('tickets resgatados só aparecem quando existem', async () => {
    // Uma linha de "R$ 0,00" no DRE só ocupa espaço.
    await montar({ relatorio: { ...RELATORIO, tickets_redeemed_value: 0 } });
    await gerar();
    await waitFor(() => expect(document.querySelector('.fn-dre')).not.toBeNull());
    expect(document.querySelector('.fn-dre')).not.toHaveTextContent('dreTicketsRedeemed');
  });
});

describe('outras receitas e despesas no DRE', () => {
  it('outras receitas aparecem detalhadas por origem', async () => {
    // Bar, patrocínio e aluguel não passam pelo caixa do torneio, mas fazem
    // parte do faturamento — fora do DRE, o resultado sai menor do que é.
    await montar();
    await gerar();
    await waitFor(() => expect(document.querySelector('.fn-dre')).not.toBeNull());
    expect(document.querySelector('.fn-dre')).toHaveTextContent('Bar');
    expect(document.querySelector('.fn-dre')).toHaveTextContent('R$ 4000.00');
  });

  it('sem outras receitas, a seção nem aparece', async () => {
    await montar({ relatorio: { ...RELATORIO, other_revenue: 0 } });
    await gerar();
    await waitFor(() => expect(document.querySelector('.fn-dre')).not.toBeNull());
    expect(document.querySelector('.fn-dre')).not.toHaveTextContent('Bar');
  });

  it('despesas aparecem detalhadas por categoria', async () => {
    await montar();
    await gerar();
    await waitFor(() => expect(document.querySelector('.fn-dre')).not.toBeNull());
    expect(document.querySelector('.fn-dre')).toHaveTextContent('Aluguel');
  });

  it('período sem despesa diz isso, em vez de deixar a seção vazia', async () => {
    // Uma seção em branco pareceria dado faltando.
    await montar({ relatorio: { ...RELATORIO, expenses_by_category: [] } });
    await gerar();
    await waitFor(() => expect(document.querySelector('.fn-dre')).not.toBeNull());
    expect(document.querySelector('.fn-dre')).toHaveTextContent('Nenhuma despesa lançada no período');
  });

  it('o quadro por torneio lista cada torneio do período', async () => {
    // "Main Event" também é opção do filtro de torneio; a tabela é o alvo.
    await montar();
    await gerar();
    await waitFor(() =>
      expect(document.querySelector('.transactions-table tbody')).not.toBeNull()
    );
    const quadro = Array.from(document.querySelectorAll('table')).find((t) =>
      t.textContent.includes('Main Event')
    );
    expect(quadro).toBeTruthy();
  });

  it('relatório SEM o quadro por torneio não derruba a tela', async () => {
    // Era o defeito: `data.by_tournament.length` sem proteção quebrava tudo.
    await montar({ relatorio: { ...RELATORIO, by_tournament: undefined } });
    await gerar();
    await waitFor(() => expect(document.querySelector('.fn-dre')).not.toBeNull());
    const quadro = Array.from(document.querySelectorAll('table')).find((t) =>
      t.textContent.includes('Main Event')
    );
    expect(quadro).toBeUndefined();
  });
});

describe('forma de pagamento nas transações', () => {
  it('código embutido é traduzido', async () => {
    await montar();
    await gerar();
    await waitFor(() => expect(linhaDaTransacao('financial.typeBuyIn')).toBeDefined());
    expect(linhaDaTransacao('financial.typeBuyIn')).toHaveTextContent('PIX');
  });

  it('método PERSONALIZADO usa o rótulo salvo pelo clube', async () => {
    // Yape/Nequi não existem no i18n; o rótulo vem do cadastro.
    await montar();
    await gerar();
    await waitFor(() => expect(linhaDaTransacao('financial.typeAddon')).toBeDefined());
    expect(linhaDaTransacao('financial.typeAddon')).toHaveTextContent('Yape');
  });

  it('quando o método é dinheiro, a ORIGEM é que aparece', async () => {
    // Registros antigos não têm método; a origem (crédito/misto/ticket) é a
    // informação que sobra.
    await montar();
    await gerar();
    await waitFor(() => expect(linhaDaTransacao('financial.typeRebuy')).toBeDefined());
    expect(linhaDaTransacao('financial.typeRebuy')).toHaveTextContent('financial.paymentCredit');
  });

  it('código desconhecido aparece como veio, em vez de sumir', async () => {
    usePaymentMethods.mockReturnValue({ labelFor: () => null });
    await montar({
      relatorio: { ...RELATORIO,
        transactions: [{ id: 'x9', type: 'buy_in', amount: 10, payment_method: 'boleto' }] },
    });
    await gerar();
    expect(await screen.findByText('boleto')).toBeInTheDocument();
  });

  it('transação sem método nem origem mostra travessão', async () => {
    await montar({
      relatorio: { ...RELATORIO, transactions: [{ id: 'x9', type: 'buy_in', amount: 10 }] },
    });
    await gerar();
    await waitFor(() => expect(linhaDaTransacao('financial.typeBuyIn')).toBeDefined());
    expect(linhaDaTransacao('financial.typeBuyIn')).toHaveTextContent('--');
  });

  it('tipo desconhecido aparece como veio', async () => {
    await montar({
      relatorio: { ...RELATORIO, transactions: [{ id: 'x9', type: 'tipo_novo', amount: 10 }] },
    });
    await gerar();
    expect(await screen.findByText('tipo_novo')).toBeInTheDocument();
  });
});

describe('filtros das transações', () => {
  it('filtrar por tipo esconde os demais', async () => {
    await montar();
    await gerar();
    await waitFor(() => expect(linhaDaTransacao('financial.typeBuyIn')).toBeDefined());
    const seletores = Array.from(document.querySelectorAll('select'));
    const porTipo = seletores.find((s) =>
      Array.from(s.options).some((o) => o.value === 'buy_in')
    );
    await userEvent.selectOptions(porTipo, 'buy_in');
    expect(linhaDaTransacao('financial.typeRebuy')).toBeUndefined();
    expect(linhaDaTransacao('financial.typeBuyIn')).toBeDefined();
  });

  it('filtrar por origem também', async () => {
    await montar();
    await gerar();
    await waitFor(() => expect(linhaDaTransacao('financial.typeRebuy')).toBeDefined());
    const seletores = Array.from(document.querySelectorAll('select'));
    const porOrigem = seletores.find((s) =>
      Array.from(s.options).some((o) => o.value === 'credit')
    );
    await userEvent.selectOptions(porOrigem, 'credit');
    expect(linhaDaTransacao('financial.typeRebuy')).toBeDefined();
    expect(linhaDaTransacao('financial.typeBuyIn')).toBeUndefined();
  });
});
