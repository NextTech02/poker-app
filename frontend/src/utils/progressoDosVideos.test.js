/**
 * ONDE PAROU: por usuário, proporcional entre idiomas, e sem derrubar a tela
 * quando o navegador não deixa guardar.
 */
import {
  capituloEm, gravarProgresso, lerProgresso, pontoDeRetomada, situacaoDoVideo, videosEmAndamento, zerarPosicao,
} from './progressoDosVideos';

const ponto = (posicao, duracao = 100, extra = {}) => ({ posicao, duracao, idioma: 'pt-BR', ...extra });

beforeEach(() => window.localStorage.clear());

it('guarda e lê o ponto de cada usuário separado', () => {
  gravarProgresso('ana', 'bar', ponto(40));
  expect(lerProgresso('ana').bar.posicao).toBe(40);
  expect(lerProgresso('bia')).toEqual({});
});

it('abrir e fechar logo no começo não conta como parado', () => {
  gravarProgresso('ana', 'bar', ponto(3));
  expect(lerProgresso('ana')).toEqual({});
});

it('chegar ao fim marca como assistido e volta para o início', () => {
  gravarProgresso('ana', 'bar', ponto(97));
  expect(lerProgresso('ana').bar).toMatchObject({ posicao: 0, concluido: true });
});

it('no treinamento de uma hora, faltando dois minutos ainda não é o fim', () => {
  gravarProgresso('ana', 'treino', ponto(3480, 3600));
  expect(lerProgresso('ana').treino).toMatchObject({ posicao: 3480, concluido: false });
});

it('rever um pedaço não tira o assistido', () => {
  gravarProgresso('ana', 'bar', ponto(100, 100, { terminou: true }));
  gravarProgresso('ana', 'bar', ponto(30));
  expect(lerProgresso('ana').bar).toMatchObject({ posicao: 30, concluido: true });
});

it('recomeçar zera o ponto e mantém o assistido', () => {
  gravarProgresso('ana', 'bar', ponto(100, 100, { terminou: true }));
  gravarProgresso('ana', 'bar', ponto(30));
  zerarPosicao('ana', 'bar');
  expect(lerProgresso('ana').bar).toMatchObject({ posicao: 0, concluido: true });
});

it('troca de idioma volta ao ponto proporcional', () => {
  const registro = ponto(50, 100);
  expect(pontoDeRetomada(registro, 'pt-BR', 100)).toBe(50);
  expect(pontoDeRetomada(registro, 'es-ES', 120)).toBe(60);
});

it('o cartão recebe a fração da barra e o ponto', () => {
  expect(situacaoDoVideo(ponto(25), 'pt-BR', 100)).toEqual({ parouEm: 25, fracao: 0.25, assistido: false });
  expect(situacaoDoVideo(undefined, 'pt-BR', 100)).toEqual({ parouEm: 0, fracao: 0, assistido: false });
});

it('lista os inacabados do mais recente para o mais antigo', () => {
  const progresso = {
    a: { posicao: 20, em: 1 }, b: { posicao: 20, em: 2 }, c: { posicao: 20, em: 3, concluido: true }, d: { posicao: 0, em: 4 },
  };
  expect(videosEmAndamento(['a', 'b', 'c', 'd', 'e'].map((id) => ({ id })), progresso).map((v) => v.id)).toEqual(['b', 'a']);
});

it('acha o capítulo do ponto atual', () => {
  const capitulos = [{ inicio: 4 }, { inicio: 100 }];
  expect(capituloEm(capitulos, 0)).toBe(-1);
  expect(capituloEm(capitulos, 50)).toBe(0);
  expect(capituloEm(capitulos, 100)).toBe(1);
  expect(capituloEm(undefined, 10)).toBe(-1);
});

it('storage bloqueado ou corrompido não quebra', () => {
  window.localStorage.setItem('aceblind:videosSuporte:ana', '{ruim');
  expect(lerProgresso('ana')).toEqual({});
  const trava = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('cheio'); });
  expect(gravarProgresso('ana', 'bar', ponto(40)).bar.posicao).toBe(40);
  trava.mockRestore();
});
