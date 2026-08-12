/**
 * Caixa de Jogadores — crédito patrocinado e extrato do jogador.
 *
 * Crédito aqui é dinheiro de um PATROCINADOR bancando um jogador: ele entra
 * como saldo utilizável em buy-in/rebuy/add-on e é acertado depois, ou pelo
 * prêmio do jogador ou pelo próprio patrocinador. Por isso a tela separa
 * quatro números que parecem o mesmo mas não são — recebido, disponível,
 * usado e o que o patrocinador ainda deve.
 *
 * O extrato mistura transações e movimentos de crédito, e cada lançamento
 * precisa dizer o SINAL certo: um crédito concedido entra, um buy-in sai.
 * Trocar o sinal transformaria uma dívida em saldo.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CaixaJogadores from './CaixaJogadores';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../components/PlayerSelect', () => ({ value, onChange, name }) => (
  <select
    aria-label="jogador"
    value={value}
    onChange={(e) => onChange({ target: { name: name || 'player_id', value: e.target.value } })}
  >
    <option value="">—</option>
    <option value="p1">Ana</option>
    <option value="p2">Beto</option>
  </select>
));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('react-i18next', () => {
  const t = (chave) => chave;
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const RESUMO = {
  total_credits_received: 5000,
  total_credits_remaining: 1200,
  total_credits_used: 3800,
  total_sponsor_owes: 800,
};

// Três situações que decidem se o crédito ainda pode ser cancelado:
// intocado (pode), já acertado pelo prêmio (não) e ativo mas já gasto (não).
const CREDITOS = [
  { id: 'c1', sponsor_name: 'Cerveja X', original_amount: 5000, remaining_amount: 5000,
    used_amount: 0, prize_deduction_amount: 0, sponsor_owes: 0, status: 'active' },
  { id: 'c2', sponsor_name: 'Loja Y', original_amount: 1000, remaining_amount: 0,
    used_amount: 1000, prize_deduction_amount: 1000, sponsor_owes: 0, status: 'settled_by_prize' },
  { id: 'c3', sponsor_name: 'Bar Z', original_amount: 2000, remaining_amount: 1200,
    used_amount: 800, prize_deduction_amount: 0, sponsor_owes: 800, status: 'active' },
];

const EXTRATO = [
  { id: 'e1', date: '2026-06-08T20:00:00Z', category: 'credit', type: 'credit_granted',
    sponsor_name: 'Cerveja X', amount: 5000 },
  { id: 'e2', date: '2026-06-08T21:00:00Z', category: 'transaction', type: 'buy_in',
    tournament_name: 'Main Event', amount: 500 },
];

const PATROCINADORES = [{ id: 'sp1', name: 'Cerveja X' }];

let toast;

const responder = ({
  resumo = RESUMO, creditos = CREDITOS, extrato = EXTRATO, patrocinadores = PATROCINADORES,
} = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/sponsors') return Promise.resolve({ data: patrocinadores });
    if (url.endsWith('/summary')) {
      return resumo instanceof Error ? Promise.reject(resumo) : Promise.resolve({ data: resumo });
    }
    if (url.includes('/statement')) return Promise.resolve({ data: extrato });
    if (url.endsWith('/credits')) return Promise.resolve({ data: creditos });
    return Promise.resolve({ data: [] });
  });
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<CaixaJogadores />);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/sponsors'));
};

const escolherJogador = async (id = 'p1') => {
  await userEvent.selectOptions(screen.getByLabelText('jogador'), id);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith(`/player-credits/player/${id}/summary`));
};

const linhaDoCredito = (patrocinador) =>
  Array.from(document.querySelectorAll('.cj-credits-card tbody tr')).find((tr) =>
    within(tr).queryByText(patrocinador)
  );

const erroHttp = (detail) => {
  const e = new Error('http');
  e.response = { data: { detail } };
  return e;
};

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  useToast.mockReturnValue({ toast });
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
  api.post.mockResolvedValue({ data: {} });
  jest.spyOn(window, 'confirm').mockReturnValue(true);
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  window.confirm.mockRestore();
  console.error.mockRestore();
});

describe('seleção do jogador', () => {
  it('sem jogador escolhido a tela explica o que fazer', async () => {
    await montar();
    expect(screen.getByText('playerCash.selectPlayerEmpty')).toBeInTheDocument();
  });

  it('escolher o jogador carrega resumo, créditos e extrato', async () => {
    await montar();
    await escolherJogador();
    expect(api.get).toHaveBeenCalledWith('/player-credits/player/p1/credits');
    expect(api.get).toHaveBeenCalledWith(expect.stringContaining('/statement'));
  });

  it('trocar de jogador recarrega os dados do novo', async () => {
    await montar();
    await escolherJogador('p1');
    await escolherJogador('p2');
    expect(api.get).toHaveBeenCalledWith('/player-credits/player/p2/summary');
  });

  it('falha ao carregar avisa', async () => {
    await montar({ resumo: new Error('500') });
    await userEvent.selectOptions(screen.getByLabelText('jogador'), 'p1');
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('playerCash.loadDataError'));
  });
});

describe('os quatro números do crédito', () => {
  it('separa recebido, disponível, usado e o que o patrocinador deve', async () => {
    // Parecem o mesmo número e não são: "usado" já saiu, "disponível" ainda
    // dá para gastar, e "o patrocinador deve" é dívida a cobrar.
    await montar();
    await escolherJogador();
    const cartoes = await waitFor(() => {
      const c = document.querySelectorAll('.stat-card');
      expect(c.length).toBe(4);
      return c;
    });
    expect(cartoes[0]).toHaveTextContent('R$ 5000.00');
    expect(cartoes[1]).toHaveTextContent('R$ 1200.00');
    expect(cartoes[2]).toHaveTextContent('R$ 3800.00');
    expect(cartoes[3]).toHaveTextContent('R$ 800.00');
  });
});

describe('lista de créditos', () => {
  it('mostra origem, valores e situação de cada crédito', async () => {
    await montar();
    await escolherJogador();
    await waitFor(() => expect(linhaDoCredito('Cerveja X')).toBeDefined());
    const linha = linhaDoCredito('Cerveja X');
    expect(linha).toHaveTextContent('R$ 5000.00');
    expect(within(linha).getByText('playerCash.statusActive')).toBeInTheDocument();
  });

  it('crédito quitado pelo prêmio é sinalizado como acertado', async () => {
    // É o desfecho normal: o jogador premiou e o crédito saiu do prêmio.
    await montar();
    await escolherJogador();
    await waitFor(() => expect(linhaDoCredito('Loja Y')).toBeDefined());
    expect(within(linhaDoCredito('Loja Y')).getByText('playerCash.statusSettledByPrize')).toBeInTheDocument();
  });

  it('situação desconhecida não some da tela', async () => {
    await montar({
      creditos: [{ id: 'c9', sponsor_name: 'Z', original_amount: 1, remaining_amount: 1,
        used_amount: 0, prize_deduction_amount: 0, sponsor_owes: 0, status: 'em_analise' }],
    });
    await escolherJogador();
    expect(await screen.findByText('em_analise')).toBeInTheDocument();
  });

  it('só crédito ativo e INTOCADO pode ser cancelado', async () => {
    // Cancelar um crédito já acertado desfaria um pagamento concluído; e
    // cancelar um já gasto apagaria fichas que o jogador levou para a mesa.
    await montar();
    await escolherJogador();
    await waitFor(() => expect(linhaDoCredito('Cerveja X')).toBeDefined());
    expect(within(linhaDoCredito('Cerveja X')).getByText('common.cancel')).toBeInTheDocument();
    expect(within(linhaDoCredito('Loja Y')).queryByText('common.cancel')).toBeNull();
    expect(within(linhaDoCredito('Bar Z')).queryByText('common.cancel')).toBeNull();
  });

  it('cancelar pede confirmação e recarrega', async () => {
    await montar();
    await escolherJogador();
    await waitFor(() => expect(linhaDoCredito('Cerveja X')).toBeDefined());
    await userEvent.click(within(linhaDoCredito('Cerveja X')).getByText('common.cancel'));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/player-credits/c1/cancel'));
    expect(toast.success).toHaveBeenCalledWith('playerCash.creditCancelledSuccess');
  });

  it('recusar a confirmação não cancela', async () => {
    window.confirm.mockReturnValue(false);
    await montar();
    await escolherJogador();
    await waitFor(() => expect(linhaDoCredito('Cerveja X')).toBeDefined());
    await userEvent.click(within(linhaDoCredito('Cerveja X')).getByText('common.cancel'));
    expect(api.post).not.toHaveBeenCalled();
  });

  it('erro ao cancelar mostra o motivo do servidor', async () => {
    // "Crédito já usado" é a explicação que o operador precisa.
    api.post.mockRejectedValue(erroHttp('Crédito já utilizado'));
    await montar();
    await escolherJogador();
    await waitFor(() => expect(linhaDoCredito('Cerveja X')).toBeDefined());
    await userEvent.click(within(linhaDoCredito('Cerveja X')).getByText('common.cancel'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Crédito já utilizado'));
  });
});

describe('extrato', () => {
  it('crédito concedido ENTRA e buy-in SAI', async () => {
    // Trocar o sinal transformaria uma dívida em saldo.
    await montar();
    await escolherJogador();
    const linhas = await waitFor(() => {
      const l = document.querySelectorAll('.transactions-table tbody tr');
      expect(l.length).toBeGreaterThan(2);
      return l;
    });
    const extrato = Array.from(linhas).filter((tr) => tr.querySelector('.amount'));
    expect(extrato[0].querySelector('.amount').textContent).toMatch(/^\+/);
    expect(extrato[1].querySelector('.amount').textContent).toMatch(/^-/);
  });

  it('cada lançamento diz se veio de transação ou de crédito', async () => {
    await montar();
    await escolherJogador();
    expect(await screen.findByText('playerCash.categoryCredit')).toBeInTheDocument();
    expect(screen.getByText('playerCash.categoryTransaction')).toBeInTheDocument();
  });

  it('tipo desconhecido aparece como veio, sem virar "undefined"', async () => {
    await montar({
      extrato: [{ id: 'e9', date: '2026-06-08T20:00:00Z', category: 'transaction',
        type: 'tipo_novo', amount: 10 }],
    });
    await escolherJogador();
    expect(await screen.findByText('tipo_novo')).toBeInTheDocument();
  });

  it('torneio e patrocinador ausentes viram travessão', async () => {
    await montar({
      extrato: [{ id: 'e9', date: '2026-06-08T20:00:00Z', category: 'transaction',
        type: 'buy_in', amount: 10 }],
    });
    await escolherJogador();
    await waitFor(() =>
      expect(document.querySelectorAll('.transactions-table tbody tr').length).toBeGreaterThan(0)
    );
    expect(screen.getAllByText('—').length).toBeGreaterThan(0);
  });

  it('sem movimento nenhum explica isso', async () => {
    await montar({ extrato: [] });
    await escolherJogador();
    expect(await screen.findByText('playerCash.noMovements')).toBeInTheDocument();
  });
});

describe('filtros do extrato', () => {
  it('os filtros escolhidos viajam na consulta', async () => {
    await montar();
    await escolherJogador();
    await userEvent.selectOptions(document.querySelector('select[name="category"]'), 'credit');
    await userEvent.selectOptions(document.querySelector('select[name="type"]'), 'buy_in');
    await userEvent.click(screen.getByRole('button', { name: 'common.filter' }));
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        expect.stringMatching(/statement\?.*category=credit.*type=buy_in/)
      )
    );
  });

  it('o intervalo de datas também', async () => {
    await montar();
    await escolherJogador();
    await userEvent.type(document.querySelector('input[name="date_from"]'), '2026-06-01');
    await userEvent.type(document.querySelector('input[name="date_to"]'), '2026-06-30');
    await userEvent.click(screen.getByRole('button', { name: 'common.filter' }));
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        expect.stringMatching(/date_from=2026-06-01.*date_to=2026-06-30/)
      )
    );
  });

  it('limpar zera os filtros', async () => {
    await montar();
    await escolherJogador();
    await userEvent.selectOptions(document.querySelector('select[name="category"]'), 'credit');
    await userEvent.click(screen.getByRole('button', { name: 'common.clear' }));
    expect(document.querySelector('select[name="category"]')).toHaveValue('');
  });
});

describe('conceder crédito', () => {
  const abrir = () => userEvent.click(screen.getByRole('button', { name: 'playerCash.grantCredit' }));
  const enviar = () => userEvent.click(screen.getByRole('button', { name: 'playerCash.grantCreditTitle' }));

  it('só é possível com um jogador escolhido', async () => {
    // Um crédito sem dono não teria como ser usado nem cobrado.
    await montar();
    expect(screen.queryByRole('button', { name: 'playerCash.grantCredit' })).toBeNull();
  });

  it('concede o crédito ao jogador selecionado', async () => {
    await montar();
    await escolherJogador();
    await abrir();
    await userEvent.selectOptions(document.querySelector('.modal select'), 'sp1');
    await userEvent.type(screen.getByPlaceholderText('0.00'), '2000');
    await enviar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/player-credits', {
        player_id: 'p1', sponsor_id: 'sp1', amount: 2000, notes: null,
      })
    );
    expect(toast.success).toHaveBeenCalledWith('playerCash.creditGrantedSuccess');
  });

  it('a observação escrita acompanha o crédito', async () => {
    await montar();
    await escolherJogador();
    await abrir();
    await userEvent.selectOptions(document.querySelector('.modal select'), 'sp1');
    await userEvent.type(screen.getByPlaceholderText('0.00'), '2000');
    await userEvent.type(screen.getByPlaceholderText('playerCash.creditNotesPlaceholder'), 'Acordo verbal');
    await enviar();
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/player-credits',
        expect.objectContaining({ notes: 'Acordo verbal' })
      )
    );
  });

  it('erro do servidor mostra o motivo', async () => {
    api.post.mockRejectedValue(erroHttp('Patrocinador sem limite'));
    await montar();
    await escolherJogador();
    await abrir();
    await userEvent.selectOptions(document.querySelector('.modal select'), 'sp1');
    await userEvent.type(screen.getByPlaceholderText('0.00'), '2000');
    await enviar();
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Patrocinador sem limite'));
  });

  it('o crédito concedido recarrega o resumo do jogador', async () => {
    await montar();
    await escolherJogador();
    await abrir();
    await userEvent.selectOptions(document.querySelector('.modal select'), 'sp1');
    await userEvent.type(screen.getByPlaceholderText('0.00'), '2000');
    const antes = api.get.mock.calls.length;
    await enviar();
    await waitFor(() => expect(api.get.mock.calls.length).toBeGreaterThan(antes));
  });
});

describe('cadastrar patrocinador', () => {
  const abrir = () => userEvent.click(screen.getByRole('button', { name: 'playerCash.addSponsor' }));

  it('cria o patrocinador e recarrega a lista', async () => {
    // O crédito precisa de um patrocinador; cadastrar sem sair da tela evita
    // interromper o atendimento no balcão.
    await montar();
    await abrir();
    await userEvent.type(screen.getByPlaceholderText('playerCash.sponsorNamePlaceholder'), 'Bar do Zé');
    await userEvent.click(screen.getByRole('button', { name: 'common.register' }));
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/sponsors', expect.objectContaining({ name: 'Bar do Zé' }))
    );
    expect(toast.success).toHaveBeenCalledWith('playerCash.sponsorCreatedSuccess');
  });

  it('erro ao cadastrar avisa', async () => {
    api.post.mockRejectedValue(new Error('500'));
    await montar();
    await abrir();
    await userEvent.type(screen.getByPlaceholderText('playerCash.sponsorNamePlaceholder'), 'Bar do Zé');
    await userEvent.click(screen.getByRole('button', { name: 'common.register' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('playerCash.createSponsorError'));
  });

  it('fechar não cadastra nada', async () => {
    await montar();
    await abrir();
    await userEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(api.post).not.toHaveBeenCalled();
  });
});
