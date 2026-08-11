import { cachedGet, invalidateCache, invalidateCacheByPrefix, clearCache } from './apiCache';
import { getSelectedStageId } from './stageUtils';

jest.mock('./stageUtils');

/**
 * Cache de leitura com tempo de validade.
 *
 * Dois comportamentos existem por causa de problemas reais e precisam de rede
 * de segurança: a chave é escopada por ETAPA (sem isso, duas etapas colidiam
 * na mesma chave e a tela mostrava dados da etapa anterior) e chamadas
 * simultâneas compartilham uma única ida ao servidor.
 */
describe('apiCache', () => {
  let api;

  const comEtapa = (id) => getSelectedStageId.mockReturnValue(id);

  beforeEach(() => {
    clearCache();
    jest.clearAllMocks();
    comEtapa('etapa-1');
    api = { get: jest.fn((url) => Promise.resolve({ data: `dados de ${url}` })) };
  });

  describe('validade', () => {
    it('a primeira chamada busca no servidor', async () => {
      const r = await cachedGet(api, '/torneios');
      expect(r).toBe('dados de /torneios');
      expect(api.get).toHaveBeenCalledTimes(1);
    });

    it('dentro da validade não busca de novo', async () => {
      await cachedGet(api, '/torneios', 30000);
      await cachedGet(api, '/torneios', 30000);
      expect(api.get).toHaveBeenCalledTimes(1);
    });

    it('validade zero sempre busca', async () => {
      await cachedGet(api, '/torneios', 0);
      await cachedGet(api, '/torneios', 0);
      expect(api.get).toHaveBeenCalledTimes(2);
    });

    it('URLs diferentes não se misturam', async () => {
      await cachedGet(api, '/torneios');
      await cachedGet(api, '/jogadores');
      expect(api.get).toHaveBeenCalledTimes(2);
    });

    it('parâmetros diferentes geram entradas diferentes', async () => {
      await cachedGet(api, '/relatorios', 30000, { mes: 1 });
      await cachedGet(api, '/relatorios', 30000, { mes: 2 });
      expect(api.get).toHaveBeenCalledTimes(2);
    });
  });

  describe('escopo por etapa', () => {
    it('trocar de etapa não reaproveita o cache da anterior', async () => {
      await cachedGet(api, '/torneios', 30000);
      comEtapa('etapa-2');
      await cachedGet(api, '/torneios', 30000);
      // sem o escopo, a segunda etapa veria os dados da primeira
      expect(api.get).toHaveBeenCalledTimes(2);
    });

    it('sem etapa selecionada ainda funciona', async () => {
      comEtapa(null);
      await cachedGet(api, '/torneios', 30000);
      await cachedGet(api, '/torneios', 30000);
      expect(api.get).toHaveBeenCalledTimes(1);
    });
  });

  describe('chamadas simultâneas', () => {
    it('compartilham uma única ida ao servidor', async () => {
      let resolver;
      api.get = jest.fn(() => new Promise((r) => { resolver = r; }));

      const p1 = cachedGet(api, '/torneios');
      const p2 = cachedGet(api, '/torneios');
      resolver({ data: 'ok' });

      expect(await p1).toBe('ok');
      expect(await p2).toBe('ok');
      expect(api.get).toHaveBeenCalledTimes(1);
    });

    it('falha não fica presa para as próximas tentativas', async () => {
      api.get = jest.fn()
        .mockRejectedValueOnce(new Error('rede'))
        .mockResolvedValueOnce({ data: 'ok' });

      await expect(cachedGet(api, '/torneios')).rejects.toThrow('rede');
      // se a promessa em voo nao fosse limpa, a proxima chamada herdaria o erro
      expect(await cachedGet(api, '/torneios')).toBe('ok');
    });
  });

  describe('invalidação', () => {
    it('invalidar força nova busca', async () => {
      await cachedGet(api, '/torneios', 30000);
      invalidateCache('/torneios');
      await cachedGet(api, '/torneios', 30000);
      expect(api.get).toHaveBeenCalledTimes(2);
    });

    it('invalidar uma URL não afeta as outras', async () => {
      await cachedGet(api, '/torneios', 30000);
      await cachedGet(api, '/jogadores', 30000);
      invalidateCache('/torneios');
      await cachedGet(api, '/jogadores', 30000);
      expect(api.get).toHaveBeenCalledTimes(2);   // jogadores veio do cache
    });

    it('invalidar por prefixo atinge as variações', async () => {
      await cachedGet(api, '/relatorios/financeiro', 30000);
      await cachedGet(api, '/relatorios/torneios', 30000);
      invalidateCacheByPrefix('/relatorios');
      await cachedGet(api, '/relatorios/financeiro', 30000);
      expect(api.get).toHaveBeenCalledTimes(3);
    });

    it('limpar apaga tudo (usado ao sair e ao trocar de organização)', async () => {
      await cachedGet(api, '/torneios', 30000);
      await cachedGet(api, '/jogadores', 30000);
      clearCache();
      await cachedGet(api, '/torneios', 30000);
      await cachedGet(api, '/jogadores', 30000);
      expect(api.get).toHaveBeenCalledTimes(4);
    });
  });
});
