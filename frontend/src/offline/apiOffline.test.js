/**
 * Camada de acesso com fallback offline.
 *
 * A distinção que sustenta tudo: erro de REDE ≠ erro do SERVIDOR.
 *
 * - Sem `err.response`, a requisição não chegou. O buy-in aconteceu no salão,
 *   o dinheiro está na gaveta e o operador precisa seguir: aplica na réplica,
 *   enfileira e devolve uma resposta sintética para a tela imprimir o ticket.
 * - Com resposta HTTP (400/409/422), o servidor DECIDIU recusar — "jogador já
 *   inscrito", "dia lotado". Enfileirar isso reenviaria eternamente uma
 *   operação que nunca vai passar, e esconderia do operador o motivo real.
 */
import { offlineWrite, offlineRead } from './apiOffline';
import api from '../config/api';
import { isOnline, markOffline, markOnline } from './connectivity';
import { enqueue } from './queue';

jest.mock('../config/api', () => ({
  __esModule: true,
  default: { request: jest.fn(), get: jest.fn() },
}));
jest.mock('./connectivity', () => ({
  isOnline: jest.fn(),
  markOffline: jest.fn(),
  markOnline: jest.fn(),
}));
jest.mock('./queue', () => ({ enqueue: jest.fn() }));

const erroDeRede = () => Object.assign(new Error('Network Error'), { response: undefined });
const erroDoServidor = (status, detail) =>
  Object.assign(new Error('Request failed'), { response: { status, data: { detail } } });

beforeEach(() => {
  // O CRA liga `resetMocks`, então as implementações são redefinidas a cada teste.
  isOnline.mockReturnValue(true);
  api.request.mockResolvedValue({ data: { id: 'servidor-1' } });
  api.get.mockResolvedValue({ data: [{ id: 'p1' }] });
  enqueue.mockResolvedValue({ id: 'fila-1' });
});

const escrita = (extra = {}) => ({
  method: 'post',
  url: '/tournament-players',
  body: { player_id: 'p1' },
  kind: 'register',
  ...extra,
});

describe('escrita com o servidor disponível', () => {
  it('vai ao backend e devolve o dado real', async () => {
    const r = await offlineWrite(escrita());
    expect(r).toEqual({ data: { id: 'servidor-1' }, offline: false });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('confirma a conectividade no sucesso', async () => {
    await offlineWrite(escrita());
    expect(markOnline).toHaveBeenCalled();
  });

  it('não aplica na réplica quando o servidor respondeu', async () => {
    // Aplicar dos dois lados dobraria o valor na tela até o próximo refresh.
    const aplicar = jest.fn();
    await offlineWrite(escrita({ applyLocal: aplicar }));
    expect(aplicar).not.toHaveBeenCalled();
  });

  it('repassa método, url, corpo e parâmetros', async () => {
    await offlineWrite(
      escrita({ method: 'patch', url: '/x/1', params: { a: 1 } })
    );
    expect(api.request).toHaveBeenCalledWith({
      method: 'patch',
      url: '/x/1',
      data: { player_id: 'p1' },
      params: { a: 1 },
    });
  });
});

describe('escrita com o servidor inalcançável', () => {
  it('erro de rede cai para o modo offline', async () => {
    api.request.mockRejectedValue(erroDeRede());
    const r = await offlineWrite(escrita({ synthetic: { id: 'local-1' } }));
    expect(r).toEqual({ data: { id: 'local-1' }, offline: true });
    expect(enqueue).toHaveBeenCalled();
    expect(markOffline).toHaveBeenCalled();
  });

  it('já estando offline, nem tenta a rede', async () => {
    isOnline.mockReturnValue(false);
    await offlineWrite(escrita());
    expect(api.request).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalled();
  });

  it('aplica a mutação na réplica antes de enfileirar', async () => {
    // É o que faz a tela mostrar o jogador já registrado e o caixa com o
    // valor certo, sem esperar o sync.
    isOnline.mockReturnValue(false);
    const ordem = [];
    const aplicar = jest.fn(async () => ordem.push('replica'));
    enqueue.mockImplementation(async () => ordem.push('fila'));
    await offlineWrite(escrita({ applyLocal: aplicar }));
    expect(ordem).toEqual(['replica', 'fila']);
  });

  it('falha ao aplicar na réplica não impede o enfileiramento', async () => {
    // A réplica é só o display; a FILA é o que garante que a operação chega
    // ao servidor. Perder a fila perderia o dinheiro.
    isOnline.mockReturnValue(false);
    const aplicar = jest.fn().mockRejectedValue(new Error('IndexedDB cheio'));
    const r = await offlineWrite(escrita({ applyLocal: aplicar }));
    expect(enqueue).toHaveBeenCalled();
    expect(r.offline).toBe(true);
  });

  it('a entrada da fila carrega tudo que o replay precisa', async () => {
    isOnline.mockReturnValue(false);
    await offlineWrite(
      escrita({
        deps: ['fila-0'],
        clientEntityIds: { tournament_players: 'tp-local-1' },
        clientMutationId: 'mut-1',
        meta: { playerName: 'Fulano' },
      })
    );
    expect(enqueue).toHaveBeenCalledWith({
      kind: 'register',
      method: 'post',
      url: '/tournament-players',
      body: { player_id: 'p1' },
      params: undefined,
      deps: ['fila-0'],
      clientEntityIds: { tournament_players: 'tp-local-1' },
      clientMutationId: 'mut-1',
      meta: { playerName: 'Fulano' },
    });
  });

  it('sem resposta sintética devolve um marcador de offline', async () => {
    isOnline.mockReturnValue(false);
    const r = await offlineWrite(escrita());
    expect(r.data).toEqual({ offline: true });
  });

  it('resposta sintética nula é respeitada', async () => {
    // `??` e não `||`: uma resposta sintética `null` ou `0` é intencional.
    isOnline.mockReturnValue(false);
    const r = await offlineWrite(escrita({ synthetic: null }));
    expect(r.data).toEqual({ offline: true });
  });
});

describe('escrita recusada pelo servidor', () => {
  it.each([400, 401, 403, 409, 422, 500])(
    'HTTP %i sobe para a tela em vez de virar fila',
    async (status) => {
      // Enfileirar uma recusa reenviaria para sempre algo que nunca passa — e
      // o operador nunca saberia por que o jogador não entrou.
      api.request.mockRejectedValue(erroDoServidor(status, 'Jogador já inscrito'));
      await expect(offlineWrite(escrita())).rejects.toMatchObject({
        response: { status },
      });
      expect(enqueue).not.toHaveBeenCalled();
    }
  );

  it('não marca como offline numa recusa do servidor', async () => {
    // O servidor respondeu: a rede está boa. Marcar offline faria as próximas
    // operações irem para a fila sem necessidade.
    api.request.mockRejectedValue(erroDoServidor(409, 'assento ocupado'));
    await expect(offlineWrite(escrita())).rejects.toBeTruthy();
    expect(markOffline).not.toHaveBeenCalled();
  });

  it('não aplica na réplica quando o servidor recusou', async () => {
    const aplicar = jest.fn();
    api.request.mockRejectedValue(erroDoServidor(422, 'inválido'));
    await expect(offlineWrite(escrita({ applyLocal: aplicar }))).rejects.toBeTruthy();
    expect(aplicar).not.toHaveBeenCalled();
  });
});

describe('leitura', () => {
  it('online busca no backend', async () => {
    const dados = await offlineRead('/players', { params: { search: 'fu' } });
    expect(dados).toEqual([{ id: 'p1' }]);
    expect(api.get).toHaveBeenCalledWith('/players', { params: { search: 'fu' } });
  });

  it('offline serve da réplica local', async () => {
    // É o que faz a tela abrir com os últimos dados vistos em vez de vazia.
    isOnline.mockReturnValue(false);
    const daReplica = jest.fn().mockResolvedValue([{ id: 'local' }]);
    expect(await offlineRead('/players', { fromReplica: daReplica })).toEqual([
      { id: 'local' },
    ]);
    expect(api.get).not.toHaveBeenCalled();
  });

  it('erro de rede cai para a réplica', async () => {
    api.get.mockRejectedValue(erroDeRede());
    const daReplica = jest.fn().mockResolvedValue([{ id: 'local' }]);
    expect(await offlineRead('/players', { fromReplica: daReplica })).toEqual([
      { id: 'local' },
    ]);
    expect(markOffline).toHaveBeenCalled();
  });

  it('erro do servidor sobe para a tela', async () => {
    // 403 numa leitura é problema de permissão; servir a réplica esconderia
    // que o operador perdeu o acesso.
    api.get.mockRejectedValue(erroDoServidor(403, 'sem permissão'));
    await expect(offlineRead('/players')).rejects.toMatchObject({
      response: { status: 403 },
    });
  });

  it('offline sem réplica usa o valor de fallback', async () => {
    isOnline.mockReturnValue(false);
    expect(await offlineRead('/players', { fallback: [] })).toEqual([]);
  });

  it('offline sem réplica nem fallback devolve null', async () => {
    isOnline.mockReturnValue(false);
    expect(await offlineRead('/players')).toBeNull();
  });

  it('confirma a conectividade no sucesso', async () => {
    await offlineRead('/players');
    expect(markOnline).toHaveBeenCalled();
  });
});
