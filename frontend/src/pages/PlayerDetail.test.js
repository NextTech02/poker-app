/**
 * Histórico do jogador — o perfil que o clube usa para conversar com ele.
 *
 * A tela junta estatística e fidelidade, e as duas têm um cuidado em comum:
 * **um dado que não existe não pode virar zero**. "Melhor posição: 0º" ou
 * "ROI: 0%" para quem nunca jogou são afirmações falsas — o travessão diz a
 * verdade (não há dado ainda).
 *
 * A fidelidade é opcional (só nos planos Pro/Premium): quando desligada, o
 * cartão inteiro some, e as consultas que falham não podem derrubar o resto
 * do perfil — o histórico continua sendo o principal.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import PlayerDetail from './PlayerDetail';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../components/PlayerStatsCharts', () => () => <div data-testid="graficos" />);
jest.mock('../components/PlayerLoyaltyCard', () => ({
  data, onRedeem, onConvertCashback, onRedeemCoupon, onClaimGoal, onGiftCredit,
}) => (
  <div data-testid="fidelidade">
    <span data-testid="pontos">{data?.points}</span>
    <button onClick={() => onRedeem('r1')}>resgatar</button>
    <button onClick={() => onConvertCashback()}>converter</button>
    <button onClick={() => onRedeemCoupon('CUPOM10')}>cupom</button>
    <button onClick={() => onClaimGoal('g1')}>meta</button>
    <button onClick={() => onGiftCredit({ id: 'cr1', original_amount: 100 })}>presentear</button>
  </div>
));
jest.mock('../components/PlayerSelect', () => ({ value, onChange }) => (
  <select
    aria-label="destinatario"
    value={value}
    onChange={(e) => onChange({ target: { name: 'player_id', value: e.target.value } })}
  >
    <option value="">—</option>
    <option value="p2">Beto</option>
  </select>
));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
const mockNavigate = jest.fn();
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useParams: () => ({ id: 'p1' }),
  useNavigate: () => mockNavigate,
}));
jest.mock('react-i18next', () => {
  const t = (chave, segundo, terceiro) => {
    const vars = segundo && typeof segundo === 'object' ? segundo : terceiro;
    if (vars) return `${chave}:${Object.values(vars).join(',')}`;
    return typeof segundo === 'string' ? segundo : chave;
  };
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const JOGADOR = { id: 'p1', name: 'Ana Costa', nickname: 'Aninha', nationality: 'Brasil' };

const ESTATISTICAS = {
  tournaments_played: 12, entries: 20, days_played: 15, hours_played: 42.5,
  final_tables: 4, top_3_finishes: 2, itm_count: 6, total_rebuys: 9, total_addons: 3,
  win_rate: 0.1, itm_rate: 0.3, rebuy_rate: 0.45, best_position: 1, avg_position: 12.4,
  roi: 0.25, total_spent: 8000, total_prizes: 10000, net_profit: 2000,
  first_played: '2026-01-10T00:00:00Z',
};

const HISTORICO = [
  { id: 'h1', tournament_name: 'Main Event', day_name: 'Dia 1A',
    registered_at: '2026-06-01T00:00:00Z', rebuy_count: 2, addon_count: 1,
    total_spent: 1500, final_position: 3, prize_won: 5000 },
  { id: 'h2', registered_at: '2026-05-01T00:00:00Z', rebuy_count: 0, addon_count: 0,
    total_spent: 500, final_position: null, prize_won: 0 },
];

const FIDELIDADE = { points: 1250, tier: 'gold' };

const TICKETS = [
  { id: 'tk1', target_tournament_name: 'Main Event', target_day_name: 'Dia Final',
    ticket_value: 1000, status: 'awarded', won_at: 'Satélite de quarta',
    funded_by: 'Clube', created_at: '2026-06-01T00:00:00Z' },
  { id: 'tk2', target_tournament_name: 'Turbo', target_day_name: null,
    ticket_value: 500, status: 'redeemed', won_at: null, funded_by: null,
    created_at: '2026-05-20T00:00:00Z' },
];

let toast;

const responder = ({
  jogador = JOGADOR, estatisticas = [ESTATISTICAS], historico = HISTORICO,
  tickets = TICKETS, configFidelidade = { enabled: true }, fidelidade = FIDELIDADE,
} = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/players/p1') {
      return jogador instanceof Error ? Promise.reject(jogador) : Promise.resolve({ data: jogador });
    }
    if (url === '/players/statistics') return Promise.resolve({ data: estatisticas });
    if (url === '/players/p1/history') return Promise.resolve({ data: historico });
    if (url === '/players/p1/tickets') {
      return tickets instanceof Error ? Promise.reject(tickets) : Promise.resolve({ data: tickets });
    }
    if (url === '/loyalty/config') {
      return configFidelidade instanceof Error
        ? Promise.reject(configFidelidade)
        : Promise.resolve({ data: configFidelidade });
    }
    if (url === '/loyalty/players/p1') {
      return fidelidade instanceof Error
        ? Promise.reject(fidelidade)
        : Promise.resolve({ data: fidelidade });
    }
    return Promise.resolve({ data: [] });
  });
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<MemoryRouter><PlayerDetail /></MemoryRouter>);
  await waitFor(() => expect(document.querySelector('.skeleton-row')).toBeNull());
};

const metrica = (rotulo) =>
  Array.from(document.querySelectorAll('.pd-metric')).find((el) =>
    el.textContent.includes(rotulo)
  );

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  useToast.mockReturnValue({ toast });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  api.post.mockResolvedValue({ data: {} });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('identificação', () => {
  it('mostra nome, apelido e nacionalidade', async () => {
    // O nome também aparece na trilha de navegação; o cabeçalho é o alvo.
    await montar();
    expect(document.querySelector('.pd-name')).toHaveTextContent('Ana Costa');
    expect(screen.getByText('@Aninha')).toBeInTheDocument();
    expect(screen.getByText('Brasil')).toBeInTheDocument();
  });

  it('jogador sem apelido não mostra arroba solta', async () => {
    await montar({ jogador: { id: 'p1', name: 'Sem Apelido' } });
    expect(screen.queryByText('@')).toBeNull();
  });

  it('jogador inexistente oferece o caminho de volta', async () => {
    await montar({ jogador: new Error('404') });
    expect(screen.getByText('Jogador não encontrado')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(mockNavigate).toHaveBeenCalledWith('/jogadores');
  });

  it('falha ao carregar avisa', async () => {
    await montar({ jogador: new Error('500') });
    expect(toast.error).toHaveBeenCalledWith('Erro ao carregar o histórico do jogador');
  });
});

describe('números do jogador', () => {
  it('mostra torneios, participações e mesas finais', async () => {
    await montar();
    expect(metrica('Torneios')).toHaveTextContent('12');
    expect(metrica('Participações')).toHaveTextContent('20');
    expect(metrica('Mesas finais')).toHaveTextContent('4');
  });

  it('horas jogadas viram horas e minutos', async () => {
    // "42.5" não é uma quantidade de tempo que alguém lê de relance.
    await montar();
    expect(metrica('Horas jogadas')).toHaveTextContent('42h 30');
  });

  it('taxas são mostradas em percentual', async () => {
    await montar();
    expect(document.querySelector('.pd-grid')).toBeInTheDocument();
    expect(screen.getByText('10%')).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
  });

  it('mostra investido, prêmios e lucro', async () => {
    await montar();
    const financeiro = document.querySelector('.pd-finance');
    expect(financeiro).toHaveTextContent('R$ 8000.00');
    expect(financeiro).toHaveTextContent('R$ 10000.00');
    expect(financeiro).toHaveTextContent('R$ 2000.00');
  });

  it('prejuízo é marcado como negativo', async () => {
    // Verde num prejuízo daria a leitura oposta da realidade.
    await montar({ estatisticas: [{ ...ESTATISTICAS, net_profit: -3000 }] });
    const lucro = document.querySelectorAll('.pd-finance-value')[2];
    expect(lucro).toHaveClass('pd-negative');
  });

  it('lucro zero conta como positivo, não prejuízo', async () => {
    await montar({ estatisticas: [{ ...ESTATISTICAS, net_profit: 0 }] });
    expect(document.querySelectorAll('.pd-finance-value')[2]).toHaveClass('pd-positive');
  });

  it('jogador SEM estatística: posição vira travessão, não zero', async () => {
    // "Melhor posição: 0º" para quem nunca jogou é uma afirmação falsa.
    await montar({ estatisticas: [] });
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
    expect(metrica('Torneios')).toHaveTextContent('0');
  });
});

describe('histórico de participações', () => {
  // A tela tem DOIS cartões com a mesma estrutura (tickets e participações);
  // sem recortar, os seletores caem no primeiro que aparece.
  const cartao = () => document.querySelector('.pd-history-card:not(.pd-tickets-card)');

  it('lista cada participação com valores e posição', async () => {
    await montar();
    const linha = Array.from(cartao().querySelectorAll('.pd-table tbody tr'))
      .find((tr) => tr.textContent.includes('Main Event'));
    expect(linha).toHaveTextContent('Dia 1A');
    expect(linha).toHaveTextContent('R$ 1500.00');
    expect(linha).toHaveTextContent('R$ 5000.00');
  });

  it('participação sem torneio identificado mostra travessão', async () => {
    await montar();
    expect(cartao().querySelector('.pd-table')).toHaveTextContent('—');
  });

  it('a contagem de participações aparece no cabeçalho', async () => {
    await montar();
    expect(cartao().querySelector('.pd-history-count')).toHaveTextContent('2');
  });

  it('sem participação nenhuma explica isso', async () => {
    await montar({ historico: [] });
    expect(screen.getByText('Nenhuma participação registrada.')).toBeInTheDocument();
  });

  it('os gráficos recebem o histórico', async () => {
    await montar();
    expect(screen.getByTestId('graficos')).toBeInTheDocument();
  });
});

describe('tickets do jogador', () => {
  const cartao = () => document.querySelector('.pd-tickets-card');
  const linha = (texto) =>
    Array.from(cartao().querySelectorAll('tbody tr')).find((tr) => tr.textContent.includes(texto));

  it('lista os tickets com destino, valor e origem', async () => {
    await montar();
    expect(linha('Main Event')).toHaveTextContent('Dia Final');
    expect(linha('Main Event')).toHaveTextContent('R$ 1000.00');
    expect(linha('Main Event')).toHaveTextContent('Satélite de quarta');
  });

  it('o contador destaca quantas vagas ainda estão na mão do jogador', async () => {
    // É a pergunta do balcão: "esse jogador tem vaga para hoje?".
    await montar();
    expect(within(cartao()).getByText(/^1 /)).toBeInTheDocument();
  });

  it('ticket já resgatado aparece marcado como tal', async () => {
    await montar();
    expect(within(linha('Turbo')).getByText('Resgatado')).toBeInTheDocument();
  });

  it('ticket do esquema antigo ("available") conta como disponível', async () => {
    // Tickets criados antes da renomeação ficaram como "available"; contá-los
    // como indisponíveis diria ao operador que o jogador não tem vaga.
    await montar({ tickets: [{ ...TICKETS[0], status: 'available' }] });
    expect(within(cartao()).getByText('Disponível')).toBeInTheDocument();
  });

  it('campos que o ticket não tem viram travessão, não vazio', async () => {
    await montar();
    expect(within(linha('Turbo')).getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('jogador sem ticket nenhum: mensagem, não um zero solto', async () => {
    await montar({ tickets: [] });
    expect(screen.getByText('Nenhum ticket.')).toBeInTheDocument();
    expect(cartao().querySelector('tbody')).toBeNull();
  });

  it('falha ao buscar os tickets não derruba o perfil', async () => {
    // O endpoint pode ganhar permissão própria; quem só tem 'players' ainda
    // precisa ver o histórico.
    await montar({ tickets: new Error('403') });
    expect(document.querySelector('.pd-name')).toHaveTextContent('Ana Costa');
    expect(screen.getByText('Nenhum ticket.')).toBeInTheDocument();
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe('fidelidade', () => {
  it('desligada, o cartão nem aparece', async () => {
    // A fidelidade é de plano Pro/Premium; mostrá-la desligada venderia algo
    // que o clube não tem.
    await montar({ configFidelidade: { enabled: false } });
    expect(screen.queryByTestId('fidelidade')).toBeNull();
  });

  it('ligada, mostra os pontos do jogador', async () => {
    await montar();
    expect(screen.getByTestId('pontos')).toHaveTextContent('1250');
  });

  it('falha ao consultar a configuração não derruba o perfil', async () => {
    // O histórico é o principal; a fidelidade é acessório.
    await montar({ configFidelidade: new Error('500') });
    expect(document.querySelector('.pd-name')).toHaveTextContent('Ana Costa');
    expect(screen.queryByTestId('fidelidade')).toBeNull();
  });

  it('resgatar recompensa recarrega só a fidelidade', async () => {
    await montar();
    const antes = api.get.mock.calls.length;
    await userEvent.click(screen.getByText('resgatar'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/loyalty/players/p1/redeem', { reward_id: 'r1' })
    );
    expect(toast.success).toHaveBeenCalled();
    expect(api.get.mock.calls.length).toBe(antes + 1);
  });

  it('erro no resgate mostra o motivo do servidor', async () => {
    api.post.mockRejectedValue({ userMessage: 'Pontos insuficientes' });
    await montar();
    await userEvent.click(screen.getByText('resgatar'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Pontos insuficientes'));
  });

  it('converter cashback vira crédito no caixa', async () => {
    await montar();
    await userEvent.click(screen.getByText('converter'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/loyalty/players/p1/convert-cashback')
    );
  });

  it('erro ao converter avisa', async () => {
    api.post.mockRejectedValue(new Error('500'));
    await montar();
    await userEvent.click(screen.getByText('converter'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Não foi possível converter o cashback.')
    );
  });

  it('cupom é aplicado pelo código', async () => {
    await montar();
    await userEvent.click(screen.getByText('cupom'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/loyalty/players/p1/coupon', { code: 'CUPOM10' })
    );
  });

  it('cupom inválido avisa', async () => {
    api.post.mockRejectedValue(new Error('400'));
    await montar();
    await userEvent.click(screen.getByText('cupom'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Cupom inválido.'));
  });

  it('meta concluída credita pontos', async () => {
    await montar();
    await userEvent.click(screen.getByText('meta'));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/loyalty/players/p1/goals/g1/claim')
    );
  });

  it('erro ao resgatar a meta avisa', async () => {
    api.post.mockRejectedValue(new Error('400'));
    await montar();
    await userEvent.click(screen.getByText('meta'));
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('Não foi possível resgatar a meta.')
    );
  });
});

describe('presentear crédito', () => {
  const abrir = async () => userEvent.click(screen.getByText('presentear'));

  it('o presente exige um destinatário', async () => {
    // Presentear sem destino perderia o crédito.
    await montar();
    await abrir();
    expect(screen.getByRole('button', { name: 'Presentear' })).toBeDisabled();
  });

  it('escolhido o destinatário, o crédito é transferido', async () => {
    await montar();
    await abrir();
    await userEvent.selectOptions(screen.getByLabelText('destinatario'), 'p2');
    await userEvent.click(screen.getByRole('button', { name: 'Presentear' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/loyalty/players/p1/gift', {
        credit_id: 'cr1', to_player_id: 'p2',
      })
    );
    expect(toast.success).toHaveBeenCalledWith('Crédito presenteado!');
  });

  it('o valor presenteado aparece na confirmação', async () => {
    // É a última chance de perceber que o crédito é maior do que se pensava.
    await montar();
    await abrir();
    expect(document.querySelector('.pd-gift-hint')).toHaveTextContent('R$ 100.00');
  });

  it('erro ao presentear mostra o motivo', async () => {
    api.post.mockRejectedValue({ userMessage: 'Crédito não transferível' });
    await montar();
    await abrir();
    await userEvent.selectOptions(screen.getByLabelText('destinatario'), 'p2');
    await userEvent.click(screen.getByRole('button', { name: 'Presentear' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Crédito não transferível'));
  });

  it('cancelar fecha sem transferir', async () => {
    await montar();
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(document.querySelector('.pd-gift-modal')).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });
});
