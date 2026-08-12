/**
 * Dashboard.
 *
 * A decisão que sustenta a tela é **cada painel falhar sozinho**: as três
 * consultas vão em `allSettled`, e um 503 nas transações não pode apagar os
 * torneios que carregaram bem.
 *
 * Ligado a isso está o defeito que originou o estado de erro por seção
 * (ISSUE-001): antes, uma consulta que falhava caía no mesmo caminho de
 * "lista vazia", e a tela dizia **"Nenhum torneio criado ainda"** para um
 * clube com dezenas de torneios. O operador concluía que tinha perdido tudo.
 */
import { render, screen, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard';
import api from '../config/api';
import { useCurrency } from '../contexts/CurrencyContext';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: jest.fn() }));
jest.mock('react-i18next', () => {
  const t = (chave, padrao) => (typeof padrao === 'string' ? padrao : chave);
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const ESTATISTICAS = {
  activeTournaments: 3,
  totalPlayers: 128,
  totalRevenue: 45000,
  todayRevenue: 7200,
};

const TORNEIOS = [
  { id: 't1', name: 'Main Event', status: 'active' },
  { id: 't2', name: 'Turbo', status: 'pending' },
  { id: 't3', name: 'Antigo', status: 'completed' },
  { id: 't4', name: 'Quarto', status: 'cancelled' },
];

const TRANSACOES = [
  { id: 'x1', player_name: 'Ana', type: 'buy_in', amount: 300 },
  { id: 'x2', player_name: 'Beto', type: 'rebuy', amount: 300 },
  { id: 'x3', player_name: 'Carla', type: 'addon', amount: 150 },
  { id: 'x4', player_name: 'Davi', type: 'payout', amount: 5000 },
  { id: 'x5', player_name: 'Elis', type: 'buy_in', amount: 300 },
  { id: 'x6', player_name: 'Fábio', type: 'buy_in', amount: 300 },
];

const responder = ({ stats = ESTATISTICAS, torneios = TORNEIOS, transacoes = TRANSACOES } = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/dashboard/stats') {
      return stats instanceof Error ? Promise.reject(stats) : Promise.resolve({ data: stats });
    }
    if (url === '/tournaments') {
      return torneios instanceof Error ? Promise.reject(torneios) : Promise.resolve({ data: torneios });
    }
    if (url === '/transactions') {
      return transacoes instanceof Error ? Promise.reject(transacoes) : Promise.resolve({ data: transacoes });
    }
    return Promise.resolve({ data: [] });
  });
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<MemoryRouter><Dashboard /></MemoryRouter>);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/dashboard/stats'));
};

beforeEach(() => {
  jest.useRealTimers();
  useCurrency.mockReturnValue({ formatCurrency: (v) => `R$ ${Number(v || 0).toFixed(2)}` });
});

describe('indicadores', () => {
  it('mostra os quatro números', async () => {
    await montar();
    expect(await screen.findByText('3')).toBeInTheDocument();
    expect(screen.getByText('128')).toBeInTheDocument();
    expect(screen.getByText('R$ 45000.00')).toBeInTheDocument();
    expect(screen.getByText('R$ 7200.00')).toBeInTheDocument();
  });

  it('valor ausente vira zero, não vazio', async () => {
    // Um indicador em branco parece defeito; zero é uma informação.
    await montar({ stats: {} });
    await waitFor(() => expect(screen.getAllByText('0').length).toBeGreaterThan(0));
    expect(screen.getAllByText('R$ 0.00').length).toBe(2);
  });

  it('estatísticas que falham não zeram a tela toda', async () => {
    // Os painéis de atividade continuam úteis mesmo sem os indicadores.
    await montar({ stats: new Error('503') });
    expect(await screen.findByText('Main Event')).toBeInTheDocument();
  });

  it('mostra o esqueleto enquanto carrega', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    expect(document.querySelectorAll('.skeleton-stat-card').length).toBe(4);
  });
});

describe('torneios recentes', () => {
  it('mostra no máximo três', async () => {
    // O painel é um resumo; a lista completa tem tela própria.
    await montar();
    await screen.findByText('Main Event');
    expect(screen.queryByText('Quarto')).toBeNull();
  });

  it('cada torneio leva à própria tela', async () => {
    await montar();
    expect(await screen.findByText('Main Event')).toBeInTheDocument();
    expect(screen.getByText('Main Event').closest('a')).toHaveAttribute(
      'href',
      '/torneios/t1'
    );
  });

  it.each([
    ['active', 'Ativo'],
    ['pending', 'Pendente'],
    ['completed', 'Concluído'],
  ])('status %s vira etiqueta "%s"', async (status, rotulo) => {
    await montar({ torneios: [{ id: 't1', name: 'X', status }] });
    expect(await screen.findByText(rotulo)).toBeInTheDocument();
  });

  it('status desconhecido cai em pendente', async () => {
    // Um status novo no backend não pode quebrar a tela nem sumir da lista.
    await montar({ torneios: [{ id: 't1', name: 'X', status: 'status_novo' }] });
    expect(await screen.findByText('Pendente')).toBeInTheDocument();
  });

  it('sem torneio nenhum diz isso', async () => {
    await montar({ torneios: [] });
    expect(await screen.findByText('Nenhum torneio criado ainda.')).toBeInTheDocument();
  });

  it('FALHA não é confundida com lista vazia', async () => {
    // Era o ISSUE-001: a tela dizia "Nenhum torneio criado ainda" para um
    // clube com dezenas de torneios, e o operador achava que perdeu tudo.
    await montar({ torneios: new Error('503') });
    expect(await screen.findByText(/Não foi possível carregar/)).toBeInTheDocument();
    expect(screen.queryByText('Nenhum torneio criado ainda.')).toBeNull();
  });

  it('tentar de novo refaz a busca', async () => {
    await montar({ torneios: new Error('503') });
    await screen.findByText(/Não foi possível carregar/);
    responder();
    await userEvent.click(screen.getAllByRole('button', { name: 'Tentar novamente' })[0]);
    expect(await screen.findByText('Main Event')).toBeInTheDocument();
  });
});

describe('transações recentes', () => {
  it('mostra no máximo cinco', async () => {
    await montar();
    await screen.findByText(/Ana/);
    expect(screen.queryByText(/Fábio/)).toBeNull();
  });

  it('mostra jogador, tipo e valor', async () => {
    await montar();
    expect(await screen.findByText('Ana — Buy-in')).toBeInTheDocument();
    expect(screen.getByText('Beto — Rebuy')).toBeInTheDocument();
  });

  it('tipo desconhecido sai como veio', async () => {
    // Um tipo novo no backend não pode virar "undefined" na tela.
    await montar({ transacoes: [{ id: 'x1', player_name: 'Ana', type: 'tipo_novo', amount: 10 }] });
    expect(await screen.findByText('Ana — tipo_novo')).toBeInTheDocument();
  });

  it('sem transação diz isso', async () => {
    await montar({ transacoes: [] });
    expect(await screen.findByText('Nenhuma transação registrada.')).toBeInTheDocument();
  });

  it('FALHA não é confundida com lista vazia', async () => {
    await montar({ transacoes: new Error('503') });
    expect(await screen.findByText(/Não foi possível carregar/)).toBeInTheDocument();
    expect(screen.queryByText('Nenhuma transação registrada.')).toBeNull();
  });

  it('um painel falhando não derruba o outro', async () => {
    // É a razão de as três consultas irem em `allSettled`.
    await montar({ transacoes: new Error('503') });
    expect(await screen.findByText('Main Event')).toBeInTheDocument();
    expect(screen.getByText(/Não foi possível carregar/)).toBeInTheDocument();
  });
});

describe('recuperação automática', () => {
  it('falha dispara UMA nova tentativa', async () => {
    // Um 503 momentâneo se resolve sozinho; insistir sem limite viraria
    // martelada no servidor que já está com problema.
    jest.useFakeTimers();
    responder({ torneios: new Error('503') });
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await act(async () => {});
    const antes = api.get.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(api.get.mock.calls.length).toBeGreaterThan(antes);

    // A segunda falha NAO agenda uma terceira. O avanco fica ABAIXO dos 30s
    // do polling, senao seria ele a disparar a chamada e o teste mediria a
    // coisa errada.
    const depois = api.get.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(20000);
    });
    expect(api.get.mock.calls.length).toBe(depois);
    jest.useRealTimers();
  });

  it('carga bem-sucedida não agenda nova tentativa', async () => {
    jest.useFakeTimers();
    responder();
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await act(async () => {});
    const antes = api.get.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(api.get.mock.calls.length).toBe(antes);
    jest.useRealTimers();
  });

  it('cancela a tentativa pendente ao sair da tela', async () => {
    // Um timer sobrevivente chamaria setState num componente desmontado.
    jest.useFakeTimers();
    responder({ torneios: new Error('503') });
    const { unmount } = render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await act(async () => {});
    unmount();
    const antes = api.get.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(10000);
    });
    expect(api.get.mock.calls.length).toBe(antes);
    jest.useRealTimers();
  });
});

describe('atualização periódica', () => {
  it('recarrega sozinho a cada 30s', async () => {
    // O dashboard fica aberto na sala do gerente o dia inteiro.
    jest.useFakeTimers();
    responder();
    render(<MemoryRouter><Dashboard /></MemoryRouter>);
    await act(async () => {});
    const antes = api.get.mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(30000);
    });
    expect(api.get.mock.calls.length).toBeGreaterThan(antes);
    jest.useRealTimers();
  });
});
