/**
 * Torneio por equipes: cadastro das equipes, Fase 1 (sorteio, pontos,
 * correções, oficialização) e a final por revezamento. A conta é do servidor;
 * aqui se confere o que a tela manda e o que ela mostra.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TorneioEquipes from './TorneioEquipes';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn(), put: jest.fn(), delete: jest.fn() },
}));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/CurrencyContext', () => ({
  useCurrency: () => ({ formatCurrency: (v) => `S/ ${Number(v).toFixed(2)}` }),
}));
jest.mock('../contexts/PaymentMethodsContext', () => ({
  usePaymentMethods: () => ({ activeMethods: [{ id: 'm1', code: 'cash', name: 'Efectivo' }] }),
}));
jest.mock('../hooks/useRealtimeRefresh', () => ({ useRealtimeRefresh: () => {} }));
jest.mock('../components/Sidebar', () => () => null);
jest.mock('../components/equipes/conferencia', () => ({ imprimirConferencia: jest.fn() }));
jest.mock('../components/PlayerSelect', () => ({ name, value, onChange }) => (
  <select aria-label={name} value={value} onChange={(e) => onChange({ target: { name, value: e.target.value } })}>
    <option value="">—</option>
    {['x1', 'x2', 'x3', 'x4'].map((p) => <option key={p} value={p}>{p}</option>)}
  </select>
));
jest.mock('react-i18next', () => {
  const t = (chave, segundo, terceiro) => {
    const padrao = typeof segundo === 'string' ? segundo : chave;
    const vars = typeof segundo === 'string' ? terceiro : segundo;
    if (!vars) return padrao;
    return padrao.replace(/\{\{(\w+)\}\}/g, (bruto, nome) => (vars[nome] === undefined ? bruto : String(vars[nome])));
  };
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const membro = (pid, nome, extra = {}) => ({
  player_id: pid, name: nome, nickname: null, relay_order: 1, is_captain: false, tp_id: `tp-${pid}`, status: 'active', ...extra,
});

const LISTA = {
  tournament: { id: 't1', name: 'Torneo por equipos', team_finalists: 2, team_tiebreak: 'best_individual', team_results_official_at: null },
  stage1_day_id: 'd1', final_day_id: 'd2', final_started: false,
  teams: [
    {
      id: 'A', name: 'Los Ases', captain_player_id: 'a1',
      members: [membro('a1', 'Ana', { is_captain: true }), membro('a2', 'Beto'), membro('a3', 'Caio', { tp_id: null, status: null }), membro('a4', 'Davi')],
    },
  ],
};

const jogadorDaMesa = (tp, nome, extra = {}) => ({
  tp_id: tp, player_id: tp.slice(3), name: nome, team_name: 'Los Ases', team_id: 'A', is_captain: false, status: 'eliminated',
  eliminated_at: '2026-10-15T21:00:00Z', tie_with_previous: false, position: 2, points: 10, tie: false, ...extra,
});

const FASE1 = {
  day_id: 'd1', official: false, finalists: 2, tiebreak: 'best_individual', cut_tie: false, final_set_up: false,
  tables_in_play: [2],
  tables: [{
    table_id: 'T1', table_number: 1, size: 3, finished: true, manual: false,
    players: [
      jogadorDaMesa('tp-a1', 'Ana', { status: 'active', position: 1, points: 15, eliminated_at: null }),
      jogadorDaMesa('tp-b1', 'Bia'),
      jogadorDaMesa('tp-c1', 'Ciro', { position: 3, points: 5 }),
    ],
  }],
  unseated: [],
  ranking: [{
    team_id: 'A', name: 'Los Ases', points: 15, captain_points: 15, rank: 1, tied: false, verified: false,
    members: [{ player_id: 'a1', name: 'Ana', is_captain: true, points: 15, table_number: 1, position: 1 }],
  }],
  warnings: [{ code: 'jogadores_sem_equipe', count: 2 }],
};

let toast;
let confirmar;

const responder = ({ lista = LISTA, fase1 = FASE1, relay = { teams: [], standings: [] } } = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/tournaments/t1/teams') return Promise.resolve({ data: lista });
    if (url === '/tournaments/t1/teams/stage1') return Promise.resolve({ data: fase1 });
    if (url === '/tournaments/t1/teams/relay') return Promise.resolve({ data: relay });
    if (url === '/tournaments/t1/buy-types') {
      return Promise.resolve({ data: [{ id: 'bt', name: 'Equipo', category: 'buy_in', amount: 1000, per_team: true, active: true }] });
    }
    return Promise.reject(new Error(url));
  });
};

const montar = async (rota = '/torneios/t1/equipes') => {
  render(
    <MemoryRouter initialEntries={[rota]}>
      <Routes><Route path="/torneios/:id/equipes" element={<TorneioEquipes />} /></Routes>
    </MemoryRouter>,
  );
  await screen.findByText('Los Ases', {}, { timeout: 3000 }).catch(() => {});
};

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn() };
  confirmar = jest.fn().mockResolvedValue(true);
  useToast.mockReturnValue({ toast, confirm: confirmar });
  api.post.mockResolvedValue({ data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.put.mockResolvedValue({ data: {} });
  api.delete.mockResolvedValue({ data: {} });
  responder();
});

describe('equipes', () => {
  it('mostra quem já está inscrito em cada equipe', async () => {
    await montar();
    expect(await screen.findByText('Los Ases')).toBeInTheDocument();
    expect(screen.getByText('3/4 inscritos')).toBeInTheDocument();
    expect(screen.getByText('não inscrito')).toBeInTheDocument();
  });

  it('cadastra uma equipe com o capitão marcado', async () => {
    await montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Nova equipe' }));
    const dialogo = screen.getByRole('dialog');
    await userEvent.type(within(dialogo).getByLabelText('Nome da equipe'), 'Los Reyes');
    for (let i = 0; i < 4; i += 1) {
      await userEvent.selectOptions(within(dialogo).getByLabelText(`membro_${i}`), `x${i + 1}`);
    }
    await userEvent.click(within(dialogo).getByLabelText('Capitão (integrante 2)'));
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/tournaments/t1/teams', {
      name: 'Los Reyes', captain_player_id: 'x2', player_ids: ['x1', 'x2', 'x3', 'x4'],
    }));
  });

  it('sem capitão a tela avisa antes de mandar', async () => {
    await montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Nova equipe' }));
    const dialogo = screen.getByRole('dialog');
    await userEvent.type(within(dialogo).getByLabelText('Nome da equipe'), 'X');
    await userEvent.selectOptions(within(dialogo).getByLabelText('membro_0'), 'x1');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Salvar' }));
    expect(within(dialogo).getByRole('alert')).toHaveTextContent('Marque quem é o capitão.');
    expect(api.post).not.toHaveBeenCalled();
  });

  it('cobra a equipe pelo meio "por equipe", com um id de mutação', async () => {
    api.post.mockResolvedValue({ data: { charged: 1 } });
    await montar();
    await userEvent.click(await screen.findByRole('button', { name: 'Cobrar equipe' }));
    const dialogo = await screen.findByRole('dialog');
    expect(await within(dialogo).findByText(/S\/ 250.00 por integrante/)).toHaveTextContent('Caio');
    await userEvent.click(within(dialogo).getByRole('button', { name: 'Cobrar equipe' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/tournaments/t1/teams/A/charge',
      expect.objectContaining({ buy_type_id: 'bt', payment_method: 'cash', client_mutation_id: expect.any(String) }),
    ));
  });
});

describe('fase 1', () => {
  it('mostra pontos por mesa, avisos e a prévia do sorteio', async () => {
    await montar('/torneios/t1/equipes?aba=fase1');
    expect(await screen.findByText('Mesa 1')).toBeInTheDocument();
    expect(screen.getByText(/3 jogadores → 3 mesas/)).toBeInTheDocument();
    expect(screen.getByText('jogadores_sem_equipe')).toBeInTheDocument();
  });

  it('sorteia as mesas', async () => {
    api.post.mockResolvedValue({ data: { allocated: 12 } });
    await montar('/torneios/t1/equipes?aba=fase1');
    await userEvent.click(await screen.findByRole('button', { name: 'Sortear mesas' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/tournaments/t1/teams/seating', { redo: false }));
    expect(toast.success).toHaveBeenCalledWith('12 jogador(es) sentado(s).');
  });

  it('marca empate com o anterior e troca a ordem', async () => {
    await montar('/torneios/t1/equipes?aba=fase1');
    await userEvent.click(await screen.findByRole('checkbox', { name: /empate c\/ anterior/ }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith(
      '/tournaments/t1/teams/stage1/results/tp-b1', { tie_with_previous: true },
    ));
    await userEvent.click(screen.getByRole('button', { name: 'Trocar a ordem de Bia com o anterior' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith(
      '/tournaments/t1/teams/stage1/results/tp-b1', { swap_with_previous: true },
    ));
  });

  it('oficializar com mesa em jogo pede confirmação e manda forçado', async () => {
    await montar('/torneios/t1/equipes?aba=fase1');
    await userEvent.click(await screen.findByRole('button', { name: 'Oficializar' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/tournaments/t1/teams/stage1/official', { force: true }));
    expect(confirmar.mock.calls[0][0]).toMatch(/Ainda há mesas em jogo \(2\)/);
  });

  it('o capitão confere a soma', async () => {
    await montar('/torneios/t1/equipes?aba=fase1');
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Capitão de Los Ases conferiu' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/tournaments/t1/teams/A/verify', { verified: true }));
  });
});

describe('final', () => {
  it('sem a Fase 1 oficial, explica o que falta', async () => {
    await montar('/torneios/t1/equipes?aba=final');
    expect(await screen.findByText(/Oficialize a classificação da Fase 1/)).toBeInTheDocument();
  });

  it('monta a final com os finalistas e o stack', async () => {
    responder({ lista: { ...LISTA, tournament: { ...LISTA.tournament, team_results_official_at: '2026-10-15T23:00:00Z' } } });
    await montar('/torneios/t1/equipes?aba=final');
    await userEvent.type(await screen.findByLabelText('Stack de cada equipe'), '30000');
    await userEvent.click(screen.getByRole('button', { name: 'Montar a final' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith('/tournaments/t1/teams/final', { finalists: 2, chips: 30000 }));
  });

  it('muda a ordem do revezamento', async () => {
    responder({
      relay: {
        final_day_id: 'd2', final_started: false, start_level: 1,
        teams: [{ team_id: 'A', name: 'Los Ases', status: 'active', members: [
          { player_id: 'a1', name: 'Ana', is_captain: true }, { player_id: 'a2', name: 'Beto' },
        ] }],
        standings: [{ team_id: 'A', name: 'Los Ases', status: 'playing', position: null }],
      },
    });
    await montar('/torneios/t1/equipes?aba=final');
    await userEvent.click(await screen.findByRole('button', { name: 'Descer Ana' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith(
      '/tournaments/t1/teams/A/relay-order', { player_ids: ['a2', 'a1'], force: false },
    ));
  });
});
