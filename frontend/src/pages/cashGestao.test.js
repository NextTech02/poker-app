/**
 * As telas de GESTÃO do cash game: dias de operação e modalidades.
 *
 * Estão juntas porque protegem a mesma ideia por dois ângulos: o que é
 * CONGELADO e o que é RETRATO.
 *
 * 1. **Fechar o dia congela.** Enquanto ele está aberto os totais são NULOS de
 *    propósito — gravar um parcial criaria um segundo número para a mesma
 *    pergunta e ninguém saberia qual vale. A tela precisa dizer isso, senão as
 *    colunas vazias parecem defeito.
 * 2. **Faturamento é o RAKE.** A coluna existe para responder "quanto
 *    faturamos ontem?"; o giro de buy-ins é outra coluna, com outro nome.
 * 3. **A mesa guarda um retrato da modalidade.** Por isso editar um stake em
 *    uso é seguro — e a tela precisa afirmar isso, ou ninguém corrige um rake
 *    errado com medo de reescrever o passado.
 * 4. **Buy-in máximo vazio = SEM TETO**, e não zero. Zero impediria qualquer
 *    buy-in e travaria a mesa no primeiro jogador.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CashDays from './CashDays';
import CashConfig from './CashConfig';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';
import { useCashDay } from '../contexts/CashDayContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), delete: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <div data-testid="sidebar" />);
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('../contexts/CashDayContext', () => ({ useCashDay: jest.fn() }));
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (chave, padrao, vars) => {
      if (typeof padrao !== 'string') return chave;
      return padrao.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars ? vars[k] : ''));
    },
  }),
}));

const ABERTO = {
  id: 'dia-2', business_date: '2026-09-11', status: 'open',
  opened_at: '2026-09-11T21:00:00Z',
  total_rake: null, total_jackpot: null, total_buy_ins: null,
  total_cash_outs: null, tables_count: null, players_count: null,
};

const FECHADO = {
  id: 'dia-1', business_date: '2026-09-10', status: 'closed', label: 'Sexta do NLH',
  opened_at: '2026-09-10T21:00:00Z',
  total_rake: 130, total_jackpot: 26, total_buy_ins: 600,
  total_cash_outs: 470, tables_count: 2, players_count: 11,
};

const TIPO = {
  id: 'tipo-1', name: 'NLH 1/2', game_variant: 'nlh', small_blind: 1, big_blind: 2,
  ante: 0, min_buy_in: 100, max_buy_in: 400, default_seats: 9,
  rake_percent: 5, rake_cap: 10, jackpot_per_pot: 1, active: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  useToast.mockReturnValue({ toast: { success: jest.fn(), error: jest.fn(), warning: jest.fn() } });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  useCashDay.mockReturnValue({ reload: jest.fn() });
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
});

// ══════════════════════════════════════════════════════════════════════
describe('dias de operação', () => {
  const montar = (dias = [ABERTO, FECHADO]) => {
    api.get.mockResolvedValue({ data: dias });
    return render(<CashDays />);
  };

  it('mostra o faturamento do dia fechado', async () => {
    montar();
    expect(await screen.findByText('2026-09-10')).toBeInTheDocument();
    expect(screen.getByText('R$ 130.00')).toBeInTheDocument();
  });

  it('separa faturamento de giro', async () => {
    // São perguntas diferentes: 600 giraram na gaveta, 130 ficaram no clube.
    montar();
    await screen.findByText('2026-09-10');
    expect(screen.getByText('Faturamento (rake)')).toBeInTheDocument();
    expect(screen.getByText('Giro (buy-ins)')).toBeInTheDocument();
    expect(screen.getByText('R$ 600.00')).toBeInTheDocument();
  });

  it('soma o rake do período no subtítulo', async () => {
    montar();
    expect(await screen.findByText(/somou R\$ 130\.00 de rake/)).toBeInTheDocument();
  });

  it('o dia aberto aparece sem totais e explica por quê', async () => {
    montar();
    await screen.findByText('2026-09-11');
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
    expect(screen.getByText(/Os totais aparecem quando o dia é encerrado/)).toBeInTheDocument();
  });

  it('só o dia aberto oferece encerrar', async () => {
    montar();
    await screen.findByText('2026-09-11');
    expect(screen.getAllByRole('button', { name: 'Encerrar' })).toHaveLength(1);
  });

  it('encerrar avisa que o faturamento será congelado', async () => {
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Encerrar' }));
    expect(screen.getByText(/CONGELADO/)).toBeInTheDocument();
    expect(screen.getByText(/Todas as mesas precisam estar fechadas/)).toBeInTheDocument();
  });

  it('encerra o dia escolhido', async () => {
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Encerrar' }));
    const dialogo = screen.getByRole('dialog');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Encerrar' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/cash-game/days/dia-2/close', { notes: null },
    ));
  });

  it('período vazio não é erro', async () => {
    montar([]);
    expect(await screen.findByText('Nenhum dia no período')).toBeInTheDocument();
  });
});

// ══════════════════════════════════════════════════════════════════════
describe('modalidades', () => {
  const montar = (tipos = [TIPO]) => {
    api.get.mockResolvedValue({ data: tipos });
    return render(<CashConfig />);
  };

  it('lista stakes, buy-in e rake', async () => {
    montar();
    expect(await screen.findByText('NLH 1/2')).toBeInTheDocument();
    expect(screen.getByText('R$ 1.00/R$ 2.00')).toBeInTheDocument();
    expect(screen.getByText(/R\$ 100\.00/)).toBeInTheDocument();
  });

  it('afirma que editar não muda mesas já abertas', async () => {
    // Sem esta afirmação ninguém corrige um rake errado com medo de reescrever
    // a apuração de ontem.
    montar();
    await screen.findByText('NLH 1/2');
    expect(screen.getByText(/editar aqui não muda mesas já abertas/)).toBeInTheDocument();
  });

  it('sem modalidade, manda cadastrar antes da primeira mesa', async () => {
    montar([]);
    expect(await screen.findByText('Nenhuma modalidade cadastrada')).toBeInTheDocument();
  });

  it('buy-in máximo vazio vira SEM TETO, não zero', async () => {
    // Zero impediria qualquer buy-in e travaria a mesa no primeiro jogador.
    montar([]);
    await userEvent.click(await screen.findByRole('button', { name: 'Nova modalidade' }));
    await userEvent.type(screen.getByLabelText('Nome'), 'PLO 2/5');
    await userEvent.type(screen.getByLabelText('Small blind'), '2');
    await userEvent.type(screen.getByLabelText('Big blind'), '5');
    await userEvent.type(screen.getByLabelText('Buy-in mínimo'), '500');
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/cash-game/game-types',
      expect.objectContaining({ name: 'PLO 2/5', min_buy_in: 500, max_buy_in: null }),
    ));
  });

  it('mesa sem teto é mostrada como tal', async () => {
    montar([{ ...TIPO, max_buy_in: null }]);
    expect(await screen.findByText(/sem teto/)).toBeInTheDocument();
  });

  it('avisa que a receita é a CONTADA, não a calculada', async () => {
    // É o mal-entendido mais provável desta tela: achar que o sistema calcula
    // o rake sozinho a partir do percentual.
    montar([]);
    await userEvent.click(await screen.findByRole('button', { name: 'Nova modalidade' }));
    expect(screen.getByText(/CONTADA na caixa da mesa/)).toBeInTheDocument();
  });

  it('editar carrega os valores atuais', async () => {
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Editar' }));
    expect(screen.getByLabelText('Nome')).toHaveValue('NLH 1/2');
    expect(screen.getByLabelText('Buy-in máximo')).toHaveValue(400);
  });

  it('modalidade em uso é desativada, não apagada', async () => {
    // O histórico perderia o nome pelo qual o clube chama aquela mesa.
    const avisar = jest.fn();
    useToast.mockReturnValue({ toast: { success: avisar, error: jest.fn(), warning: jest.fn() } });
    api.delete.mockResolvedValue({ data: { deactivated: true } });
    montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Excluir' }));
    await waitFor(() => expect(avisar).toHaveBeenCalledWith(
      'Modalidade desativada (já usada em mesas)',
    ));
  });
});
