/**
 * Aba Ranking da Premiação (ranking de pontos, Manual NSOP).
 *
 * O que estes testes prendem:
 * - a proposta de posições vem preenchida e a direção pode trocar;
 * - oficializar manda TODAS as posições premiadas, e não deixa mandar com
 *   jogador repetido ou posição vazia;
 * - depois de oficializado, nada se edita; reabrir exige motivo;
 * - migração pendente vira um aviso, não um erro de servidor.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RankingTab from './RankingTab';
import api from '../../config/api';
import { useToast } from '../../contexts/ToastContext';

jest.mock('../../config/api', () => ({
  __esModule: true,
  default: { get: jest.fn(), put: jest.fn(), post: jest.fn() },
}));
jest.mock('../../contexts/ToastContext', () => ({ useToast: jest.fn() }));
jest.mock('../../contexts/CurrencyContext', () => ({
  useCurrency: () => ({ formatCurrency: (v) => `S/ ${Number(v).toFixed(2)}` }),
}));
jest.mock('react-i18next', () => {
  const interpolar = (texto, vars = {}) => String(texto).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? ''));
  const t = (chave, padrao, vars) => {
    if (typeof padrao === 'string') return interpolar(padrao, vars);
    if (padrao && typeof padrao === 'object') return interpolar(padrao.defaultValue ?? chave, padrao);
    return chave;
  };
  const traducao = { t, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const SITUACAO = {
  tournament: { id: 't1', name: 'MAIN EVENT', stage_id: 's1' },
  scoring: true,
  buy_in: 500,
  buy_in_custom: null,
  buy_in_default: 500,
  unique_players: 82,
  paid_places: 3,
  min_unique_players: 12,
  players_factor: 1.08822,
  buy_in_factor: 1.05873,
  official_at: null,
  official_by: null,
  reopen_reason: null,
  positions: [
    { position: 1, player_id: 'p1', player_name: 'Juan Julca', points: 115, source: 'premiacao' },
    { position: 2, player_id: 'p2', player_name: 'Jose Gordillo', points: 81, source: 'eliminacao' },
    { position: 3, player_id: null, player_name: null, points: 67, source: null },
  ],
  players: [
    { id: 'p1', name: 'Juan Julca' },
    { id: 'p2', name: 'Jose Gordillo' },
    { id: 'p3', name: 'Axel Llamosas' },
  ],
  warnings: [],
};

const OFICIAL = {
  ...SITUACAO,
  official_at: '2026-11-16T20:00:00Z',
  positions: [
    { position: 1, player_id: 'p1', player_name: 'Juan Julca', points: 115, source: 'oficial' },
    { position: 2, player_id: 'p2', player_name: 'Jose Gordillo', points: 81, source: 'oficial' },
    { position: 3, player_id: 'p3', player_name: 'Axel Llamosas', points: 67, source: 'oficial' },
  ],
};

let toast;

const montar = async (situacao = SITUACAO) => {
  api.get.mockResolvedValue({ data: situacao });
  render(<RankingTab tournamentId="t1" />);
  await screen.findByText('Posições premiadas');
};

const selectDaPosicao = (posicao) => screen.getByRole('combobox', { name: `Jogador da posição ${posicao}` });

beforeEach(() => {
  toast = { success: jest.fn(), error: jest.fn() };
  useToast.mockReturnValue({ toast });
});

it('mostra N, T e o fator, e a proposta já preenchida', async () => {
  await montar();
  expect(screen.getByText('82')).toBeInTheDocument();
  expect(screen.getByText('1.152')).toBeInTheDocument(); // 1,08822 × 1,05873
  expect(selectDaPosicao(1)).toHaveValue('p1');
  expect(selectDaPosicao(2)).toHaveValue('p2');
  expect(selectDaPosicao(3)).toHaveValue('');
  expect(screen.getByText('Premiação')).toBeInTheDocument();
  expect(screen.getByText('Eliminação')).toBeInTheDocument();
});

it('com posição vazia não oficializa', async () => {
  await montar();
  expect(screen.getByRole('button', { name: 'Oficializar resultados' })).toBeDisabled();
});

it('oficializar manda todas as posições premiadas', async () => {
  await montar();
  api.post.mockResolvedValue({ data: OFICIAL });
  await userEvent.selectOptions(selectDaPosicao(3), 'p3');
  await userEvent.click(screen.getByRole('button', { name: 'Oficializar resultados' }));
  await waitFor(() => expect(api.post).toHaveBeenCalled());
  expect(api.post).toHaveBeenCalledWith('/points-ranking/tournaments/t1/official', {
    positions: [
      { position: 1, player_id: 'p1' },
      { position: 2, player_id: 'p2' },
      { position: 3, player_id: 'p3' },
    ],
  });
  expect(await screen.findByText(/Oficializado em/)).toBeInTheDocument();
  expect(toast.success).toHaveBeenCalled();
});

it('jogador repetido bloqueia e avisa', async () => {
  await montar();
  await userEvent.selectOptions(selectDaPosicao(3), 'p1');
  expect(screen.getByText('O mesmo jogador está em duas posições.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Oficializar resultados' })).toBeDisabled();
});

it('a recusa do servidor aparece com a frase dele', async () => {
  await montar();
  api.post.mockRejectedValue({ userMessage: 'Falta o jogador da posição 3.' });
  await userEvent.selectOptions(selectDaPosicao(3), 'p3');
  await userEvent.click(screen.getByRole('button', { name: 'Oficializar resultados' }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Falta o jogador da posição 3.'));
});

it('desmarcar "pontuável" grava na hora', async () => {
  await montar();
  api.put.mockResolvedValue({ data: { ...SITUACAO, scoring: false } });
  await userEvent.click(screen.getByRole('checkbox'));
  expect(api.put).toHaveBeenCalledWith('/points-ranking/tournaments/t1', { scoring: false });
});

it('buy-in vazio volta ao padrão (manda null)', async () => {
  await montar({ ...SITUACAO, buy_in_custom: 700, buy_in: 700 });
  api.put.mockResolvedValue({ data: SITUACAO });
  const campo = screen.getByLabelText('Buy-in oficial (B), sem a taxa');
  expect(campo).toHaveValue(700);
  await userEvent.clear(campo);
  await userEvent.click(screen.getByRole('button', { name: 'Salvar' }));
  expect(api.put).toHaveBeenCalledWith('/points-ranking/tournaments/t1', { buy_in: null });
  expect(screen.getByText(/Vazio = S\/ 500.00/)).toBeInTheDocument();
});

it('oficializado: nada se edita e reabrir exige motivo', async () => {
  await montar(OFICIAL);
  expect(screen.queryByRole('combobox')).toBeNull();
  expect(screen.getByRole('checkbox')).toBeDisabled();
  expect(screen.getByText('Axel Llamosas')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Reabrir para corrigir' }));
  const confirmar = screen.getByRole('button', { name: 'Reabrir' });
  expect(confirmar).toBeDisabled();
  api.post.mockResolvedValue({ data: { ...SITUACAO, reopen_reason: '2º e 3º trocados' } });
  await userEvent.type(screen.getByLabelText('Motivo da correção (fica registrado)'), '2º e 3º trocados');
  await userEvent.click(confirmar);
  expect(api.post).toHaveBeenCalledWith('/points-ranking/tournaments/t1/reopen', { reason: '2º e 3º trocados' });
  expect(await screen.findByText('Última correção: 2º e 3º trocados')).toBeInTheDocument();
});

it('cada aviso do servidor vira uma linha (traduzida pelo código)', async () => {
  // Sem tradução carregada, o padrão é o próprio código do aviso.
  await montar({ ...SITUACAO, warnings: ['poucos_jogadores', 'torneio_por_equipes'] });
  const avisos = Array.from(document.querySelectorAll('.rk-avisos li')).map((li) => li.textContent);
  expect(avisos).toEqual(['poucos_jogadores', 'torneio_por_equipes']);
});

it('migração pendente vira aviso, não erro', async () => {
  api.get.mockRejectedValue({ response: { data: { detail: { code: 'ranking_migracao_pendente' } } } });
  render(<RankingTab tournamentId="t1" />);
  expect(await screen.findByText(/ainda não está ativo neste servidor/)).toBeInTheDocument();
  expect(toast.error).not.toHaveBeenCalled();
  expect(api.get).toHaveBeenCalledWith('/points-ranking/tournaments/t1', { _silentError: true });
});
