/**
 * SUPORTE: mostra os vídeos do idioma do app, abre pelo link direto e, sem
 * catálogo publicado, avisa que os vídeos estão a caminho em vez de quebrar.
 */
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Suporte from './Suporte';
import { carregarCatalogo } from '../utils/suporte';

jest.mock('../components/Sidebar', () => () => <div data-testid="sidebar" />);
jest.mock('../components/SkeletonLoader', () => ({ SkeletonBlock: () => <div data-testid="skeleton" /> }));
jest.mock('../utils/suporte', () => ({
  ...jest.requireActual('../utils/suporte'),
  carregarCatalogo: jest.fn(),
  urlDoArquivo: (caminho) => `https://cdn.test/${caminho}`,
  arquivosDoVideo: (video, idioma) => ({
    video: `https://cdn.test/${idioma}/${video.id}.mp4`,
    legenda: `https://cdn.test/${idioma}/${video.id}.vtt`,
    capa: `https://cdn.test/${idioma}/${video.id}.jpg`,
  }),
}));
jest.mock('../config/supabase', () => ({ supabase: {} }));

let mockIdioma = 'pt-BR';
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (chave, padrao) => (typeof padrao === 'string' ? padrao : chave),
    i18n: { language: mockIdioma },
  }),
}));

const CATALOGO = {
  areas: [
    { id: 'caixa', titulo: { 'pt-BR': 'Caixa', 'en-US': 'Cashier' } },
    { id: 'bar', titulo: { 'pt-BR': 'Bar', 'en-US': 'Bar' } },
  ],
  videos: [
    {
      id: 'treinamento-completo', tipo: 'treinamento', titulo: { 'pt-BR': 'Treinamento do sistema' }, duracao: { 'pt-BR': 2400 },
      capitulos: { 'pt-BR': [{ titulo: 'Primeiros passos', inicio: 4.2 }, { titulo: 'Bar', inicio: 1530 }] },
    },
    { id: 'caixa-venda', area: 'caixa', titulo: { 'pt-BR': 'Registrar venda', 'en-US': 'Record a sale' }, duracao: { 'pt-BR': 92, 'en-US': 88 } },
    { id: 'bar-comanda', area: 'bar', titulo: { 'pt-BR': 'Abrir comanda', 'en-US': 'Open a tab' }, duracao: { 'pt-BR': 70, 'en-US': 66 } },
  ],
};

const abrirTela = (rota = '/suporte') => render(
  <MemoryRouter initialEntries={[rota]}><Suporte /></MemoryRouter>,
);

beforeEach(() => {
  mockIdioma = 'pt-BR';
  carregarCatalogo.mockReset();
  carregarCatalogo.mockResolvedValue(CATALOGO);
});

it('sem catálogo publicado, avisa que os vídeos estão a caminho', async () => {
  carregarCatalogo.mockResolvedValue(null);
  abrirTela();
  expect(await screen.findByText('Os vídeos estão a caminho')).toBeInTheDocument();
});

it('separa o treinamento dos vídeos curtos, com a duração', async () => {
  abrirTela();
  expect(await screen.findByText('Treinamento do sistema')).toBeInTheDocument();
  expect(screen.getByText('Registrar venda')).toBeInTheDocument();
  expect(screen.getByText('1:32')).toBeInTheDocument();
  expect(screen.getByText('40:00')).toBeInTheDocument();
});

it('mostra títulos e arquivos no idioma do app', async () => {
  mockIdioma = 'en-US';
  abrirTela('/suporte?video=caixa-venda');
  expect(await screen.findByRole('dialog', { name: 'Record a sale' })).toBeInTheDocument();
  const fonte = document.querySelector('video source');
  expect(fonte).toHaveAttribute('src', 'https://cdn.test/en-US/caixa-venda.mp4');
});

it('filtra por área e pela busca, e diz quando não acha nada', async () => {
  const usuario = userEvent.setup();
  abrirTela();
  await screen.findByText('Registrar venda');

  await usuario.click(screen.getByRole('button', { name: 'Bar' }));
  expect(screen.queryByText('Registrar venda')).not.toBeInTheDocument();
  expect(screen.getByText('Abrir comanda')).toBeInTheDocument();

  await usuario.type(screen.getByRole('searchbox'), 'xyz');
  expect(screen.getByText('Nenhum vídeo encontrado para essa busca.')).toBeInTheDocument();
});

it('abre o player ao clicar e fecha pelo botão', async () => {
  const usuario = userEvent.setup();
  abrirTela();
  await usuario.click(await screen.findByRole('button', { name: /Registrar venda/ }));
  expect(screen.getByRole('dialog', { name: 'Registrar venda' })).toBeInTheDocument();

  await usuario.click(screen.getByRole('button', { name: 'Fechar' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});

it('o treinamento mostra os capítulos, e cada um leva ao seu ponto do vídeo', async () => {
  const usuario = userEvent.setup();
  const tocar = jest.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
  abrirTela('/suporte?video=treinamento-completo');
  const indice = await screen.findByRole('navigation', { name: 'Capítulos' });
  expect(indice).toHaveTextContent('0:04');
  expect(indice).toHaveTextContent('25:30');

  await usuario.click(within(indice).getByRole('button', { name: /Bar/ }));
  expect(document.querySelector('video').currentTime).toBe(1530);
  expect(tocar).toHaveBeenCalled();
  tocar.mockRestore();
});

it('vídeo curto não mostra índice de capítulos', async () => {
  abrirTela('/suporte?video=caixa-venda');
  await screen.findByRole('dialog', { name: 'Registrar venda' });
  expect(screen.queryByRole('navigation', { name: 'Capítulos' })).not.toBeInTheDocument();
});

it('link para um vídeo que não existe mais não abre o player', async () => {
  abrirTela('/suporte?video=removido');
  await screen.findByText('Registrar venda');
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});
