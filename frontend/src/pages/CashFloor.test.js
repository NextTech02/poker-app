/**
 * O SALÃO de cash game — a tela que fica aberta a noite inteira.
 *
 * O que estes testes travam, e que uma refatoração distraída desfaz:
 *
 * 1. **Faturamento é o RAKE, não os buy-ins.** Buy-in é troca de dinheiro por
 *    ficha e a maior parte volta ao jogador no cash-out. Rotular o giro como
 *    receita faria o clube achar que fatura dez vezes mais do que fatura — e
 *    tomar decisões (contratar, abrir mesa nova) em cima disso.
 * 2. **Jackpot não é receita.** É dinheiro dos jogadores retido para pagamento
 *    futuro. Somá-lo ao faturamento seria contabilizar como lucro algo que o
 *    clube vai devolver.
 * 3. **Sem dia aberto não há operação.** E a tela precisa DIZER que a data é a
 *    da noite: sem isso alguém abre um dia novo às 00h05 e parte o faturamento
 *    da mesma noite em dois.
 * 4. **Caixa fechado bloqueia.** Se o operador não abriu a gaveta dele, nada
 *    pode ser lançado — senão o dinheiro entra num caixa que não existe e a
 *    conferência do fim da noite não fecha.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CashFloor from './CashFloor';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useCashDay } from '../contexts/CashDayContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <div data-testid="sidebar" />);
jest.mock('../components/CashboxBanner', () => ({ onStateChange }) => {
  // O banner real vai à rede; aqui ele só reporta o caixa que o teste montou.
  const cb = global.__caixa === undefined ? null : global.__caixa;
  if (onStateChange) onStateChange(cb);
  return <div data-testid="cashbox-banner" />;
});
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('../contexts/CashDayContext', () => ({ useCashDay: jest.fn() }));
jest.mock('../hooks/usePolling', () => () => {});
jest.mock('react-router-dom', () => ({
  Link: ({ to, children, ...rest }) => <a href={to} {...rest}>{children}</a>,
  useNavigate: () => jest.fn(),
}));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (chave, padrao, vars) => {
      if (typeof padrao !== 'string') return chave;
      return padrao.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars ? vars[k] : ''));
    },
  }),
}));

const DIA = 'dia-1';

const RESUMO = {
  cash_day_id: DIA, business_date: '2026-09-10', status: 'open',
  total_buy_ins: 600, total_cash_outs: 470, revenue: 130,
  jackpot_collected: 26, variance: 194,
  tables_open: 1, tables_total: 1, players_seated: 1, players_total: 2,
  cash_in_play: 300,
};

const MESA = {
  id: 'mesa-1', cash_day_id: DIA, table_number: 3, seats: 9,
  game_variant: 'nlh', small_blind: 1, big_blind: 2, min_buy_in: 100,
  max_buy_in: 400, status: 'open', opened_at: '2026-09-10T21:00:00Z',
  game_type_name: 'NLH 1/2', occupied_seats: 4, free_seats: 5,
  total_buy_ins: 600, total_cash_outs: 470, rake_partial: 40, jackpot_partial: 8,
};

const TIPO = {
  id: 'tipo-1', name: 'NLH 1/2', game_variant: 'nlh', small_blind: 1,
  big_blind: 2, min_buy_in: 100, max_buy_in: 400, default_seats: 9,
  rake_percent: 5, rake_cap: 10, jackpot_per_pot: 1, active: true,
};

let recarregarDia;

const montar = ({
  dia = { id: DIA, business_date: '2026-09-10', status: 'open' },
  mesas = [MESA], tipos = [TIPO], resumo = RESUMO, caixa = { status: 'open' },
} = {}) => {
  global.__caixa = caixa;
  recarregarDia = jest.fn();
  useCashDay.mockReturnValue({
    day: dia, cashDayId: dia?.id || null,
    isOpen: !!dia && dia.status === 'open',
    loading: false, reload: recarregarDia,
  });
  api.get.mockImplementation((url) => {
    if (url.includes('/tables')) return Promise.resolve({ data: mesas });
    if (url.includes('/summary')) return Promise.resolve({ data: resumo });
    if (url.includes('/game-types')) return Promise.resolve({ data: tipos });
    return Promise.resolve({ data: [] });
  });
  return render(<CashFloor />);
};

beforeEach(() => {
  jest.clearAllMocks();
  global.__caixa = { status: 'open' };
  useToast.mockReturnValue({ toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn() } });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  api.post.mockResolvedValue({ data: {} });
});

describe('indicadores do dia', () => {
  it('o faturamento é o rake', async () => {
    montar();
    expect(await screen.findByText('Faturamento (rake)')).toBeInTheDocument();
    expect(screen.getByText('R$ 130.00')).toBeInTheDocument();
  });

  it('o giro aparece, mas NÃO como receita', async () => {
    // 600 entraram na gaveta e a maior parte já voltou. Rotular isso como
    // faturamento multiplicaria a receita do clube por cinco.
    montar();
    await screen.findByText('Faturamento (rake)');
    expect(screen.getByText('Giro: R$ 600.00')).toBeInTheDocument();
    expect(screen.queryByText('Faturamento (rake)')).not.toHaveTextContent('600');
  });

  it('o jackpot é marcado como não sendo receita', async () => {
    montar();
    expect(await screen.findByText('Jackpot acumulado hoje')).toBeInTheDocument();
    expect(screen.getByText('R$ 26.00')).toBeInTheDocument();
    expect(screen.getByText('Não é receita')).toBeInTheDocument();
  });

  it('mostra fichas na mesa e jogadores sentados', async () => {
    montar();
    expect(await screen.findByText('Fichas na mesa')).toBeInTheDocument();
    expect(screen.getByText('R$ 300.00')).toBeInTheDocument();
    expect(screen.getByText('Jogadores sentados')).toBeInTheDocument();
  });
});

describe('dia de operação', () => {
  it('sem dia aberto, oferece abrir', async () => {
    montar({ dia: null });
    expect(await screen.findByText('Nenhum dia de operação aberto')).toBeInTheDocument();
  });

  it('explica que a data é a da NOITE', async () => {
    // É a regra inteira: sem o aviso alguém abre um dia novo depois da
    // meia-noite e parte o faturamento da mesma noite em dois.
    montar({ dia: null });
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir dia' }));
    expect(
      screen.getByText(/data da NOITE/i)
    ).toBeInTheDocument();
  });

  it('abre o dia com a data escolhida', async () => {
    montar({ dia: null });
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir dia' }));
    const data = screen.getByLabelText('Data da operação');
    await userEvent.clear(data);
    await userEvent.type(data, '2026-09-12');
    // Escopado ao diálogo: o CTA do estado vazio tem o mesmo rótulo, e clicar
    // nele reabriria o modal em vez de enviar.
    const dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Abrir dia' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/cash-game/days',
      expect.objectContaining({ business_date: '2026-09-12' }),
    ));
    expect(recarregarDia).toHaveBeenCalled();
  });

  it('sem dia aberto não mostra o botão de abrir mesa', async () => {
    montar({ dia: null });
    await screen.findByText('Nenhum dia de operação aberto');
    expect(screen.queryByRole('button', { name: 'Abrir mesa' })).toBeNull();
  });
});

describe('mesas', () => {
  it('mostra o número da mesa e os stakes', async () => {
    montar();
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.getByText('R$ 1.00/R$ 2.00')).toBeInTheDocument();
    expect(screen.getByText('NLH 1/2')).toBeInTheDocument();
  });

  it('mostra quantos lugares estão livres', async () => {
    montar();
    expect(await screen.findByText('5 de 9 livres')).toBeInTheDocument();
  });

  it('leva para a mesa', async () => {
    montar();
    const link = await screen.findByRole('link');
    expect(link).toHaveAttribute('href', '/cash/mesas/mesa-1');
  });

  it('mesa fechada some do salão', async () => {
    montar({ mesas: [{ ...MESA, status: 'closed' }] });
    expect(await screen.findByText('Nenhuma mesa aberta')).toBeInTheDocument();
  });

  it('sugere o próximo número livre', async () => {
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir mesa' }));
    // A mesa 3 está aberta; a 1 continua livre.
    expect(screen.getByLabelText('Número da mesa')).toHaveValue(1);
  });

  it('abre a mesa com a modalidade escolhida', async () => {
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Abrir mesa' }));
    const dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Abrir mesa' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/cash-game/tables', {
      cash_day_id: DIA, game_type_id: 'tipo-1', table_number: 1, seats: null,
    }));
  });
});

describe('travas', () => {
  it('sem modalidade cadastrada não dá para abrir mesa', async () => {
    // Abrir mesa sem stakes deixaria buy-in e rake indefinidos, e a apuração
    // da noite nasceria sem referência nenhuma.
    montar({ tipos: [], mesas: [] });
    await screen.findByText('Nenhuma mesa aberta');
    expect(screen.getByRole('button', { name: 'Abrir mesa' })).toBeDisabled();
  });

  it('caixa fechado bloqueia a abertura de mesa e avisa', async () => {
    montar({ caixa: { status: 'closed' } });
    expect(await screen.findByText('Abra o seu caixa antes de movimentar dinheiro.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Abrir mesa' })).toBeDisabled();
  });

  it('super-admin sem vínculo não é bloqueado', async () => {
    // O banner devolve null para quem não tem linha em `staff`: não há gaveta
    // a exigir, e travar a tela impediria o dono do sistema de testar.
    montar({ caixa: null });
    await screen.findByText('Faturamento (rake)');
    expect(screen.getByRole('button', { name: 'Abrir mesa' })).not.toBeDisabled();
  });
});
