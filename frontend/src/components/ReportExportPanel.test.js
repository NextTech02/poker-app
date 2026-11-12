/**
 * Painel de exportação de relatórios.
 *
 * O que ele resolve: o contador do clube pede a planilha, e antes disso
 * alguém copiava número por número da tela. A regra central é **buscar só o
 * que foi pedido** — desmarcar a premiação evita uma chamada por torneio do
 * período, que num circuito de 40 torneios seriam 40 requisições.
 *
 * A premiação usa `allSettled` de propósito: um torneio com problema não
 * pode derrubar o relatório inteiro. É melhor entregar 39 de 40 do que
 * nada.
 *
 * Despesas e receitas vêm de endpoints próprios (não do financeiro) e
 * falham em silêncio: o relatório sai sem elas em vez de não sair.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ReportExportPanel from './ReportExportPanel';
import api from '../config/api';
import { exportSections } from '../utils/reportExport';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../utils/reportExport', () => ({ exportSections: jest.fn() }));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
// Os meios personalizados do clube (Yape) têm o rótulo do cadastro.
jest.mock('../contexts/PaymentMethodsContext', () => ({
  usePaymentMethods: () => ({ labelFor: (c) => ({ yape: 'YAPE' }[c] || null) }),
}));
jest.mock('react-i18next', () => {
  const t = (chave, padrao) => (typeof padrao === 'string' ? padrao : chave);
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const RESUMO = {
  totalRevenue: 50000,
  totalTournaments: 4,
  totalPlayers: 120,
  avgBuyIn: 300,
  totalBuyIns: 100,
  totalRebuys: 30,
  totalAddons: 20,
  playerReports: [
    { player_name: 'Ana', total_entries: 3, buy_ins: 2, rebuys: 1, addons: 0, total_spent: 900 },
  ],
};

const PERIODO = { start: '2026-06-01', end: '2026-06-30' };

const FINANCEIRO = {
  revenue: { buy_ins: 30000, rebuys: 15000, addons: 5000 },
  by_tournament: [
    { tournament_id: 't1', tournament_name: 'Main Event' },
    { tournament_id: 't2', tournament_name: 'Turbo' },
  ],
  transactions: [],
};

let toast;

const responder = ({ financeiro = FINANCEIRO, premios = {}, despesas = [], receitas = [] } = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/reports/financial') return Promise.resolve({ data: financeiro });
    if (url === '/expenses') return Promise.resolve({ data: despesas });
    if (url === '/revenues') return Promise.resolve({ data: receitas });
    if (url.startsWith('/reports/tournament/')) {
      const id = url.split('/').pop();
      // Fabricas, nao Promises prontas: uma Promise rejeitada criada antes de
      // ser aguardada vira "unhandled rejection" e derruba o teste.
      return premios[id] ? premios[id]() : Promise.resolve({ data: { prizes: [] } });
    }
    return Promise.resolve({ data: {} });
  });
};

const abrir = async (props = {}) => {
  render(<ReportExportPanel summary={RESUMO} dateRange={PERIODO} {...props} />);
  await userEvent.click(screen.getByRole('button', { name: /Exportar/ }));
};

const exportar = () =>
  userEvent.click(document.querySelector('.rex-btn.primary'));

/** Desmarca uma seção pelo rótulo. */
const desmarcar = (rotulo) =>
  userEvent.click(screen.getByRole('checkbox', { name: rotulo }));

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn() };
  useToast.mockReturnValue({ toast });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${v}` });
  exportSections.mockResolvedValue(undefined);
  responder();
});

describe('abertura', () => {
  it('começa fechado', () => {
    render(<ReportExportPanel summary={RESUMO} dateRange={PERIODO} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('abre o diálogo', async () => {
    await abrir();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('todas as seções vêm marcadas', async () => {
    // O caso comum é querer tudo; desmarcar é a exceção.
    await abrir();
    screen.getAllByRole('checkbox').forEach((c) => expect(c).toBeChecked());
  });

  it('o formato padrão é planilha', async () => {
    // É o formato que o contador pede.
    await abrir();
    expect(document.querySelector('.rex-format.active')).toHaveTextContent('XLSX');
  });

  it('cada formato explica para que serve', async () => {
    await abrir();
    expect(screen.getByText(/várias abas/)).toBeInTheDocument();
    await userEvent.click(screen.getByText('CSV').closest('button'));
    expect(screen.getByText(/todas as seções empilhadas/)).toBeInTheDocument();
    await userEvent.click(screen.getByText('PDF').closest('button'));
    expect(screen.getByText(/apresentação\/impressão/)).toBeInTheDocument();
  });

  it('fecha ao clicar fora', async () => {
    await abrir();
    await userEvent.click(document.querySelector('.rex-overlay'));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clicar dentro não fecha', async () => {
    await abrir();
    await userEvent.click(document.querySelector('.rex-modal'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('cancelar fecha', async () => {
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('busca sob demanda', () => {
  it('sem seção que precise do financeiro, não consulta o financeiro', async () => {
    // Numa exportação só do resumo, a consulta seria trabalho jogado fora.
    await abrir();
    await desmarcar('Financeiro (DRE)');
    await desmarcar('Torneios');
    await desmarcar('Transações');
    await desmarcar('Premiação');
    await desmarcar('Despesas');
    await desmarcar('Outras receitas');
    await exportar();
    await waitFor(() => expect(exportSections).toHaveBeenCalled());
    expect(api.get).not.toHaveBeenCalledWith('/reports/financial', expect.anything());
  });

  it('a premiação custa uma chamada por torneio — só quando marcada', async () => {
    // Num circuito de 40 torneios seriam 40 requisições.
    await abrir();
    await desmarcar('Premiação');
    await exportar();
    await waitFor(() => expect(exportSections).toHaveBeenCalled());
    expect(api.get).not.toHaveBeenCalledWith(
      expect.stringContaining('/reports/tournament/'),
      expect.anything()
    );
  });

  it('com premiação marcada consulta cada torneio', async () => {
    await abrir();
    await exportar();
    await waitFor(() => expect(exportSections).toHaveBeenCalled());
    expect(api.get).toHaveBeenCalledWith('/reports/tournament/t1');
    expect(api.get).toHaveBeenCalledWith('/reports/tournament/t2');
  });

  it('um torneio com problema não derruba o relatório', async () => {
    // Melhor entregar 39 de 40 do que nada.
    responder({
      premios: {
        t1: () => Promise.reject(new Error('500')),
        t2: () => Promise.resolve({
          data: { prizes: [{ position: 1, prize_type: 'cash', prize_amount: 5000, paid: true, released: true }] },
        }),
      },
    });
    await abrir();
    await exportar();
    await waitFor(() => expect(exportSections).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalled();
  });

  it('despesas e receitas falhando não impedem a exportação', async () => {
    api.get.mockImplementation((url) => {
      if (url === '/reports/financial') return Promise.resolve({ data: FINANCEIRO });
      if (url === '/expenses' || url === '/revenues') return Promise.reject(new Error('403'));
      return Promise.resolve({ data: { prizes: [] } });
    });
    await abrir();
    await exportar();
    await waitFor(() => expect(exportSections).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalled();
  });

  it('sem seção de despesa marcada, o endpoint nem é chamado', async () => {
    await abrir();
    await desmarcar('Despesas');
    await desmarcar('Outras receitas');
    await exportar();
    await waitFor(() => expect(exportSections).toHaveBeenCalled());
    expect(api.get).not.toHaveBeenCalledWith('/expenses', expect.anything());
    expect(api.get).not.toHaveBeenCalledWith('/revenues', expect.anything());
  });
});

describe('conteúdo exportado', () => {
  it('o resumo traz os números da tela', async () => {
    await abrir();
    await exportar();
    await waitFor(() => expect(exportSections).toHaveBeenCalled());
    const secoes = exportSections.mock.calls[0][0];
    const resumo = secoes.find((s) => s.title === 'Resumo geral');
    const receita = resumo.rows.find((r) => r.label === 'Receita Total');
    expect(receita.value).toBe(50000);
  });

  it('a taxa de rebuy é calculada sobre os buy-ins', async () => {
    // (30 rebuys + 20 add-ons) / 100 buy-ins = 50%.
    await abrir();
    await exportar();
    await waitFor(() => expect(exportSections).toHaveBeenCalled());
    const resumo = exportSections.mock.calls[0][0].find((s) => s.title === 'Resumo geral');
    expect(resumo.rows.find((r) => r.label.includes('Rebuy/Add-on')).value).toBe(50);
  });

  it('sem buy-in a taxa é zero, não divisão por zero', async () => {
    render(
      <ReportExportPanel
        summary={{ ...RESUMO, totalBuyIns: 0 }}
        dateRange={PERIODO}
      />
    );
    await userEvent.click(screen.getByRole('button', { name: /Exportar/ }));
    await exportar();
    await waitFor(() => expect(exportSections).toHaveBeenCalled());
    const resumo = exportSections.mock.calls[0][0].find((s) => s.title === 'Resumo geral');
    expect(resumo.rows.find((r) => r.label.includes('Rebuy/Add-on')).value).toBe(0);
  });

  it('o período entra no cabeçalho e no nome do arquivo', async () => {
    // Um arquivo "relatorio.xlsx" sem data vira um problema na terceira
    // exportação.
    await abrir();
    await exportar();
    await waitFor(() => expect(exportSections).toHaveBeenCalled());
    const opcoes = exportSections.mock.calls[0][1];
    expect(opcoes.filename).toContain('2026-06-01');
    expect(opcoes.filename).toContain('2026-06-30');
    // No documento, a data como se lê no idioma do app — e no dia certo: lida
    // como UTC, "2026-06-01" viraria 31/05 no fuso de -3h.
    expect(opcoes.meta.subtitle).toContain('01/06/2026');
    expect(opcoes.meta.subtitle).toContain('30/06/2026');
  });

  it('o formato escolhido é repassado', async () => {
    await abrir();
    await userEvent.click(screen.getByText('PDF').closest('button'));
    await exportar();
    await waitFor(() => expect(exportSections).toHaveBeenCalled());
    expect(exportSections.mock.calls[0][1].format).toBe('pdf');
  });

  it('o formatador de moeda do clube vai junto', async () => {
    // O PDF é lido por pessoas; sem o formatador sairia "50000" cru.
    await abrir();
    await exportar();
    await waitFor(() => expect(exportSections).toHaveBeenCalled());
    expect(typeof exportSections.mock.calls[0][1].formatCurrency).toBe('function');
  });

  it('resumo ausente não quebra a exportação', async () => {
    // A aba pode abrir antes de os dados chegarem.
    render(<ReportExportPanel summary={null} dateRange={PERIODO} />);
    await userEvent.click(screen.getByRole('button', { name: /Exportar/ }));
    await exportar();
    await waitFor(() => expect(exportSections).toHaveBeenCalled());
  });
});

describe('falhas', () => {
  it('nenhuma seção marcada avisa antes de tentar', async () => {
    await abrir();
    const caixas = screen.getAllByRole('checkbox');
    for (const c of caixas) {
      await userEvent.click(c);
    }
    await exportar();
    expect(toast.error).toHaveBeenCalledWith('Selecione pelo menos uma seção');
    expect(exportSections).not.toHaveBeenCalled();
  });

  it('falha do financeiro vira aviso genérico e mantém o diálogo', async () => {
    // O operador tenta de novo sem refazer as escolhas.
    api.get.mockRejectedValue(new Error('500'));
    await abrir();
    await exportar();
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('exportação sem seções montadas usa a mesma mensagem', async () => {
    exportSections.mockRejectedValue(new Error('no-sections'));
    await abrir();
    await exportar();
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Selecione pelo menos uma seção')
    );
  });

  it('exportação bem-sucedida fecha o diálogo', async () => {
    await abrir();
    await exportar();
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(toast.success).toHaveBeenCalled();
  });
});

describe('detalhe por meio de entrada (pedido do NSOP)', () => {
  /* A exportação só trazia Buy-ins, Rebuys e Add-ons: a Tasa, o Doble e os
     outros itens cobrados não apareciam em lugar nenhum da planilha. */
  const MEIOS = [
    { name: 'Buy-in', category: 'buy_in', count: 50, amount: 10000 },
    { name: 'Doble', category: 'rebuy', count: 20, amount: 8000 },
    { name: 'Tasa', category: 'fee', count: 40, amount: 2000 },
  ];
  const COM_MEIOS = { ...RESUMO, totalFees: 40, byBuyType: MEIOS };
  const FIN = {
    revenue: { buy_ins: 10000, rebuys: 8000, addons: 0, fees: 2000 },
    by_tournament: [{
      tournament_id: 't1', tournament_name: 'Main Event', fees_count: 40,
      by_buy_type: MEIOS,
    }],
    transactions: [
      { created_at: '2026-06-02T20:00:00Z', tournament_name: 'Main Event', player_name: 'Ana',
        type: 'addon', is_fee: true, buy_type_name: 'Bono Dealer', amount: 50, payment_method: 'cash' },
      { created_at: '2026-06-02T20:05:00Z', tournament_name: 'Main Event', player_name: 'Beto',
        type: 'rebuy', buy_type_name: 'Doble', amount: 400, payment_method: 'cash' },
      { created_at: '2026-06-02T23:00:00Z', tournament_name: 'Main Event', player_name: 'Ana',
        type: 'prize', amount: 900 },
    ],
  };
  const secoes = () => exportSections.mock.calls[0][0];
  const secao = (titulo) => secoes().find((s) => s.title === titulo);

  const exportarTudo = async () => {
    responder({ financeiro: FIN });
    await abrir({ summary: COM_MEIOS });
    await exportar();
    await waitFor(() => expect(exportSections).toHaveBeenCalled());
  };

  it('resumo e DRE trazem as taxas', async () => {
    await exportarTudo();
    expect(secao('Resumo geral').rows.find((r) => r.label === 'Total Taxas').value).toBe(40);
    expect(secao('Financeiro (DRE)').rows.find((r) => r.label === 'Taxas').value).toBe(2000);
  });

  it('vendas do período por meio, com categoria traduzida', async () => {
    await exportarTudo();
    expect(secao('Por meio de entrada').rows.map((r) => [r.name, r.category, r.count, r.amount])).toEqual([
      ['Buy-in', 'Buy-ins', 50, 10000],
      ['Doble', 'Rebuys', 20, 8000],
      ['Tasa', 'Taxas', 40, 2000],
    ]);
  });

  it('"Por meio de entrada" sai mesmo sem a seção de jogadores', async () => {
    responder({ financeiro: FIN });
    await abrir({ summary: COM_MEIOS });
    await desmarcar('Jogadores');
    await exportar();
    await waitFor(() => expect(exportSections).toHaveBeenCalled());
    expect(secao('Por meio de entrada')).toBeDefined();
  });

  it('torneios ganham a coluna de taxas e a abertura por meio', async () => {
    await exportarTudo();
    expect(secao('Torneios').columns.map((c) => c.key)).toContain('fees_count');
    expect(secao('Torneios por meio de entrada').rows.map((r) => [r.tournament_name, r.name, r.count])).toEqual([
      ['Main Event', 'Buy-in', 50], ['Main Event', 'Doble', 20], ['Main Event', 'Tasa', 40],
    ]);
  });

  it('a aba Torneios ganha uma coluna por meio, depois das categorias', async () => {
    // "Assim como a Tasa, agregar o Doble" — e o Buy-in Promocional.
    responder({
      financeiro: {
        ...FIN,
        by_tournament: [
          {
            tournament_id: 't1', tournament_name: 'Main Event', buy_ins_count: 159, rebuys_count: 68, fees_count: 217,
            by_buy_type: [
              { name: 'Buy-in', category: 'buy_in', count: 127, amount: 0 },
              { name: 'Buy-in Promocion', category: 'buy_in', count: 32, amount: 0 },
              { name: 'Doble', category: 'rebuy', count: 33, amount: 0 },
              { name: 'Rebuy', category: 'rebuy', count: 35, amount: 0 },
              { name: 'Bono Dealer', category: 'fee', count: 217, amount: 0 },
            ],
          },
          {
            tournament_id: 't2', tournament_name: 'Sat', buy_ins_count: 7,
            by_buy_type: [{ name: 'Buy-in', category: 'buy_in', count: 7, amount: 0 }],
          },
        ],
      },
    });
    await abrir({ summary: COM_MEIOS });
    await exportar();
    await waitFor(() => expect(exportSections).toHaveBeenCalled());
    const torneios = secao('Torneios');
    expect(torneios.columns.map((c) => c.label)).toEqual([
      'Torneio', 'Jogadores', 'Buy-ins', 'Rebuys', 'Add-ons', 'Taxas',
      'Buy-in', 'Buy-in Promocion', 'Doble', 'Rebuy', 'Bono Dealer',
      'Receita', 'Prêmios', 'Líquido',
    ]);
    const valores = (linha) => torneios.columns.slice(6, 11).map((c) => linha[c.key]);
    expect(valores(torneios.rows[0])).toEqual([127, 32, 33, 35, 217]);
    // O torneio que não vendeu o meio fica com zero, não com a célula vazia.
    expect(valores(torneios.rows[1])).toEqual([7, 0, 0, 0, 0]);
  });

  it('nome repetido em duas categorias diz a categoria no cabeçalho', async () => {
    responder({
      financeiro: {
        ...FIN,
        by_tournament: [{
          tournament_id: 't1', tournament_name: 'Main Event',
          by_buy_type: [
            { name: 'Doble', category: 'buy_in', count: 2, amount: 0 },
            { name: 'Doble', category: 'rebuy', count: 5, amount: 0 },
          ],
        }],
      },
    });
    await abrir({ summary: COM_MEIOS });
    await exportar();
    await waitFor(() => expect(exportSections).toHaveBeenCalled());
    const rotulos = secao('Torneios').columns.map((c) => c.label);
    expect(rotulos).toContain('Doble (Buy-ins)');
    expect(rotulos).toContain('Doble (Rebuys)');
  });

  it('a forma de pagamento sai pelo nome, não pelo código gravado', async () => {
    // O PDF de 10/11 dizia "cash".
    responder({
      financeiro: {
        ...FIN,
        transactions: [
          { created_at: '2026-06-02T20:00:00Z', type: 'buy_in', amount: 400, payment_method: 'cash', payment_source: 'cash' },
          { created_at: '2026-06-02T20:01:00Z', type: 'buy_in', amount: 400, payment_method: 'yape', payment_source: 'cash' },
          { created_at: '2026-06-02T20:02:00Z', type: 'rebuy', amount: 400, payment_method: 'cash', payment_source: 'credit' },
          { created_at: '2026-06-02T20:03:00Z', type: 'prize', amount: 900, payment_source: 'cash' },
          {
            created_at: '2026-06-02T20:04:00Z', type: 'rebuy', amount: 500, payment_method: 'split', payment_source: 'cash',
            payment_split: [{ payment_method: 'cash', amount: 300 }, { payment_method: 'yape', amount: 200 }],
          },
        ],
      },
    });
    await abrir({ summary: COM_MEIOS });
    await exportar();
    await waitFor(() => expect(exportSections).toHaveBeenCalled());
    expect(secao('Transações').rows.map((r) => r.payment_method)).toEqual([
      'financial.paymentCash', 'YAPE', 'Crédito', 'financial.paymentCash',
      'financial.paymentCash R$ 300 · YAPE R$ 200',
    ]);
  });

  it('servidor que manda um meio por torneio: uma linha e uma coluna por nome', async () => {
    // O PDF de 10/11: 15 linhas "Buy-in" e o quadro de jogadores com 45
    // colunas, espremido até o cabeçalho quebrar letra por letra.
    const ANTIGO = {
      ...COM_MEIOS,
      byBuyType: [
        { name: 'Buy-in', category: 'buy_in', count: 127, amount: 63500 },
        { name: 'Bono Dealer', category: 'fee', count: 188, amount: 9400 },
        { name: 'Buy-in', category: 'buy_in', count: 18, amount: 9000 },
        { name: 'Rebuy', category: 'rebuy', count: 35, amount: 17500 },
        { name: 'BONO DEALER', category: 'fee', count: 19, amount: 380 },
      ],
      playerReports: [
        { player_name: 'Ana', total_entries: 3, total_spent: 900, by_buy_type: { 'Buy-in': 2, 'Bono Dealer': 1, 'BONO DEALER': 2 } },
      ],
    };
    responder({ financeiro: FIN });
    await abrir({ summary: ANTIGO });
    await exportar();
    await waitFor(() => expect(exportSections).toHaveBeenCalled());
    // Uma linha por meio, somada, na ordem Buy-in → Rebuy → Taxa.
    expect(secao('Por meio de entrada').rows.map((r) => [r.name, r.count, r.amount])).toEqual([
      ['Buy-in', 145, 72500], ['Rebuy', 35, 17500], ['Bono Dealer', 207, 9780],
    ]);
    const jogadores = secao('Jogadores');
    expect(jogadores.columns.map((c) => c.label)).toEqual([
      'Jogador', 'Entradas', 'Buy-in', 'Rebuy', 'Bono Dealer', 'Total Gasto',
    ]);
    // "Bono Dealer" e "BONO DEALER" do jogador caem na mesma coluna.
    const ana = jogadores.rows[0];
    expect(jogadores.columns.slice(2, 5).map((c) => ana[c.key])).toEqual([2, 0, 3]);
  });

  it('a premiação diz Sim/Não, não "✓" (a fonte do PDF não tem o símbolo)', async () => {
    responder({
      financeiro: FIN,
      premios: {
        t1: () => Promise.resolve({ data: { prizes: [
          { position: 1, player_name: 'Ana', prize_amount: 900, released: true, paid: false },
        ] } }),
      },
    });
    await abrir({ summary: COM_MEIOS });
    await exportar();
    await waitFor(() => expect(exportSections).toHaveBeenCalled());
    const [premio] = secao('Premiação').rows;
    expect([premio.released, premio.paid]).toEqual(['Sim', 'Não']);
  });

  it('transações dizem o que foi vendido e marcam a taxa', async () => {
    await exportarTudo();
    const linhas = secao('Transações').rows.map((r) => [r.type, r.description]);
    expect(linhas).toEqual([['Taxas', 'Bono Dealer'], ['Rebuys', 'Doble'], ['Prêmio', '—']]);
  });
});
