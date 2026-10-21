/**
 * Telão de MESAS E ASSENTOS (pedido do NSOP para o dia final).
 *
 * Numa TV do salão, pelo código do dia, cada jogador procura o próprio nome
 * e vê mesa e assento. Sem login. O que importa: a lista em ordem alfabética,
 * as fichas só de quem se classificou, os rótulos no idioma do CLUBE (a TV
 * não tem usuário) e não apagar a lista quando a rede cai.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import TvMesas from './TvMesas';
import api from '../config/api';

jest.mock('../config/api', () => ({ __esModule: true, default: { get: jest.fn() } }));
jest.mock('react-i18next', () => {
  const traducao = { t: (chave) => chave, i18n: { language: 'pt-BR' } };
  return { useTranslation: () => traducao };
});

const QUADRO = {
  day_id: 'd-final',
  tournament_name: 'Main Event NSOP',
  day_name: 'Día Final',
  organization_name: 'NSOP',
  language: 'es-ES',
  seats: [
    { name: 'Humberto Farfan', table_number: 2, seat_number: 5, chips: 763800 },
    { name: 'Ana Paredes', table_number: 1, seat_number: 7, chips: null },
    { name: 'Christian Maguiña', table_number: 1, seat_number: 3, chips: 180300 },
  ],
};

const responder = (seating) => {
  api.get.mockImplementation((url) => {
    if (url === '/public/tv/ABC234/seating') {
      return seating instanceof Error ? Promise.reject(seating) : Promise.resolve({ data: seating });
    }
    if (url === '/tournament-days/d-final') return Promise.resolve({ data: { id: 'd-final' } });
    return Promise.resolve({ data: {} });
  });
};

const montar = () => render(
  <MemoryRouter initialEntries={['/tv/ABC234/mesas']}>
    <Routes>
      <Route path="/tv/:code/mesas" element={<TvMesas />} />
    </Routes>
  </MemoryRouter>,
);

const nomesNaTela = () => Array.from(document.querySelectorAll('.tvm-row:not(.tvm-row--head) .tvm-name'))
  .map((el) => el.textContent);

afterEach(() => jest.useRealTimers());

it('lista em ordem alfabética com mesa e assento, sem login', async () => {
  responder(QUADRO);
  montar();
  await screen.findByText('Main Event NSOP');
  expect(nomesNaTela()).toEqual(['Ana Paredes', 'Christian Maguiña', 'Humberto Farfan']);
  const linha = screen.getByText('Christian Maguiña').closest('.tvm-row');
  expect(Array.from(linha.querySelectorAll('.tvm-num')).map((el) => el.textContent)).toEqual(['1', '3']);
  // Rota pública: a TV não manda token.
  expect(api.get).toHaveBeenCalledWith('/public/tv/ABC234/seating', expect.objectContaining({ _public: true }));
});

it('rótulos no idioma do clube e fichas só de quem se classificou', async () => {
  responder(QUADRO);
  montar();
  await screen.findByText('MESAS Y ASIENTOS');
  expect(screen.getAllByText('ASIENTO').length).toBeGreaterThan(0);
  expect(screen.getByText('Humberto Farfan').closest('.tvm-row').querySelector('.tvm-chips'))
    .toHaveTextContent('763,800');
  expect(screen.getByText('Ana Paredes').closest('.tvm-row').querySelector('.tvm-chips'))
    .toHaveTextContent('');
});

it('ninguém classificado: sem coluna de fichas', async () => {
  responder({ ...QUADRO, seats: QUADRO.seats.map((s) => ({ ...s, chips: null })) });
  montar();
  await screen.findByText('Ana Paredes');
  expect(document.querySelector('.tvm-chips')).toBeNull();
});

it('sem sorteio ainda: avisa em vez de mostrar uma tela vazia', async () => {
  responder({ ...QUADRO, seats: [] });
  montar();
  expect(await screen.findByText('Los asientos aún no fueron sorteados')).toBeInTheDocument();
});

it('código inválido: diz isso e oferece digitar outro', async () => {
  responder(Object.assign(new Error('404'), { response: { status: 404 } }));
  montar();
  expect(await screen.findByText('tv.invalid')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'tv.backToCode' })).toHaveAttribute('href', '/tv');
});

it('queda de rede depois de carregar mantém a última lista', async () => {
  jest.useFakeTimers();
  responder(QUADRO);
  montar();
  await screen.findByText('Ana Paredes');
  responder(new Error('Network Error'));
  await act(async () => { jest.advanceTimersByTime(20000); });
  await waitFor(() => expect(screen.getByText('Sin conexión — mostrando la última lista')).toBeInTheDocument());
  expect(nomesNaTela()).toHaveLength(3);
});

it('mais jogadores do que cabe: páginas que se alternam', async () => {
  jest.useFakeTimers();
  const muitos = Array.from({ length: 60 }, (_, i) => ({
    name: `Jogador ${String(i).padStart(2, '0')}`, table_number: 1 + Math.floor(i / 9), seat_number: 1 + (i % 9), chips: null,
  }));
  responder({ ...QUADRO, seats: muitos });
  montar();
  await screen.findByText('Página 1/2');
  expect(nomesNaTela()[0]).toBe('Jogador 00');
  await act(async () => { jest.advanceTimersByTime(12000); });
  expect(screen.getByText('Página 2/2')).toBeInTheDocument();
  expect(nomesNaTela()[0]).toBe('Jogador 45');
});
