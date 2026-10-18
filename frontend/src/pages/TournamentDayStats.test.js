/**
 * Estatísticas do dia — dois relatórios diferentes na mesma tela.
 *
 * O tipo do dia decide QUAL endpoint é consultado: um dia normal tem números
 * próprios (`/stats`); o dia FINAL só faz sentido somando os classificatórios
 * que alimentaram ele (`/aggregated-stats`). Pedir o endpoint errado mostraria
 * um dia final "sem jogadores", porque ninguém comprou entrada nele.
 *
 * Por isso o dia é carregado ANTES das outras duas consultas: é dele que sai o
 * torneio e a decisão de qual relatório buscar.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import TournamentDayStats from './TournamentDayStats';
import api from '../config/api';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ dayId: 'd1' }),
  useNavigate: () => mockNavigate,
}));
jest.mock('react-i18next', () => {
  const t = (chave, vars) =>
    vars && typeof vars === 'object' ? `${chave}:${Object.values(vars).join(',')}` : chave;
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const DIA = { id: 'd1', day_name: 'Dia 1A', tournament_id: 't1', day_type: 'regular', status: 'active' };
const TORNEIO = { id: 't1', name: 'Main Event' };

const ESTATISTICAS = {
  total_players: 80, eliminated_players: 60, total_buy_ins: 80, total_rebuys: 30,
  total_addons: 10, total_entries: 120, prize_pool: 90000, total_collected: 120000,
};

const AGREGADAS = {
  combined_prize_pool: 250000, combined_total_collected: 300000,
  total_players: 27, total_qualified_players: 27,
  qualifying_days: [
    { day_id: 'q1', day_name: 'Classificatório 1', total_players: 100,
      eliminated_players: 91, qualified_players: 9, total_buy_ins: 100,
      total_rebuys: 40, total_addons: 5, total_entries: 145 },
  ],
};

const responder = ({ dia = DIA, torneio = TORNEIO, stats = ESTATISTICAS } = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/tournament-days/d1') {
      return dia instanceof Error ? Promise.reject(dia) : Promise.resolve({ data: dia });
    }
    if (url === '/tournaments/t1') return Promise.resolve({ data: torneio });
    // Cobre `/stats` e `/aggregated-stats` (que NÃO contém "/stats").
    if (url.endsWith('stats')) {
      return stats instanceof Error ? Promise.reject(stats) : Promise.resolve({ data: stats });
    }
    return Promise.resolve({ data: {} });
  });
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<MemoryRouter><TournamentDayStats /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
};

beforeEach(() => {
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('qual relatório é buscado', () => {
  it('dia normal usa as estatísticas próprias', async () => {
    await montar();
    expect(api.get).toHaveBeenCalledWith('/tournament-days/d1/stats');
  });

  it('dia FINAL usa as estatísticas AGREGADAS', async () => {
    // Ninguém compra entrada no dia final; o endpoint próprio o mostraria
    // "sem jogadores".
    await montar({ dia: { ...DIA, day_type: 'final' }, stats: AGREGADAS });
    expect(api.get).toHaveBeenCalledWith('/tournament-days/d1/aggregated-stats');
    expect(api.get).not.toHaveBeenCalledWith('/tournament-days/d1/stats');
  });

  it('o dia é carregado ANTES: dele saem o torneio e a escolha do endpoint', async () => {
    await montar();
    expect(api.get.mock.calls[0][0]).toBe('/tournament-days/d1');
  });
});

describe('dia normal', () => {
  it('mostra jogadores, entradas e o bolo do dia', async () => {
    await montar();
    const conteudo = document.querySelector('.main-content');
    expect(conteudo).toHaveTextContent('80');
    expect(conteudo).toHaveTextContent('120');
    expect(conteudo).toHaveTextContent('R$ 90000.00');
  });

  it('o tipo do dia é sinalizado', async () => {
    await montar();
    expect(document.querySelector('.day-type-badge.regular')).toBeInTheDocument();
  });

  it('dia classificatório tem selo próprio', async () => {
    await montar({ dia: { ...DIA, day_type: 'qualifying' } });
    expect(document.querySelector('.day-type-badge.qualifying')).toBeInTheDocument();
  });

  it('o status do dia aparece junto', async () => {
    await montar();
    expect(document.querySelector('.status-badge.active')).toBeInTheDocument();
  });
});

describe('dia final', () => {
  it('mostra os totais COMBINADOS dos classificatórios', async () => {
    // É o número que interessa: o bolo do torneio inteiro, não do dia.
    await montar({ dia: { ...DIA, day_type: 'final' }, stats: AGREGADAS });
    const conteudo = document.querySelector('.main-content');
    expect(conteudo).toHaveTextContent('R$ 250000.00');
    expect(conteudo).toHaveTextContent('R$ 300000.00');
  });

  it('detalha cada classificatório que alimentou a final', async () => {
    await montar({ dia: { ...DIA, day_type: 'final' }, stats: AGREGADAS });
    expect(screen.getByText('Classificatório 1')).toBeInTheDocument();
    expect(screen.getByText(/qualifyingDaysCount:1/)).toBeInTheDocument();
  });

  it('valores ausentes de um classificatório viram zero, não vazio', async () => {
    await montar({
      dia: { ...DIA, day_type: 'final' },
      stats: { ...AGREGADAS, qualifying_days: [{ day_id: 'q1', day_name: 'Sem dados' }] },
    });
    expect(screen.getByText('Sem dados')).toBeInTheDocument();
    expect(document.querySelectorAll('.stat-box-value').length).toBeGreaterThan(0);
  });
});

describe('erro e navegação', () => {
  it('falha ao carregar mostra o erro com caminho de saída', async () => {
    await montar({ dia: new Error('500') });
    expect(screen.getByText('dayStats.loadError')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common.back' })).toBeInTheDocument();
  });

  it('voltar leva ao torneio quando ele foi carregado', async () => {
    await montar();
    await userEvent.click(screen.getByRole('button', { name: 'common.back' }));
    expect(mockNavigate).toHaveBeenCalledWith('/torneios/t1');
  });

  it('sem torneio carregado, voltar usa o histórico', async () => {
    // É o caso do erro: não há para onde apontar, mas dá para voltar.
    await montar({ dia: new Error('500') });
    await userEvent.click(screen.getByRole('button', { name: 'common.back' }));
    expect(mockNavigate).toHaveBeenCalledWith(-1);
  });
});

describe('vendas por meio de entrada', () => {
  // NSOP (18/10): "tem que adicionar todos os meios de entrada nessa tela para
  // saber os valores individuais" — e a taxa, que deixava os importes sem fechar.
  const COM_MEIOS = {
    ...ESTATISTICAS,
    buy_in_amount: 1500, rebuy_amount: 1500, addon_amount: 0, fee_amount: 200, total_collected: 3200,
    by_buy_type: [
      { name: 'Buy-in', category: 'buy_in', count: 3, amount: 1500 },
      { name: 'Doble', category: 'rebuy', count: 2, amount: 1500 },
      { name: 'Bono Dealer', category: 'fee', count: 4, amount: 200 },
    ],
  };
  const linha = (texto) => Array.from(document.querySelectorAll('.stats-table tr')).find((tr) => tr.textContent.includes(texto));

  it('lista cada meio com quantidade e valor, e o total', async () => {
    await montar({ stats: COM_MEIOS });
    expect(linha('Doble')).toHaveTextContent('2');
    expect(linha('Doble')).toHaveTextContent('R$ 1500.00');
    expect(linha('Bono Dealer')).toHaveTextContent('dayStats.category_fee');
    expect(document.querySelector('.stats-table tfoot')).toHaveTextContent('9');
    expect(document.querySelector('.stats-table tfoot')).toHaveTextContent('R$ 3200.00');
  });

  it('a taxa aparece nos importes', async () => {
    await montar({ stats: COM_MEIOS });
    expect(screen.getByText('dayStats.feeAmount').closest('.stat-box')).toHaveTextContent('R$ 200.00');
  });

  it('sem meios (backend antigo), a tela continua só com as categorias', async () => {
    await montar();
    expect(document.querySelector('.stats-table')).toBeNull();
  });
});
