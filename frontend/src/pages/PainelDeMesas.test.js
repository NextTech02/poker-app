/**
 * Painel de mesas: todas as mesas desenhadas numa tela, para o floor e o
 * diretor verem e agirem pelo tablet ou pelo celular.
 *
 * O que os testes prendem:
 *
 * - **Tocar no assento abre as ações daquele jogador.** Eliminar passa pelo
 *   mesmo caminho da Gestão de Mesas (fila sem rede, "Quem eliminou?" no KO).
 * - **Trocar de mesa escolhe a mesa e o assento livre.** Só oferece cadeira que
 *   recebe jogador, e entrega o bilhete do lugar novo.
 * - **O painel sugere o equilíbrio, não executa.** Quem move é o floor.
 * - **Eliminação em massa não elimina pelo painel.** O sistema não sabe quem
 *   saiu; quem elimina é o contador do Controle.
 */
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import PainelDeMesas from './PainelDeMesas';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { offlineWrite } from '../offline/apiOffline';
import { usePresencaDoRelogio } from '../hooks/usePresencaDoRelogio';
import { useRealtimeRefresh } from '../hooks/useRealtimeRefresh';
import { useTorneioKo } from '../hooks/useTorneioKo';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn(), patch: jest.fn() },
}));
jest.mock('../offline/apiOffline', () => ({ offlineWrite: jest.fn() }));
jest.mock('../offline/db', () => ({ uuid: () => 'mut-fixa' }));
jest.mock('../offline/domainRules', () => ({ applyEliminate: jest.fn(), applyUneliminate: jest.fn() }));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../components/SeatTicket', () => ({ allocation }) => (
  <div data-testid="bilhete">{allocation.player_name}|{allocation.table_number}|{allocation.seat_number}</div>
));
jest.mock('../components/ko/EliminadorModal', () => ({ vitima }) => (
  <div data-testid="quem-eliminou">{vitima}</div>
));
jest.mock('../components/ko/KoResultadoModal', () => () => <div data-testid="ko-resultado" />);
jest.mock('../hooks/useTorneioKo', () => ({ useTorneioKo: jest.fn() }));
jest.mock('../hooks/usePresencaDoRelogio', () => ({ usePresencaDoRelogio: jest.fn() }));
jest.mock('../hooks/useRealtimeRefresh', () => ({ useRealtimeRefresh: jest.fn() }));
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('react-i18next', () => {
  const t = (chave, segundo) => {
    if (typeof segundo === 'string') return segundo;
    if (segundo?.defaultValue) {
      return segundo.defaultValue.replace(/\{\{(\w+)\}\}/g, (_, nome) => segundo[nome]);
    }
    return chave;
  };
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const DIA = { id: 'd1', day_name: 'Dia 1', tournament_id: 't1' };
const MESAS = [
  { id: 'm1', table_number: 1, seats: 4, status: 'active', blocked_seats: [] },
  { id: 'm2', table_number: 2, seats: 4, status: 'active', blocked_seats: [4] },
  { id: 'm3', table_number: 3, seats: 4, status: 'closed', blocked_seats: [] },
];
const sentado = (id, mesa, assento, jogador, nome) => ({
  id, table_id: mesa, seat_number: assento, player_id: jogador, players: { name: nome },
});
const ALOCACOES = [
  sentado('a1', 'm1', 1, 'p1', 'Ana'),
  sentado('a2', 'm1', 2, 'p2', 'Beto'),
  sentado('a3', 'm1', 3, 'p3', 'Carla'),
  sentado('a4', 'm1', 4, 'p4', 'Davi'),
  sentado('a5', 'm2', 1, 'p5', 'Eva'),
  sentado('a6', 'm2', 2, 'p6', 'Fábio'),
];
const INSCRITOS = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'].map((p, i) => ({
  id: `tp${i + 1}`, player_id: p, player_name: ['Ana', 'Beto', 'Carla', 'Davi', 'Eva', 'Fábio'][i], status: 'active',
}));
const PAINEL = {
  time_bank: { available: true, reason: null },
  players: [{ tournament_player_id: 'tp1', cards: 2 }],
};

let toast;
let confirmar;

const responder = ({
  mesas = MESAS, alocacoes = ALOCACOES, semMesa = [], inscritos = INSCRITOS, painel = PAINEL,
} = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/tournament-days/d1') return Promise.resolve({ data: DIA });
    if (url === '/tournaments/t1') return Promise.resolve({ data: { id: 't1', name: 'Main Event' } });
    if (url === '/tables/day/d1') return Promise.resolve({ data: mesas });
    if (url === '/allocations/day/d1') return Promise.resolve({ data: alocacoes });
    if (url === '/allocations/day/d1/unallocated') return Promise.resolve({ data: semMesa });
    if (url === '/tournament-players/day/d1') return Promise.resolve({ data: inscritos });
    if (url === '/table-clock/day/d1/panel') {
      return painel instanceof Error ? Promise.reject(painel) : Promise.resolve({ data: painel });
    }
    if (url.startsWith('/allocations/')) {
      return Promise.resolve({ data: { player_name: 'Ana', table_number: 2, seat_number: 3 } });
    }
    return Promise.resolve({ data: [] });
  });
};

const comKo = (mudancas = {}) => useTorneioKo.mockReturnValue({
  torneio: { id: 't1', elimination_mode: 'table' }, exige: false, comBounty: false, formato: null,
  recarregar: jest.fn(), ...mudancas,
});

const montar = async (opcoes) => {
  responder(opcoes);
  render(
    <MemoryRouter initialEntries={['/painel-mesas/d1']}>
      <Routes><Route path="/painel-mesas/:dayId" element={<PainelDeMesas />} /></Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(document.querySelectorAll('.pm-mesa').length).toBeGreaterThan(0));
};

const mesa = (numero) => Array.from(document.querySelectorAll('.pm-mesa'))
  .find((el) => el.querySelector('.pm-mesa-titulo')?.textContent.includes(`Mesa ${numero}`));
const assento = (numeroDaMesa, nome) => within(mesa(numeroDaMesa)).getByRole('button', { name: nome });
const janela = () => screen.getByRole('dialog');

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn(), warning: jest.fn(), info: jest.fn() };
  confirmar = jest.fn().mockResolvedValue(true);
  useToast.mockReturnValue({ toast, confirm: confirmar });
  comKo();
  usePresencaDoRelogio.mockReturnValue([]);
  useRealtimeRefresh.mockReturnValue(jest.fn());
  offlineWrite.mockResolvedValue({ offline: false, data: {} });
  api.patch.mockResolvedValue({ data: {} });
  api.post.mockResolvedValue({ data: { player_name: 'Gil', table_number: 2, seat_number: 3 } });
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => console.error.mockRestore());

describe('as mesas', () => {
  it('desenha cada mesa ativa com os assentos e quem está sentado', async () => {
    await montar();
    expect(mesa(1)).toHaveTextContent('Ana');
    expect(mesa(2)).toHaveTextContent('Eva');
    expect(within(mesa(1)).getAllByRole('button')).toHaveLength(4);
  });

  it('mesa fechada não aparece', async () => {
    await montar();
    expect(mesa(3)).toBeUndefined();
  });

  it('cada mesa diz quantos estão sentados e quantos lugares recebem jogador', async () => {
    await montar();
    expect(mesa(1).querySelector('.pm-mesa-titulo')).toHaveTextContent('4/4');
    expect(mesa(2).querySelector('.pm-mesa-titulo')).toHaveTextContent('2/3');
  });

  it('o resumo conta quem joga, as mesas e quem está sem mesa', async () => {
    await montar({ semMesa: [{ player_id: 'p9', player_name: 'Gil' }] });
    const resumo = document.querySelector('.pm-resumo');
    expect(resumo).toHaveTextContent('6');
    expect(resumo).toHaveTextContent('2 mesas');
    expect(resumo).toHaveTextContent('Sem mesa: 1');
  });

  it('assento bloqueado aparece e não abre nada', async () => {
    await montar();
    expect(assento(2, /^4/)).toBeDisabled();
    expect(assento(2, /^4/)).toHaveTextContent('Bloqueado');
  });

  it('mostra os cartões de time bank de quem tem', async () => {
    await montar();
    expect(assento(1, /Ana/).querySelector('.pm-cartoes')).toHaveTextContent('2');
  });

  it('sem acesso ao time bank, o painel funciona igual, sem cartões', async () => {
    await montar({ painel: Object.assign(new Error('403'), { response: { status: 403 } }) });
    expect(assento(1, /Ana/).querySelector('.pm-cartoes')).toBeNull();
  });

  it('marca as mesas que estão com o relógio aberto num tablet', async () => {
    usePresencaDoRelogio.mockReturnValue(['m2']);
    await montar();
    expect(mesa(2).querySelector('.pm-mesa-titulo')).toHaveTextContent('Relógio');
    expect(mesa(1).querySelector('.pm-mesa-titulo')).not.toHaveTextContent('Relógio');
  });

  it('atualiza sozinho quando mesas, assentos ou inscritos mudam', async () => {
    await montar();
    const { tabelas } = useRealtimeRefresh.mock.calls.at(-1)[0];
    expect(tabelas.map((x) => x.table)).toEqual(expect.arrayContaining([
      'tournament_tables', 'seat_allocations', 'tournament_players', 'time_bank_events',
    ]));
  });
});

describe('equilíbrio', () => {
  it('sugere mover da mesa mais cheia para a mais vazia', async () => {
    await montar();
    expect(document.querySelector('.pm-alertas')).toHaveTextContent('mesa 1');
    expect(document.querySelector('.pm-alertas')).toHaveTextContent('mesa 2');
  });

  it('sugere quebrar quando todos cabem nas outras mesas', async () => {
    await montar({ alocacoes: ALOCACOES.filter((a) => a.id !== 'a4' && a.id !== 'a6') });
    expect(document.querySelector('.pm-alertas')).toHaveTextContent('quebrar a mesa 2');
  });

  it('mesas equilibradas: nenhum alerta', async () => {
    await montar({ alocacoes: ALOCACOES.filter((a) => a.id !== 'a4') });
    expect(document.querySelector('.pm-alertas')).toBeNull();
  });
});

describe('ações no assento', () => {
  it('tocar no jogador abre as ações dele', async () => {
    await montar();
    await userEvent.click(assento(1, /Ana/));
    expect(janela()).toHaveTextContent('Ana');
    expect(janela()).toHaveTextContent('Mesa 1 · assento 1');
    expect(within(janela()).getByRole('button', { name: 'Eliminar' })).toBeInTheDocument();
  });

  it('eliminar confirma e passa pela fila do salão', async () => {
    await montar();
    await userEvent.click(assento(1, /Ana/));
    await userEvent.click(within(janela()).getByRole('button', { name: 'Eliminar' }));
    await waitFor(() => expect(offlineWrite).toHaveBeenCalled());
    expect(confirmar).toHaveBeenCalled();
    expect(offlineWrite.mock.calls[0][0]).toMatchObject({
      kind: 'eliminate', url: '/tournament-players/tp1/eliminate',
    });
  });

  it('torneio KO pergunta quem eliminou', async () => {
    comKo({ exige: true, formato: 'ko' });
    await montar();
    await userEvent.click(assento(1, /Ana/));
    await userEvent.click(within(janela()).getByRole('button', { name: 'Eliminar' }));
    expect(await screen.findByTestId('quem-eliminou')).toHaveTextContent('Ana');
    expect(offlineWrite).not.toHaveBeenCalled();
  });

  it('eliminação em massa: o painel não elimina', async () => {
    comKo({ torneio: { id: 't1', elimination_mode: 'bulk' } });
    await montar();
    await userEvent.click(assento(1, /Ana/));
    expect(within(janela()).queryByRole('button', { name: 'Eliminar' })).toBeNull();
  });

  it('fechar não faz nada', async () => {
    await montar();
    await userEvent.click(assento(1, /Ana/));
    await userEvent.click(within(janela()).getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.patch).not.toHaveBeenCalled();
  });
});

describe('trocar de mesa', () => {
  const trocarAna = async () => {
    await montar();
    await userEvent.click(assento(1, /Ana/));
    await userEvent.click(within(janela()).getByRole('button', { name: 'Trocar de mesa' }));
  };

  it('oferece as outras mesas, com a sugerida marcada', async () => {
    await trocarAna();
    const opcoes = within(janela()).getAllByRole('button', { name: /Mesa \d/ });
    expect(opcoes.map((b) => b.textContent)).toEqual([expect.stringContaining('Mesa 2')]);
    expect(opcoes[0]).toHaveTextContent('Sugerida');
  });

  it('só oferece assento livre que recebe jogador', async () => {
    await trocarAna();
    await userEvent.click(within(janela()).getByRole('button', { name: /Mesa 2/ }));
    const livres = within(janela()).getAllByRole('button', { name: /^Assento/ });
    expect(livres.map((b) => b.textContent)).toEqual(['Assento 3']);
  });

  it('move para o assento escolhido e entrega o bilhete', async () => {
    await trocarAna();
    await userEvent.click(within(janela()).getByRole('button', { name: /Mesa 2/ }));
    await userEvent.click(within(janela()).getByRole('button', { name: 'Assento 3' }));
    await waitFor(() => expect(api.patch).toHaveBeenCalledWith('/allocations/a1', { table_id: 'm2', seat_number: 3 }));
    expect(await screen.findByTestId('bilhete')).toHaveTextContent('Ana|2|3');
  });

  it('recusa do servidor aparece e não fecha nada às cegas', async () => {
    api.patch.mockRejectedValue(Object.assign(new Error('x'), { userMessage: 'Assento ocupado' }));
    await trocarAna();
    await userEvent.click(within(janela()).getByRole('button', { name: /Mesa 2/ }));
    await userEvent.click(within(janela()).getByRole('button', { name: 'Assento 3' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('Assento ocupado')));
    expect(screen.queryByTestId('bilhete')).toBeNull();
  });
});

describe('quem está sem mesa', () => {
  const SEM_MESA = [{ player_id: 'p9', player_name: 'Gil' }];

  it('aparece numa lista própria', async () => {
    await montar({ semMesa: SEM_MESA });
    expect(document.querySelector('.pm-sem-mesa')).toHaveTextContent('Gil');
  });

  it('tocar no assento livre senta quem está sem mesa', async () => {
    await montar({ semMesa: SEM_MESA });
    await userEvent.click(assento(2, /^3/));
    await userEvent.click(within(janela()).getByRole('button', { name: 'Gil' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/allocations/day/d1/manual', { player_id: 'p9', table_id: 'm2', seat_number: 3 },
    ));
    expect(await screen.findByTestId('bilhete')).toBeInTheDocument();
  });

  it('tocar no jogador sem mesa escolhe mesa e assento', async () => {
    await montar({ semMesa: SEM_MESA });
    await userEvent.click(within(document.querySelector('.pm-sem-mesa')).getByRole('button', { name: 'Gil' }));
    await userEvent.click(within(janela()).getByRole('button', { name: /Mesa 2/ }));
    await userEvent.click(within(janela()).getByRole('button', { name: 'Assento 3' }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(
      '/allocations/day/d1/manual', { player_id: 'p9', table_id: 'm2', seat_number: 3 },
    ));
  });

  it('sem ninguém sem mesa, assento livre não abre nada', async () => {
    await montar();
    expect(assento(2, /^3/)).toBeDisabled();
  });
});

describe('eliminados', () => {
  const ELIMINADA = { ...INSCRITOS[0], status: 'eliminated', eliminated_at: '2026-11-08T20:00:00Z' };

  it('lista os últimos e permite desfazer o engano', async () => {
    await montar({
      inscritos: [ELIMINADA, ...INSCRITOS.slice(1)],
      alocacoes: ALOCACOES.filter((a) => a.player_id !== 'p1'),
    });
    const lista = document.querySelector('.pm-eliminados');
    expect(lista).toHaveTextContent('Ana');
    await userEvent.click(within(lista).getByRole('button', { name: /Desfazer/ }));
    await waitFor(() => expect(offlineWrite).toHaveBeenCalled());
    expect(offlineWrite.mock.calls[0][0]).toMatchObject({ kind: 'restore', url: '/tournament-players/tp1/uneliminate' });
  });

  it('eliminação em massa não lista eliminados: o sistema não sabe quem saiu', async () => {
    comKo({ torneio: { id: 't1', elimination_mode: 'bulk' } });
    await montar({ inscritos: [ELIMINADA, ...INSCRITOS.slice(1)] });
    expect(document.querySelector('.pm-eliminados')).toBeNull();
  });
});

describe('falhas', () => {
  it('sem conseguir carregar, diz o motivo', async () => {
    api.get.mockRejectedValue(Object.assign(new Error('x'), { userMessage: 'Dia não encontrado' }));
    render(
      <MemoryRouter initialEntries={['/painel-mesas/d1']}>
        <Routes><Route path="/painel-mesas/:dayId" element={<PainelDeMesas />} /></Routes>
      </MemoryRouter>,
    );
    await act(async () => {});
    expect(await screen.findByRole('alert')).toHaveTextContent('Dia não encontrado');
  });
});
