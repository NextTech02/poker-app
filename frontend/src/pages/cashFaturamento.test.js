/**
 * FATURAMENTO e JACKPOT do cash game, nas telas.
 *
 * Estas duas telas existem para impedir uma leitura errada específica, e é ela
 * que os testes travam:
 *
 * 1. **Faturamento é o RAKE.** O giro de buy-ins aparece — é a movimentação da
 *    noite —, mas sempre rotulado como movimentação. Chamar o giro de receita
 *    faria o dono achar que fatura cinco vezes mais do que fatura, e contratar
 *    gente em cima disso.
 * 2. **Melhores dias ordena pelo que o clube FICOU.** Por giro responderia
 *    "qual noite movimentou mais", que é outra pergunta.
 * 3. **Dia da semana é MÉDIA.** O total premiaria a sexta simplesmente por
 *    haver mais sextas no período.
 * 4. **O jackpot é PASSIVO** — dinheiro dos jogadores. Não é verde (verde é
 *    receita nesta aplicação) e sai numa linha própria.
 * 5. **Pagar jackpot SAI DA GAVETA**, e a tela precisa dizer isso: senão o
 *    operador trata como registro e não confere o dinheiro que entrega.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CashRelatorios from './CashRelatorios';
import CashJackpot from './CashJackpot';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useCashDay } from '../contexts/CashDayContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <div data-testid="sidebar" />);
jest.mock('../components/PlayerSelect', () => ({ value, onChange }) => (
  <input
    aria-label="Jogador"
    value={value || ''}
    onChange={(e) => onChange({ target: { name: 'player_id', value: e.target.value } })}
  />
));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('../contexts/CashDayContext', () => ({ useCashDay: jest.fn() }));
const mockExportar = jest.fn();
jest.mock('../utils/reportExport', () => ({ exportSections: (...a) => mockExportar(...a) }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (chave, padrao, vars) => {
      if (typeof padrao !== 'string') return chave;
      return padrao.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars ? vars[k] : ''));
    },
  }),
}));

// Quinta 130 de rake com 600 de giro; sexta 400 com 2000.
const DIARIO = [
  { cash_day_id: 'd2', business_date: '2026-09-11', status: 'closed',
    revenue: 400, jackpot: 80, buy_ins: 2000, cash_outs: 1520,
    tables_count: 2, players_count: 14 },
  { cash_day_id: 'd1', business_date: '2026-09-10', status: 'closed',
    revenue: 130, jackpot: 26, buy_ins: 600, cash_outs: 470,
    tables_count: 1, players_count: 5 },
];

const SEMANA = [
  { weekday: 0, weekday_key: 'mon', days: 0, total_revenue: 0, avg_revenue: 0, avg_players: 0 },
  { weekday: 3, weekday_key: 'thu', days: 1, total_revenue: 130, avg_revenue: 130, avg_players: 5 },
  { weekday: 4, weekday_key: 'fri', days: 1, total_revenue: 400, avg_revenue: 400, avg_players: 14 },
];

const MESAS = [
  { table_id: 'm2', cash_day_id: 'd2', table_number: 1, game_type_name: 'NLH 1/2',
    revenue: 400, jackpot: 80, buy_ins: 2000, players_count: 9, hours: 4 },
];

const JOGADORES = [
  { player_id: 'p1', player_name: 'Ana', sessions: 2, days: 2,
    buy_ins: 2600, cash_outs: 1990, result: -610, hours: 3 },
];

beforeEach(() => {
  jest.clearAllMocks();
  useToast.mockReturnValue({ toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn() } });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  useCashDay.mockReturnValue({ cashDayId: 'd2', isOpen: true });
  api.post.mockResolvedValue({ data: {} });
});

// ══════════════════════════════════════════════════════════════════════
describe('faturamento', () => {
  const montar = ({ diario = DIARIO, semana = SEMANA, mesas = MESAS, jogadores = JOGADORES } = {}) => {
    api.get.mockImplementation((url) => {
      if (url.includes('/daily')) return Promise.resolve({ data: diario });
      if (url.includes('/weekday')) return Promise.resolve({ data: semana });
      if (url.includes('/tables')) return Promise.resolve({ data: mesas });
      if (url.includes('/players')) return Promise.resolve({ data: jogadores });
      return Promise.resolve({ data: [] });
    });
    return render(<CashRelatorios />);
  };

  it('o total do período é a soma dos rakes', async () => {
    montar();
    expect(await screen.findByText('R$ 530.00')).toBeInTheDocument();
  });

  it('o giro aparece separado e rotulado como movimentação', async () => {
    // 2600 passaram pela gaveta. Se isso ocupasse a linha de faturamento, o
    // dono acharia que fatura cinco vezes mais do que fatura.
    montar();
    await screen.findByText('R$ 530.00');
    // Os mesmos rótulos aparecem nos indicadores e nos cabeçalhos da tabela;
    // o que se verifica aqui são os INDICADORES, que é onde a leitura errada
    // aconteceria. O que importa: o giro nunca fica sob o rótulo de
    // faturamento.
    const indicadores = within(document.querySelector('.stats-grid'));
    const giro = indicadores.getByText('Giro (buy-ins)').closest('.stat-card');
    expect(within(giro).getByText('R$ 2600.00')).toBeInTheDocument();
    expect(within(giro).getByText('Movimentação, não receita')).toBeInTheDocument();

    const faturamento = indicadores.getByText('Faturamento (rake)').closest('.stat-card');
    expect(within(faturamento).getByText('R$ 530.00')).toBeInTheDocument();
    expect(within(faturamento).queryByText('R$ 2600.00')).toBeNull();
  });

  it('o jackpot é marcado como não sendo receita', async () => {
    montar();
    await screen.findByText('R$ 530.00');
    expect(screen.getByText('R$ 106.00')).toBeInTheDocument();
    expect(screen.getByText('Não é receita')).toBeInTheDocument();
  });

  it('mostra a média por dia', async () => {
    montar();
    expect(await screen.findByText('Média de R$ 265.00 por dia')).toBeInTheDocument();
  });

  it('melhores dias ordena pelo que o clube ficou', async () => {
    montar();
    await screen.findByText('Melhores dias');
    const itens = screen.getAllByRole('listitem');
    // A sexta (400) vem antes da quinta (130), mesmo com giros muito diferentes.
    expect(itens[0]).toHaveTextContent('2026-09-11');
    expect(itens[1]).toHaveTextContent('2026-09-10');
    expect(screen.getByText(/Ordenado pelo que o clube ficou/)).toBeInTheDocument();
  });

  it('o dia da semana é média, e o dia sem operação continua na grade', async () => {
    // O clube precisa VER que a segunda está vazia para decidir se vale abrir.
    montar();
    await screen.findByText('Por dia da semana');
    expect(screen.getByText(/Média por dia operado/)).toBeInTheDocument();
    expect(screen.getByText('sem operação')).toBeInTheDocument();
  });

  it('diz de quem é o resultado do jogador', async () => {
    // Não é despesa do clube: o dinheiro veio dos outros jogadores da mesa.
    montar();
    await screen.findByText('Por jogador');
    expect(screen.getByText(/veio dos outros da mesa, não do caixa/)).toBeInTheDocument();
    // Negativo: a Ana perdeu. Não é despesa do clube.
    expect(screen.getByText('R$ -610.00')).toHaveClass('cr-loss');
  });

  it('período vazio não é erro', async () => {
    montar({ diario: [] });
    expect(await screen.findByText('Nenhuma operação no período')).toBeInTheDocument();
  });

  it('sem dados não deixa exportar', async () => {
    montar({ diario: [] });
    await screen.findByText('Nenhuma operação no período');
    screen.getAllByRole('button', { name: /XLSX|CSV|PDF/ })
      .forEach((b) => expect(b).toBeDisabled());
  });

  it('exporta separando faturamento de giro nas colunas', async () => {
    montar();
    await screen.findByText('R$ 530.00');
    await userEvent.click(screen.getByRole('button', { name: 'CSV' }));

    await waitFor(() => expect(mockExportar).toHaveBeenCalled());
    const [secoes, opcoes] = mockExportar.mock.calls[0];
    expect(opcoes.format).toBe('csv');
    const porDia = secoes.find((s) => s.title === 'Faturamento por dia');
    const rotulos = porDia.columns.map((c) => c.label);
    expect(rotulos).toContain('Faturamento (rake)');
    expect(rotulos).toContain('Giro (buy-ins)');
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('jackpot', () => {
  const FUNDO = { current_balance: 500, total_collected: 800, total_paid: 300 };

  const montar = ({ fundo = FUNDO, pagamentos = [], dia = true } = {}) => {
    useCashDay.mockReturnValue({ cashDayId: dia ? 'd2' : null, isOpen: dia });
    api.get.mockImplementation((url) => {
      if (url.includes('/payouts')) return Promise.resolve({ data: pagamentos });
      return Promise.resolve({ data: fundo });
    });
    return render(<CashJackpot />);
  };

  it('mostra o acumulado marcado como passivo', async () => {
    // A legenda é a razão de a tela existir: sem ela, o número parece receita.
    montar();
    expect(await screen.findByText('R$ 500.00')).toBeInTheDocument();
    expect(screen.getByText('Passivo — dinheiro dos jogadores')).toBeInTheDocument();
  });

  it('diz no subtítulo que não entra no faturamento', async () => {
    montar();
    expect(await screen.findByText(/não entra no faturamento do clube/)).toBeInTheDocument();
  });

  it('sem dia aberto não dá para pagar', async () => {
    montar({ dia: false });
    await screen.findByText('R$ 500.00');
    expect(screen.getByRole('button', { name: 'Pagar jackpot' })).toBeDisabled();
  });

  it('fundo zerado não dá para pagar', async () => {
    montar({ fundo: { current_balance: 0, total_collected: 0, total_paid: 0 } });
    await screen.findByText('Nenhum jackpot pago ainda');
    expect(screen.getByRole('button', { name: 'Pagar jackpot' })).toBeDisabled();
  });

  it('o modal avisa que o dinheiro sai do caixa', async () => {
    // Sem isso o operador trata como registro e não confere o que entrega.
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Pagar jackpot' }));
    expect(screen.getByText(/SAI do caixa/)).toBeInTheDocument();
    expect(screen.getByText(/Disponível no fundo: R\$ 500\.00/)).toBeInTheDocument();
  });

  it('paga o jackpot com jogador, valor e tipo', async () => {
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Pagar jackpot' }));
    await userEvent.type(screen.getByLabelText('Jogador'), 'p1');
    await userEvent.type(screen.getByLabelText('Valor'), '300');
    const dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Pagar jackpot' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/cash-game/jackpot/payouts',
      expect.objectContaining({
        cash_day_id: 'd2', player_id: 'p1', amount: 300, kind: 'bad_beat',
      }),
    ));
  });

  it('sem jogador escolhido não envia', async () => {
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Pagar jackpot' }));
    const dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Pagar jackpot' }));
    expect(api.post).not.toHaveBeenCalled();
  });

  it('lista os pagamentos já feitos', async () => {
    montar({ pagamentos: [{
      id: 'jp1', player_name: 'Ana', kind: 'bad_beat', amount: 300,
      description: 'Quadra vs straight flush', paid_at: '2026-09-11T23:00:00Z',
    }] });
    expect(await screen.findByText('Ana')).toBeInTheDocument();
    expect(screen.getByText('Quadra vs straight flush')).toBeInTheDocument();
    expect(screen.getByText('2026-09-11')).toBeInTheDocument();
  });
});
