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
    expect(opcoes.meta.subtitle).toContain('2026-06-01');
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
