/**
 * Página do ranking de pontos (Manual NSOP): etapa, temporadas e regras.
 *
 * Prende: a classificação mostra a posição compartilhada ("1="), os pontos
 * por torneio e o descarte da temporada; os torneios pontuáveis ainda não
 * oficializados aparecem com link para oficializar; a temporada é criada com
 * as etapas marcadas; as regras salvam como número; e a migração pendente
 * vira um aviso único.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import RankingPontos from './RankingPontos';
import api from '../config/api';
import { useToast } from '../contexts/ToastContext';
import { exportSections } from '../utils/reportExport';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), put: jest.fn(), post: jest.fn(), delete: jest.fn() },
}));
jest.mock('../components/Sidebar', () => () => <nav data-testid="sidebar" />);
jest.mock('../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../contexts/StageContext', () => ({ useStage: () => ({ selectedStage: { id: 's1' } }) }));
let mockMoeda = 'PEN';
jest.mock('../contexts/CurrencyContext', () => ({ useCurrency: () => ({ currency: mockMoeda }) }));
jest.mock('../utils/reportExport', () => ({ exportSections: jest.fn() }));
jest.mock('react-i18next', () => {
  const interpolar = (texto, vars = {}) => String(texto).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ''));
  const t = (chave, padrao, vars) => (typeof padrao === 'string' ? interpolar(padrao, vars) : chave);
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const ETAPAS = [{ id: 's1', name: 'NSOP AREQUIPA' }, { id: 's2', name: 'NSOP CUSCO' }];
const REGRAS = {
  pontos_base: 100, jogadores_referencia: 50, jogadores_expoente: 0.17, jogadores_fator_minimo: 0.75,
  jogadores_fator_maximo: 1.5, buy_in_referencia: 350, buy_in_expoente: 0.16, buy_in_fator_minimo: 0.75,
  buy_in_fator_maximo: 1.4, minimo_de_jogadores: 12, personalizadas: false,
};
const CLASSIFICACAO_DA_ETAPA = {
  stage: { id: 's1', name: 'NSOP AREQUIPA' },
  best_results: null,
  tournaments: [
    { id: 't1', name: 'DEEPSTACK', date: '2026-10-01' },
    { id: 't2', name: 'MAIN EVENT', date: '2026-10-03' },
  ],
  pending: [{ id: 't3', name: 'TURBO' }],
  standings: [
    { position: 1, tied: true, player_id: 'p1', player_name: 'Carla', total: 145, events: 2, counted: 2,
      firsts: 1, seconds: 1, thirds: 0, final_tables: 2, best: 85, by_tournament: { t1: 85, t2: 60 }, discarded: [] },
    { position: 1, tied: true, player_id: 'p2', player_name: 'Bruno', total: 145, events: 2, counted: 2,
      firsts: 1, seconds: 1, thirds: 0, final_tables: 2, best: 85, by_tournament: { t1: 60, t2: 85 }, discarded: [] },
    { position: 3, tied: false, player_id: 'p3', player_name: 'Alba', total: 49, events: 1, counted: 1,
      firsts: 0, seconds: 0, thirds: 1, final_tables: 1, best: 49, by_tournament: { t2: 49 }, discarded: [] },
  ],
};

let toast;

const responder = ({ temporadas = [], regras = REGRAS, etapa = CLASSIFICACAO_DA_ETAPA, temporada } = {}) => {
  api.get.mockImplementation((url) => {
    if (url === '/stages') return Promise.resolve({ data: ETAPAS });
    if (url === '/points-ranking/rules') {
      return regras instanceof Error ? Promise.reject(regras) : Promise.resolve({ data: regras });
    }
    if (url.startsWith('/points-ranking/stages/')) return Promise.resolve({ data: etapa });
    if (url === '/points-ranking/seasons') return Promise.resolve({ data: temporadas });
    if (url.endsWith('/standings')) return Promise.resolve({ data: temporada });
    return Promise.resolve({ data: [] });
  });
};

const montar = async (opcoes) => {
  responder(opcoes);
  render(<MemoryRouter><RankingPontos /></MemoryRouter>);
  await waitFor(() => expect(api.get).toHaveBeenCalledWith('/stages'));
};

const aba = (nome) => userEvent.click(screen.getByRole('tab', { name: nome }));

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn() };
  useToast.mockReturnValue({ toast });
  exportSections.mockResolvedValue(undefined);
});

describe('etapa', () => {
  it('abre na etapa selecionada e mostra a classificação com empate compartilhado', async () => {
    await montar();
    await screen.findByText('Carla');
    expect(api.get).toHaveBeenCalledWith('/points-ranking/stages/s1');
    const linhas = Array.from(document.querySelectorAll('.rk-tabela--classificacao tbody tr'));
    expect(linhas.map((tr) => tr.children[0].textContent)).toEqual(['1=', '1=', '3']);
    const carla = linhas[0];
    expect(within(carla).getByText('145')).toBeInTheDocument();
    // Colunas na ordem dos torneios: DEEPSTACK, MAIN EVENT.
    expect([carla.children[2].textContent, carla.children[3].textContent]).toEqual(['85', '60']);
  });

  it('torneio pontuável ainda não oficializado aparece com o link para oficializar', async () => {
    await montar();
    const link = await screen.findByRole('link', { name: 'TURBO' });
    expect(link).toHaveAttribute('href', '/premiacao/t3?aba=ranking');
  });

  it('trocar de etapa recarrega', async () => {
    await montar();
    await screen.findByText('Carla');
    await userEvent.selectOptions(screen.getByLabelText('Etapa'), 's2');
    await waitFor(() => expect(api.get).toHaveBeenCalledWith('/points-ranking/stages/s2'));
  });

  it('exporta com uma coluna por torneio e o "=" do empate', async () => {
    await montar();
    await screen.findByText('Carla');
    await userEvent.click(screen.getByRole('button', { name: 'Excel' }));
    const [[secoes, opcoes]] = exportSections.mock.calls;
    expect(opcoes.format).toBe('xlsx');
    const [secao] = secoes;
    expect(secao.columns.map((c) => c.label).slice(0, 4)).toEqual(['Posição', 'Jogador', 'DEEPSTACK', 'MAIN EVENT']);
    expect(secao.rows.map((r) => [r.posicao, r['t:t1'], r.total])).toEqual([['1=', 85, 145], ['1=', 60, 145], ['3', null, 49]]);
  });

  it('sem resultado oficializado, diz como chegar lá', async () => {
    await montar({ etapa: { ...CLASSIFICACAO_DA_ETAPA, standings: [], pending: [] } });
    expect(await screen.findByText('Nenhum resultado oficializado ainda')).toBeInTheDocument();
  });
});

describe('temporadas', () => {
  it('cria a temporada com as etapas marcadas e os melhores resultados', async () => {
    await montar();
    await aba('Temporadas');
    expect(await screen.findByText('Nenhuma temporada criada')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Nova temporada' }));
    await userEvent.type(screen.getByLabelText('Nome'), 'NSOP 2026');
    await userEvent.click(screen.getByRole('checkbox', { name: 'NSOP AREQUIPA' }));
    api.post.mockResolvedValue({ data: { id: 'temp1', name: 'NSOP 2026', best_results: 8, stage_ids: ['s1'] } });
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(api.post).toHaveBeenCalledWith('/points-ranking/seasons', {
      name: 'NSOP 2026', best_results: 8, stage_ids: ['s1'],
    });
  });

  it('mostra o descarte e os resultados contados', async () => {
    await montar({
      temporadas: [{ id: 'temp1', name: 'NSOP 2026', best_results: 1, stage_ids: ['s1'] }],
      temporada: {
        ...CLASSIFICACAO_DA_ETAPA, pending: [], best_results: 1,
        standings: [{ ...CLASSIFICACAO_DA_ETAPA.standings[0], total: 85, counted: 1, discarded: ['t2'], tied: false }],
      },
    });
    await aba('Temporadas');
    await screen.findByText('Carla');
    const linha = document.querySelector('.rk-tabela--classificacao tbody tr');
    expect(linha.querySelector('.rk-descartado')).toHaveTextContent('60');
    expect(within(linha).getByText('1/2')).toBeInTheDocument();
  });
});

describe('regras', () => {
  it('mostra a fórmula com os valores do clube e salva como número', async () => {
    await montar();
    await aba('Regras');
    expect(await screen.findByText(/Pontos = \(100 ÷ √posição\)/)).toBeInTheDocument();
    const minimo = screen.getByLabelText('Mínimo de jogadores únicos para pontuar');
    await userEvent.clear(minimo);
    await userEvent.type(minimo, '16');
    api.put.mockResolvedValue({ data: { ...REGRAS, minimo_de_jogadores: 16, personalizadas: true } });
    await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    const [[url, corpo]] = api.put.mock.calls;
    expect(url).toBe('/points-ranking/rules');
    expect(corpo.minimo_de_jogadores).toBe(16);
    expect(corpo.buy_in_referencia).toBe(350);
  });
});

it('migração pendente: um aviso só, no lugar das abas', async () => {
  const pendente = Object.assign(new Error('503'), {
    response: { data: { detail: { code: 'ranking_migracao_pendente' } } },
  });
  await montar({ regras: pendente });
  expect(await screen.findByText(/ainda não está ativo neste servidor/)).toBeInTheDocument();
  expect(screen.queryByRole('tab')).toBeNull();
});

describe('regras em outra moeda', () => {
  afterEach(() => { mockMoeda = 'PEN'; });

  it('o clube que não é em soles é avisado do buy-in de referência', async () => {
    mockMoeda = 'USD';
    await montar();
    await aba('Regras');
    expect(await screen.findByRole('status')).toHaveTextContent('padrão (350) está em soles e o clube usa USD');
  });

  it.each([
    ['em soles', 'PEN', REGRAS],
    ['com regras próprias', 'USD', { ...REGRAS, personalizadas: true }],
  ])('clube %s não vê o aviso', async (_, moeda, regras) => {
    mockMoeda = moeda;
    await montar({ regras });
    await aba('Regras');
    expect(await screen.findByLabelText('Buy-in de referência')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('a tela não cita o manual de um clube para os outros', async () => {
    await montar({ regras: REGRAS });
    await aba('Regras');
    expect(await screen.findByText('Valores sugeridos. Ajuste e anuncie antes da temporada.')).toBeInTheDocument();
  });
});
