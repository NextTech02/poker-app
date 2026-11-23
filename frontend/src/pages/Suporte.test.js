/**
 * SUPORTE: mostra os vídeos do idioma do app, abre pelo link direto e, sem
 * catálogo publicado, avisa que os vídeos estão a caminho em vez de quebrar.
 */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
jest.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'ana' } }) }));

let mockIdioma = 'pt-BR';
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (chave, padrao, valores) => (typeof padrao === 'string' ? padrao.replace('{{time}}', valores?.time) : chave),
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
  window.localStorage.clear();
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

describe('onde parou', () => {
  const CHAVE = 'aceblind:videosSuporte:ana';
  const parado = (id, posicao, extra = {}) => window.localStorage.setItem(CHAVE, JSON.stringify({
    [id]: { posicao, duracao: 92, idioma: 'pt-BR', concluido: false, em: 1, ...extra },
  }));
  const medir = (video, { tempo, duracao }) => {
    Object.defineProperty(video, 'duration', { configurable: true, value: duracao });
    video.currentTime = tempo;
  };

  it('mostra no cartão onde a pessoa parou e a seção de continuar', async () => {
    parado('caixa-venda', 40);
    abrirTela();
    const secao = (await screen.findByText('Continuar assistindo')).closest('section');
    expect(within(secao).getByText('Você parou em 0:40')).toBeInTheDocument();
  });

  it('sem vídeo pela metade não há seção de continuar', async () => {
    abrirTela();
    await screen.findByText('Registrar venda');
    expect(screen.queryByText('Continuar assistindo')).not.toBeInTheDocument();
  });

  it('o progresso de outra pessoa não aparece', async () => {
    window.localStorage.setItem('aceblind:videosSuporte:bia', JSON.stringify({ 'caixa-venda': { posicao: 40, em: 1 } }));
    abrirTela();
    await screen.findByText('Registrar venda');
    expect(screen.queryByText('Continuar assistindo')).not.toBeInTheDocument();
  });

  it('abre de onde parou e deixa começar do início', async () => {
    parado('caixa-venda', 40);
    const tocar = jest.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue();
    const usuario = userEvent.setup();
    abrirTela('/suporte?video=caixa-venda');
    await screen.findByRole('dialog');
    const video = document.querySelector('video');
    medir(video, { tempo: 0, duracao: 92 });
    fireEvent.loadedMetadata(video);
    expect(video.currentTime).toBe(40);
    expect(screen.getByText('Continuando de 0:40')).toBeInTheDocument();

    await usuario.click(screen.getByRole('button', { name: 'Começar do início' }));
    expect(video.currentTime).toBe(0);
    expect(screen.queryByText('Continuando de 0:40')).not.toBeInTheDocument();
    tocar.mockRestore();
  });

  it('guarda o ponto ao fechar no meio e atualiza o cartão', async () => {
    const usuario = userEvent.setup();
    abrirTela('/suporte?video=caixa-venda');
    await screen.findByRole('dialog');
    const video = document.querySelector('video');
    medir(video, { tempo: 30, duracao: 92 });
    fireEvent.timeUpdate(video);
    video.currentTime = 31;
    fireEvent.timeUpdate(video);
    await usuario.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(JSON.parse(window.localStorage.getItem(CHAVE))['caixa-venda'].posicao).toBe(31);
    expect((await screen.findAllByText('Você parou em 0:31')).length).toBeGreaterThan(0);
  });

  it('abrir e fechar antes de tocar não apaga o ponto guardado', async () => {
    parado('caixa-venda', 40);
    const usuario = userEvent.setup();
    abrirTela('/suporte?video=caixa-venda');
    await screen.findByRole('dialog');
    await usuario.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(JSON.parse(window.localStorage.getItem(CHAVE))['caixa-venda'].posicao).toBe(40);
  });

  it('ao terminar, marca como assistido', async () => {
    abrirTela('/suporte?video=caixa-venda');
    await screen.findByRole('dialog');
    const video = document.querySelector('video');
    medir(video, { tempo: 92, duracao: 92 });
    fireEvent.timeUpdate(video);
    fireEvent.ended(video);
    expect(JSON.parse(window.localStorage.getItem(CHAVE))['caixa-venda']).toMatchObject({ posicao: 0, concluido: true });
    expect(screen.getByText('Assistido')).toBeInTheDocument();
  });

  it('destaca o capítulo em que o treinamento está', async () => {
    abrirTela('/suporte?video=treinamento-completo');
    const indice = await screen.findByRole('navigation', { name: 'Capítulos' });
    const video = document.querySelector('video');
    medir(video, { tempo: 1600, duracao: 2400 });
    fireEvent.timeUpdate(video);
    expect(within(indice).getByRole('button', { name: /Bar/ })).toHaveAttribute('aria-current', 'true');
  });
});

it('se o vídeo não carrega, avisa e deixa tentar de novo', async () => {
  const usuario = userEvent.setup();
  abrirTela('/suporte?video=caixa-venda');
  await screen.findByRole('dialog');
  fireEvent.error(document.querySelector('video source'));
  expect(screen.getByRole('alert')).toHaveTextContent('Não foi possível carregar o vídeo');
  const antes = document.querySelector('video');
  await usuario.click(screen.getByRole('button', { name: 'Tentar de novo' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(document.querySelector('video')).not.toBe(antes);
});

it('soltar o mouse fora depois de arrastar no player não fecha; clicar no fundo fecha', async () => {
  abrirTela('/suporte?video=caixa-venda');
  const dialogo = await screen.findByRole('dialog');
  const fundo = dialogo.parentElement;
  fireEvent.mouseDown(document.querySelector('video'));
  fireEvent.click(fundo);
  expect(screen.getByRole('dialog')).toBeInTheDocument();

  fireEvent.mouseDown(fundo);
  fireEvent.click(fundo);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
});
