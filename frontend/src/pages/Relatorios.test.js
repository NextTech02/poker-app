/**
 * Relatórios — o painel de desempenho por período.
 *
 * A tela recarrega sozinha quando o período muda: o operador ajusta a data e o
 * relatório se refaz, sem botão de "gerar". O que os testes prendem:
 *
 * - **A taxa de recompra não divide por zero.** Num período sem nenhum buy-in
 *   a conta `(rebuys + addons) / buy_ins` daria Infinity ou NaN na tela.
 * - **O Top 5 é por VALOR GASTO**, não pela ordem que o servidor mandou — é a
 *   lista que o clube usa para saber quem tratar melhor.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Relatorios from './Relatorios';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../components/ReportExportPanel', () => ({ summary }) => (
  <div data-testid="exportar">{summary?.totalTournaments}</div>
));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('react-i18next', () => {
  const t = (chave, segundo) => (typeof segundo === 'string' ? segundo : chave);
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const RELATORIO = {
  totalRevenue: 120000, totalTournaments: 8, totalPlayers: 240, avgBuyIn: 500,
  totalBuyIns: 200, totalRebuys: 80, totalAddons: 20,
  playerReports: [
    { player_id: 'p1', player_name: 'Ana', total_spent: 3000 },
    { player_id: 'p2', player_name: 'Beto', total_spent: 9000 },
    { player_id: 'p3', player_name: 'Carla', total_spent: 5000 },
    { player_id: 'p4', player_name: 'Davi', total_spent: 1000 },
    { player_id: 'p5', player_name: 'Elis', total_spent: 7000 },
    { player_id: 'p6', player_name: 'Fábio', total_spent: 500 },
  ],
};

let toast;

const responder = ({ relatorio = RELATORIO } = {}) => {
  api.get.mockImplementation(() =>
    relatorio instanceof Error ? Promise.reject(relatorio) : Promise.resolve({ data: relatorio })
  );
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<Relatorios />);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/reports', expect.anything()));
};

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  useToast.mockReturnValue({ toast });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('período', () => {
  it('o padrão vai do início do mês até hoje', async () => {
    await montar();
    const params = api.get.mock.calls[0][1].params;
    expect(params.start).toMatch(/^\d{4}-\d{2}-01$/);
    expect(params.end).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('mudar a data recarrega sozinho, sem botão de gerar', async () => {
    // O operador ajusta o período e vê o resultado; um botão a mais seria só
    // um passo extra.
    await montar();
    const antes = api.get.mock.calls.length;
    await userEvent.clear(document.getElementById('start'));
    await userEvent.type(document.getElementById('start'), '2026-01-01');
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(antes));
  });

  it('falha ao carregar avisa com a mensagem do interceptor', async () => {
    const erro = new Error('403');
    erro.userMessage = 'Sem permissão para relatórios';
    await montar({ relatorio: erro });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Sem permissão para relatórios'));
  });

  it('erro sem mensagem cai numa frase clara', async () => {
    await montar({ relatorio: new Error('boom') });
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        'Erro ao carregar relatórios. Verifique a conexão e tente novamente.'
      )
    );
  });
});

describe('indicadores', () => {
  it('mostra receita, torneios e jogadores do período', async () => {
    // O painel de exportar (mockado) também imprime o total de torneios; os
    // cartões do topo são o alvo.
    await montar();
    await screen.findByText('R$ 120000.00');
    const indicadores = document.querySelector('.stats-grid');
    expect(indicadores).toHaveTextContent('8');
    expect(indicadores).toHaveTextContent('240');
  });

  it('a taxa de recompra é calculada sobre os buy-ins', async () => {
    // (80 + 20) / 200 = 50%.
    await montar();
    await screen.findByText(/50\.0/);
  });

  it('período SEM buy-in não vira divisão por zero', async () => {
    // Infinity ou NaN na tela é pior do que 0%.
    await montar({
      relatorio: { ...RELATORIO, totalBuyIns: 0, totalRebuys: 0, totalAddons: 0 },
    });
    await waitFor(() => expect(document.querySelector('.stats-grid')).not.toBeNull());
    expect(document.querySelector('.main-content').textContent).not.toMatch(/NaN|Infinity/);
  });
});

describe('top 5 jogadores', () => {
  it('ordena por valor gasto, não pela ordem que veio', async () => {
    // É a lista que o clube usa para saber quem tratar melhor.
    await montar();
    await waitFor(() => expect(document.querySelector('.ranking-item')).not.toBeNull());
    const nomes = Array.from(document.querySelectorAll('.ranking-name')).map((e) => e.textContent);
    expect(nomes).toEqual(['Beto', 'Elis', 'Carla', 'Ana', 'Davi']);
  });

  it('o ranking mostra no máximo cinco, mas a TABELA lista todos', async () => {
    // São duas leituras diferentes: o destaque dos cinco maiores e o relatório
    // completo, que precisa conter todo mundo.
    await montar();
    await waitFor(() => expect(document.querySelector('.ranking-item')).not.toBeNull());
    expect(document.querySelectorAll('.ranking-item').length).toBe(5);
    expect(document.querySelectorAll('.reports-table tbody tr').length).toBe(6);
    expect(within(document.querySelector('.reports-table')).getByText('Fábio')).toBeInTheDocument();
  });

  it('sem jogador nenhum não quebra a tela', async () => {
    await montar({ relatorio: { ...RELATORIO, playerReports: [] } });
    await screen.findByText('R$ 120000.00');
  });

  it('lista ausente também não quebra', async () => {
    // Um relatório antigo pode não trazer a chave.
    await montar({ relatorio: { ...RELATORIO, playerReports: undefined } });
    await screen.findByText('R$ 120000.00');
  });
});

describe('exportação', () => {
  it('o painel de exportar recebe o resumo do período', async () => {
    // Exportar um resumo diferente do que está na tela seria pior do que não
    // exportar.
    await montar();
    await waitFor(() => expect(screen.getByTestId('exportar')).toHaveTextContent('8'));
  });
});


/**
 * Por MEIO de entrada: com a lista do período, a tabela de jogadores ganha
 * uma coluna por meio cadastrado ("Doble", "Tasa"…) no lugar das três
 * categorias fixas; sem a lista (backend antigo), as três continuam.
 */
describe('por meio de entrada', () => {
  const COM_MEIOS = {
    ...RELATORIO,
    byBuyType: [
      { name: 'Buy-in', category: 'buy_in', count: 150, amount: 75000 },
      { name: 'Doble', category: 'buy_in', count: 50, amount: 50000 },
      { name: 'Tasa', category: 'addon', count: 20, amount: 2000 },
    ],
    playerReports: [
      { player_id: 'p1', player_name: 'Ana', total_spent: 3000, buy_ins: 2, rebuys: 0, addons: 1, by_buy_type: { 'Buy-in': 1, Doble: 1, Tasa: 1 } },
      { player_id: 'p2', player_name: 'Beto', total_spent: 500, buy_ins: 1, rebuys: 0, addons: 0, by_buy_type: { 'Buy-in': 1 } },
    ],
  };

  it('a tabela de jogadores ganha uma coluna por meio cadastrado', async () => {
    await montar({ relatorio: COM_MEIOS });
    const cabecalhos = Array.from(document.querySelectorAll('.reports-table:not(.reports-table--buytypes) thead th')).map((th) => th.textContent);
    expect(cabecalhos).toEqual(['Jogador', 'Buy-in', 'Doble', 'Tasa', 'Total Gasto']);
    const beto = Array.from(document.querySelectorAll('.reports-table:not(.reports-table--buytypes) tbody tr')).find((tr) => tr.textContent.includes('Beto'));
    expect(Array.from(beto.querySelectorAll('td')).map((td) => td.textContent)).toEqual(['Beto', '1', '0', '0', 'R$ 500.00']);
  });

  it('o card "Por meio de entrada" lista quantidade e valor de cada meio', async () => {
    await montar({ relatorio: COM_MEIOS });
    const tabela = document.querySelector('.reports-table--buytypes');
    expect(tabela).toHaveTextContent('Doble');
    expect(tabela).toHaveTextContent('50');
    expect(tabela).toHaveTextContent('R$ 50000.00');
  });

  it('sem a lista (backend antigo) as três categorias continuam', async () => {
    await montar();
    const cabecalhos = Array.from(document.querySelectorAll('.reports-table thead th')).map((th) => th.textContent);
    expect(cabecalhos).toEqual(['Jogador', 'Buy-ins', 'Rebuys', 'Add-ons', 'Total Gasto']);
    expect(document.querySelector('.reports-table--buytypes')).toBeNull();
  });
});
