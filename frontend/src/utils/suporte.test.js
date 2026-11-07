/**
 * VÍDEOS DE SUPORTE: o idioma certo, o arquivo certo, e nenhum erro quando o
 * bucket ainda não existe.
 */
import {
  arquivosDoVideo,
  carregarCatalogo,
  filtrarVideos,
  formatarDuracao,
  idiomaDoVideo,
  idiomaDosVideos,
  textoNoIdioma,
} from './suporte';

jest.mock('../config/supabase', () => ({
  supabase: {
    storage: {
      from: () => ({
        getPublicUrl: (caminho) => ({ data: { publicUrl: `https://cdn.test/${caminho}` } }),
      }),
    },
  },
}));

const VIDEO = {
  id: 'caixa-registrar-venda',
  area: 'caixa',
  titulo: { 'pt-BR': 'Registrar venda no Caixa', 'en-US': 'Record a sale' },
  descricao: { 'pt-BR': 'Entrada e pagamento em cartão' },
  duracao: { 'pt-BR': 92, 'en-US': 88 },
};

describe('idioma', () => {
  it('aceita o código completo, o curto e a região sem vídeo', () => {
    expect(idiomaDosVideos('en-US')).toBe('en-US');
    expect(idiomaDosVideos('pt')).toBe('pt-BR');
    expect(idiomaDosVideos('es-MX')).toBe('es-ES');
  });

  it('cai no português para idioma desconhecido ou ausente', () => {
    expect(idiomaDosVideos('fr-FR')).toBe('pt-BR');
    expect(idiomaDosVideos(undefined)).toBe('pt-BR');
  });

  it('texto sem tradução usa o português', () => {
    expect(textoNoIdioma(VIDEO.titulo, 'en-US')).toBe('Record a sale');
    expect(textoNoIdioma(VIDEO.titulo, 'es-ES')).toBe('Registrar venda no Caixa');
    expect(textoNoIdioma(undefined, 'es-ES')).toBe('');
  });

  it('vídeo não gravado no idioma abre a versão em português', () => {
    expect(idiomaDoVideo(VIDEO, 'en-US')).toBe('en-US');
    expect(idiomaDoVideo(VIDEO, 'es-ES')).toBe('pt-BR');
  });
});

it('monta os três arquivos na pasta do idioma disponível', () => {
  expect(arquivosDoVideo(VIDEO, 'es-ES')).toEqual({
    video: 'https://cdn.test/pt-BR/caixa-registrar-venda.mp4',
    legenda: 'https://cdn.test/pt-BR/caixa-registrar-venda.vtt',
    capa: 'https://cdn.test/pt-BR/caixa-registrar-venda.jpg',
  });
});

describe('filtrarVideos', () => {
  const outro = { id: 'bar', area: 'bar', titulo: { 'pt-BR': 'Abrir comanda' } };

  it('filtra por área', () => {
    expect(filtrarVideos([VIDEO, outro], { area: 'bar' }, 'pt-BR')).toEqual([outro]);
  });

  it('a busca ignora acento e caixa, e olha a descrição', () => {
    expect(filtrarVideos([VIDEO, outro], { busca: 'CARTAO' }, 'pt-BR')).toEqual([VIDEO]);
  });

  it('sem filtro devolve tudo', () => {
    expect(filtrarVideos([VIDEO, outro], {}, 'pt-BR')).toHaveLength(2);
  });
});

it('formata a duração em minutos e segundos', () => {
  expect(formatarDuracao(92.4)).toBe('1:32');
  expect(formatarDuracao(5)).toBe('0:05');
  expect(formatarDuracao(2400)).toBe('40:00');
  expect(formatarDuracao(undefined)).toBe('');
});

describe('carregarCatalogo', () => {
  afterEach(() => { delete global.fetch; });

  it('devolve o catálogo publicado', async () => {
    const catalogo = { videos: [VIDEO] };
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => catalogo });
    await expect(carregarCatalogo()).resolves.toEqual(catalogo);
    expect(global.fetch.mock.calls[0][0]).toBe('https://cdn.test/catalogo.json');
  });

  it('bucket inexistente vira null, sem erro: o app vai ao ar antes da migração', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 400 });
    await expect(carregarCatalogo()).resolves.toBeNull();
  });

  it('falha de rede e JSON inválido também viram null', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('offline'));
    await expect(carregarCatalogo()).resolves.toBeNull();
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ outra: 'coisa' }) });
    await expect(carregarCatalogo()).resolves.toBeNull();
  });
});
