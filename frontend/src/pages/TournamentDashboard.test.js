/**
 * Painel do torneio — o resultado financeiro consolidado.
 *
 * Duas regras de cálculo dominam a tela:
 *
 * - **Dias FINAIS não entram na receita.** As entradas do final não foram
 *   vendidas: os jogadores vieram dos classificatórios com as fichas que
 *   trouxeram. Contá-las somaria dinheiro que nunca entrou no caixa.
 * - **O rake é uma MÉDIA PONDERADA pela receita de cada dia.** Um torneio com
 *   um dia de 20% que faturou 90 mil e outro de 10% que faturou 10 mil tem
 *   rake efetivo perto de 19%, não de 15% (a média simples). A média simples
 *   erraria a premiação anunciada.
 *
 * O componente é montado de dois jeitos: embutido no detalhe do torneio
 * (recebendo o id por propriedade) ou como rota própria — e só na rota própria
 * ele mostra cabeçalho e botão de voltar.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import TournamentDashboard from './TournamentDashboard';
import api from '../config/api';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../hooks/usePolling', () => ({ usePolling: jest.fn() }));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ id: 't1' }),
  useNavigate: () => mockNavigate,
}));
jest.mock('react-i18next', () => {
  const t = (chave, vars) =>
    vars && typeof vars === 'object' ? `${chave}:${Object.values(vars).join(',')}` : chave;
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const TORNEIO = { id: 't1', name: 'Main Event' };

const DIAS = [
  { id: 'd1', day_name: 'Dia 1A', day_type: 'regular', rake_percentage: 20 },
  { id: 'd2', day_name: 'Dia 1B', day_type: 'regular', rake_percentage: 10 },
  { id: 'f1', day_name: 'Dia Final', day_type: 'final', rake_percentage: 0 },
];

// Dia 1A fatura 90.000 a 20%; Dia 1B fatura 10.000 a 10% → rake efetivo 19%.
const INSCRITOS = [
  { player_id: 'p1', tournament_day_id: 'd1', buy_in_count: 1, rebuy_count: 1, addon_count: 0,
    total_buy_in_amount: 50000, total_rebuy_amount: 40000, total_addon_amount: 0 },
  { player_id: 'p2', tournament_day_id: 'd2', buy_in_count: 1, rebuy_count: 0, addon_count: 1,
    total_buy_in_amount: 8000, total_rebuy_amount: 0, total_addon_amount: 2000 },
  // Este veio do classificatório: não pode somar receita nenhuma.
  { player_id: 'p3', tournament_day_id: 'f1', buy_in_count: 1, rebuy_count: 0, addon_count: 0,
    total_buy_in_amount: 99999, total_rebuy_amount: 0, total_addon_amount: 0 },
];

const responder = ({ torneio = TORNEIO, dias = DIAS, inscritos = INSCRITOS, transacoes = [] } = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/tournaments/t1') {
      return torneio instanceof Error ? Promise.reject(torneio) : Promise.resolve({ data: torneio });
    }
    if (url === '/tournament-days/tournament/t1') return Promise.resolve({ data: dias });
    if (url === '/tournament-players/tournament/t1') return Promise.resolve({ data: inscritos });
    if (url === '/transactions/tournament/t1') {
      return transacoes instanceof Error ? Promise.reject(transacoes) : Promise.resolve({ data: transacoes });
    }
    return Promise.resolve({ data: [] });
  });
};

const montar = async (opcoes, { embutido = true } = {}) => {
  responder(opcoes);
  render(
    <MemoryRouter>
      <TournamentDashboard {...(embutido ? { tournamentId: 't1' } : {})} />
    </MemoryRouter>
  );
  await waitFor(() => expect(screen.queryByText('common.loading')).toBeNull());
};

const linhaFinanceira = (rotulo) =>
  Array.from(document.querySelectorAll('.financial-row')).find((el) =>
    el.textContent.includes(rotulo)
  );

beforeEach(() => {
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('receita', () => {
  it('soma só os dias que VENDERAM entrada', async () => {
    // O jogador do dia final trouxe as fichas do classificatório; contar a
    // entrada dele somaria dinheiro que nunca entrou no caixa.
    await montar();
    expect(linhaFinanceira('totalRevenue')).toHaveTextContent('R$ 100000.00');
  });

  it('valores ausentes não viram NaN', async () => {
    await montar({
      inscritos: [{ player_id: 'p1', tournament_day_id: 'd1' }],
    });
    expect(linhaFinanceira('totalRevenue')).toHaveTextContent('R$ 0.00');
  });

  it('sem inscrito nenhum a receita é zero', async () => {
    await montar({ inscritos: [] });
    expect(linhaFinanceira('totalRevenue')).toHaveTextContent('R$ 0.00');
  });
});

describe('rake ponderado', () => {
  it('o rake é a média PONDERADA pela receita de cada dia', async () => {
    // 90k a 20% + 10k a 10% = 19% efetivo. A média simples (15%) erraria a
    // premiação anunciada.
    await montar();
    expect(linhaFinanceira('adminFee')).toHaveTextContent('adminFee:19.0');
    expect(linhaFinanceira('adminFee')).toHaveTextContent('R$ 19000.00');
  });

  it('o bolo de prêmios é a receita menos o rake', async () => {
    await montar();
    expect(linhaFinanceira('tournamentBank')).toHaveTextContent('R$ 81000.00');
  });

  it('sem receita, o rake não vira divisão por zero', async () => {
    await montar({ inscritos: [] });
    expect(linhaFinanceira('adminFee')).toHaveTextContent('adminFee:0.0');
  });

  it('o dia final não influencia o rake médio', async () => {
    // Ele tem rake 0 e receita 0; entrar na conta puxaria a média para baixo.
    await montar();
    expect(linhaFinanceira('adminFee')).toHaveTextContent('19.0');
  });
});

describe('montagem embutida × rota própria', () => {
  it('embutido, não mostra cabeçalho nem botão de voltar', async () => {
    // Ele vive dentro do detalhe do torneio, que já tem os dois.
    await montar();
    expect(screen.queryByRole('button', { name: 'common.back' })).toBeNull();
  });

  it('na rota própria, mostra o cabeçalho e o voltar', async () => {
    await montar(undefined, { embutido: false });
    expect(screen.getByRole('button', { name: 'common.back' })).toBeInTheDocument();
  });

  it('torneio inexistente avisa, e na rota própria oferece voltar', async () => {
    await montar({ torneio: new Error('404') }, { embutido: false });
    expect(screen.getByText('tournamentDashboard.tournamentNotFound')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'common.back' }));
    expect(mockNavigate).toHaveBeenCalledWith('/torneios');
  });

  it('sem dia configurado explica em vez de mostrar zeros', async () => {
    // Zeros dariam a impressão de que o torneio faturou nada; o problema é
    // que ele nem foi montado.
    await montar({ dias: [] });
    expect(screen.getByText('tournamentDashboard.noDaysConfigured')).toBeInTheDocument();
  });
});

describe('contagem de itens', () => {
  it('o título conta os dias que vendem entrada, no plural certo', async () => {
    await montar();
    expect(screen.getByText(/tournamentItems:2/)).toBeInTheDocument();
  });

  it('com um dia só, usa o singular', async () => {
    await montar({ dias: [DIAS[0]] });
    expect(screen.getByText(/tournamentItems:1,tournamentDashboard.day/)).toBeInTheDocument();
  });
});

describe('itens por meio de entrada', () => {
  // O clube quer ver "Entrada normal", "Addon" e "Bonus Dealer" cada um com
  // a sua quantidade — não três linhas fixas por categoria.
  const INSCRITOS_COM_ID = [
    { id: 'tp1', player_id: 'p1', tournament_day_id: 'd1', buy_in_count: 1, total_buy_in_amount: 200 },
    { id: 'tp9', player_id: 'p9', tournament_day_id: 'f1', buy_in_count: 1, total_buy_in_amount: 999 },
  ];
  let seq = 0;
  const venda = (extra) => ({
    id: `v${seq += 1}`, tournament_id: 't1', player_id: 'p1', tournament_player_id: 'tp1',
    status: 'active', amount: 200, created_at: '2026-06-08T20:00:00Z', ...extra,
  });
  const VENDAS = [
    venda({ type: 'buy_in', buy_type_id: 'b1', buy_type_name: 'Entrada normal' }),
    venda({ type: 'buy_in', buy_type_id: 'b1', buy_type_name: 'Entrada normal' }),
    venda({ type: 'addon', buy_type_id: 'b3', buy_type_name: 'Addon' }),
    venda({ type: 'addon', buy_type_id: 'b3', buy_type_name: 'Addon' }),
    venda({ type: 'addon', buy_type_id: 'b3', buy_type_name: 'Addon' }),
    venda({ type: 'addon', buy_type_id: 'b5', buy_type_name: 'Bonus Dealer', amount: 20 }),
    // Cancelada: saiu do caixa, não conta.
    venda({ type: 'addon', buy_type_id: 'b3', buy_type_name: 'Addon', status: 'cancelled' }),
    // Venda antiga, sem meio de entrada: entra pelo rótulo da categoria.
    venda({ type: 'rebuy', buy_type_id: null, buy_type_name: null, amount: 100 }),
    // Prêmio pago não é item vendido.
    venda({ type: 'prize', amount: 5000 }),
    // Entrada do dia FINAL: o jogador veio classificado, não comprou.
    venda({ type: 'buy_in', buy_type_id: 'b1', buy_type_name: 'Entrada normal', tournament_player_id: 'tp9', player_id: 'p9', amount: 999 }),
  ];
  const celulas = (nome) => Array.from(screen.getByText(nome).closest('tr').querySelectorAll('td')).map((td) => td.textContent);

  it('lista cada meio com o nome gravado na venda, a quantidade e o valor', async () => {
    await montar({ inscritos: INSCRITOS_COM_ID, transacoes: VENDAS });
    expect(celulas('Entrada normal').slice(0, 3)).toEqual(['Entrada normal', '2', 'R$ 400.00']);
    expect(celulas('Addon').slice(0, 3)).toEqual(['Addon', '3', 'R$ 600.00']);
    expect(celulas('Bonus Dealer').slice(0, 3)).toEqual(['Bonus Dealer', '1', 'R$ 20.00']);
    expect(celulas('tournamentDashboard.rebuy').slice(0, 3)).toEqual(['tournamentDashboard.rebuy', '1', 'R$ 100.00']);
    // Sem prêmio, sem cancelada, sem o dia final: 4 linhas.
    expect(screen.getAllByTestId('linha-item')).toHaveLength(4);
  });

  it('ordena por categoria (entrada, recompra, add-on) e depois pelo nome', async () => {
    await montar({ inscritos: INSCRITOS_COM_ID, transacoes: VENDAS });
    const nomes = screen.getAllByTestId('linha-item').map((tr) => tr.querySelector('td').textContent);
    expect(nomes).toEqual(['Entrada normal', 'tournamentDashboard.rebuy', 'Addon', 'Bonus Dealer']);
  });

  it('sem vendas carregadas, cai nas categorias dos inscritos, como antes', async () => {
    await montar();
    const nomes = screen.getAllByTestId('linha-item').map((tr) => tr.querySelector('td').textContent);
    expect(nomes).toEqual(['tournamentDashboard.tournamentBuyIn', 'tournamentDashboard.rebuy', 'tournamentDashboard.addon']);
  });

  it('falha ao carregar as vendas não derruba a tabela', async () => {
    await montar({ transacoes: new Error('500') });
    expect(screen.getByText('tournamentDashboard.tournamentBuyIn')).toBeInTheDocument();
  });
});

describe('premiação por eliminação (KO)', () => {
  it('torneio KO mostra a divisão do pool entre KO e posições', async () => {
    responder({ torneio: { id: 't1', name: 'PKO', ko_format: 'pko', ko_percentage: 40 } });
    const base = api.get.getMockImplementation();
    api.get.mockImplementation((url, ...resto) => (
      url === '/tournaments/t1/prizes/summary'
        ? Promise.resolve({ data: { ko_pool: '4000', player_pool: '6000', ko_percentage: '40' } })
        : base(url, ...resto)
    ));
    render(<MemoryRouter><TournamentDashboard tournamentId="t1" /></MemoryRouter>);
    await waitFor(() => expect(linhaFinanceira('tournamentDashboard.koPool')).toBeTruthy());
    expect(linhaFinanceira('tournamentDashboard.koPool')).toHaveTextContent('R$ 4000.00');
    expect(linhaFinanceira('tournamentDashboard.positionsPool')).toHaveTextContent('R$ 6000.00');
  });

  it('sem KO não busca a divisão', async () => {
    await montar();
    expect(api.get).not.toHaveBeenCalledWith('/tournaments/t1/prizes/summary', expect.anything());
    expect(linhaFinanceira('tournamentDashboard.koPool')).toBeUndefined();
  });
});

describe('taxa nos itens vendidos', () => {
  it('a venda de taxa aparece pelo nome, depois dos add-ons', async () => {
    const inscritos = [{ id: 'tp1', player_id: 'p1', tournament_day_id: 'd1', buy_in_count: 1, total_buy_in_amount: 200 }];
    const base = { tournament_id: 't1', player_id: 'p1', tournament_player_id: 'tp1', status: 'active', created_at: '2026-06-08T20:00:00Z' };
    const transacoes = [
      { ...base, id: 'v1', type: 'buy_in', amount: 200, buy_type_id: 'b1', buy_type_name: 'Entrada' },
      { ...base, id: 'v2', type: 'addon', amount: 50, buy_type_id: 'b9', buy_type_name: 'Bono Dealer', is_fee: true },
      { ...base, id: 'v3', type: 'addon', amount: 100, buy_type_id: 'b3', buy_type_name: 'Zeta add-on' },
      // Taxa antiga sem meio cadastrado: cai no rótulo da categoria Taxa.
      { ...base, id: 'v4', type: 'addon', amount: 50, buy_type_id: null, buy_type_name: null, is_fee: true },
    ];
    await montar({ inscritos, transacoes });
    const nomes = screen.getAllByTestId('linha-item').map((tr) => tr.querySelector('td').textContent);
    expect(nomes).toEqual(['Entrada', 'Zeta add-on', 'Bono Dealer', 'tournamentDashboard.feeCategory']);
  });

  it('sem vendas carregadas, a taxa vem dos contadores do jogador', async () => {
    const inscritos = [{ id: 'tp1', player_id: 'p1', tournament_day_id: 'd1', buy_in_count: 1, total_buy_in_amount: 200, fee_count: 2, total_fee_amount: 100 }];
    await montar({ inscritos });
    const linhaTaxa = screen.getByText('tournamentDashboard.feeCategory').closest('tr');
    expect(Array.from(linhaTaxa.querySelectorAll('td')).map((td) => td.textContent).slice(0, 3))
      .toEqual(['tournamentDashboard.feeCategory', '2', 'R$ 100.00']);
  });
});
