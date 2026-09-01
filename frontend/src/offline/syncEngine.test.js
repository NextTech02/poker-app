/**
 * Motor de sincronização: reenvia a fila ao servidor quando a rede volta.
 *
 * A regra que decide tudo é o que fazer com cada resultado por operação:
 *
 * - `applied` / `duplicate` → sai da fila. "duplicate" significa que o
 *   servidor já tinha aplicado (o ack anterior se perdeu); tratar como erro
 *   deixaria a operação presa para sempre.
 * - `conflict` → sai do caminho de retry e vai para revisão. Um registro
 *   duplicado ou um assento tomado não passa por insistência; alguém precisa
 *   decidir. Retentar cegamente esconderia o problema do operador.
 * - `error` → continua pendente. Falha transitória merece nova tentativa.
 *
 * E o mais importante: erro de REDE não pode limpar a fila. Se o flush
 * apagasse as operações ao falhar, o evento inteiro sumiria.
 */
import { flush, startSyncEngine, stopSyncEngine } from './syncEngine';
import api from '../config/api';
import { CAIXA_MUDOU } from '../utils/eventosDoCaixa';
import { isOnline, markOffline, markOnline, subscribe } from './connectivity';
import {
  getPendingMutations,
  updateMutation,
  removeMutation,
  addConflict,
} from './db';

jest.mock('../config/api', () => ({ __esModule: true, default: { post: jest.fn() } }));
jest.mock('./connectivity', () => ({
  isOnline: jest.fn(),
  markOffline: jest.fn(),
  markOnline: jest.fn(),
  subscribe: jest.fn(),
}));
jest.mock('./db', () => ({
  getPendingMutations: jest.fn(),
  updateMutation: jest.fn(),
  removeMutation: jest.fn(),
  addConflict: jest.fn(),
}));
jest.mock('./queue', () => ({ notifyQueueChanged: jest.fn() }));

const mutacao = (id, extra = {}) => ({
  id,
  clientMutationId: `mut-${id}`,
  kind: 'register',
  method: 'post',
  url: '/tournament-players',
  body: { player_id: 'p1' },
  params: null,
  clientEntityIds: {},
  deps: [],
  attempts: 0,
  ...extra,
});

const resposta = (resultados) => ({ data: { results: resultados } });

beforeEach(() => {
  // CRA liga `resetMocks`: as implementações precisam ser redefinidas aqui.
  isOnline.mockReturnValue(true);
  getPendingMutations.mockResolvedValue([]);
  updateMutation.mockResolvedValue(null);
  removeMutation.mockResolvedValue(undefined);
  addConflict.mockResolvedValue(undefined);
  subscribe.mockReturnValue(() => {});
  api.post.mockResolvedValue(resposta([]));
});

afterEach(() => stopSyncEngine());

describe('quando não há o que enviar', () => {
  it('offline nem tenta', async () => {
    isOnline.mockReturnValue(false);
    expect(await flush()).toEqual({ skipped: true });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('fila vazia não gera requisição', async () => {
    expect(await flush()).toEqual({ empty: true });
    expect(api.post).not.toHaveBeenCalled();
  });

  it('falha ao ler a fila é reportada sem estourar', async () => {
    getPendingMutations.mockRejectedValue(new Error('IndexedDB indisponível'));
    expect(await flush()).toEqual({ error: 'db' });
  });
});

describe('envio em lote', () => {
  it('manda as operações na ordem da fila', async () => {
    // A ordem é causal: o registro precisa chegar antes do rebuy dele.
    getPendingMutations.mockResolvedValue([mutacao('m1'), mutacao('m2')]);
    await flush();
    const enviadas = api.post.mock.calls[0][1].ops;
    expect(enviadas.map((o) => o.clientMutationId)).toEqual(['mut-m1', 'mut-m2']);
  });

  it('cada operação leva o que o servidor precisa para reexecutar', async () => {
    getPendingMutations.mockResolvedValue([
      mutacao('m1', {
        clientEntityIds: { tournament_players: 'tp-1' },
        deps: ['m0'],
        params: { a: 1 },
      }),
    ]);
    await flush();
    expect(api.post.mock.calls[0][1].ops[0]).toEqual({
      clientMutationId: 'mut-m1',
      kind: 'register',
      method: 'post',
      url: '/tournament-players',
      body: { player_id: 'p1' },
      params: { a: 1 },
      clientEntityIds: { tournament_players: 'tp-1' },
      deps: ['m0'],
    });
  });

  it('confirma a conectividade no sucesso', async () => {
    getPendingMutations.mockResolvedValue([mutacao('m1')]);
    await flush();
    expect(markOnline).toHaveBeenCalled();
  });
});

describe('tratamento de cada resultado', () => {
  it('aplicada sai da fila', async () => {
    getPendingMutations.mockResolvedValue([mutacao('m1')]);
    api.post.mockResolvedValue(
      resposta([{ clientMutationId: 'mut-m1', status: 'applied' }])
    );
    await flush();
    expect(removeMutation).toHaveBeenCalledWith('m1');
  });

  it('duplicada também sai da fila', async () => {
    // O servidor já tinha aplicado e o ack se perdeu; insistir prenderia a
    // operação para sempre.
    getPendingMutations.mockResolvedValue([mutacao('m1')]);
    api.post.mockResolvedValue(
      resposta([{ clientMutationId: 'mut-m1', status: 'duplicate' }])
    );
    await flush();
    expect(removeMutation).toHaveBeenCalledWith('m1');
  });

  it('conflito vai para revisão em vez de retry', async () => {
    // "Jogador já inscrito" não passa por insistência: alguém precisa decidir.
    getPendingMutations.mockResolvedValue([mutacao('m1')]);
    api.post.mockResolvedValue(
      resposta([
        {
          clientMutationId: 'mut-m1',
          status: 'conflict',
          error: 'jogador já inscrito',
          serverId: 'tp-servidor',
        },
      ])
    );
    await flush();
    expect(updateMutation).toHaveBeenCalledWith('m1', {
      status: 'conflict',
      error: 'jogador já inscrito',
    });
    expect(addConflict).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'm1',
        reason: 'jogador já inscrito',
        serverId: 'tp-servidor',
      })
    );
    expect(removeMutation).not.toHaveBeenCalled();
  });

  it('conflito sem motivo ainda vira um registro revisável', async () => {
    getPendingMutations.mockResolvedValue([mutacao('m1')]);
    api.post.mockResolvedValue(
      resposta([{ clientMutationId: 'mut-m1', status: 'conflict' }])
    );
    await flush();
    expect(addConflict).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'conflito', serverId: null })
    );
  });

  it('erro continua pendente e conta a tentativa', async () => {
    getPendingMutations.mockResolvedValue([mutacao('m1', { attempts: 2 })]);
    api.post.mockResolvedValue(
      resposta([{ clientMutationId: 'mut-m1', status: 'error', error: '500' }])
    );
    await flush();
    expect(updateMutation).toHaveBeenCalledWith('m1', {
      status: 'error',
      attempts: 3,
      error: '500',
    });
    expect(removeMutation).not.toHaveBeenCalled();
  });

  it('operação sem resultado no retorno fica pendente', async () => {
    // O servidor parou numa dependência anterior e nem chegou nesta; tratá-la
    // como erro contaria uma tentativa que nunca aconteceu.
    getPendingMutations.mockResolvedValue([mutacao('m1'), mutacao('m2')]);
    api.post.mockResolvedValue(
      resposta([{ clientMutationId: 'mut-m1', status: 'applied' }])
    );
    await flush();
    expect(removeMutation).toHaveBeenCalledTimes(1);
    expect(updateMutation).not.toHaveBeenCalled();
  });

  it('resposta sem corpo de resultados não quebra', async () => {
    getPendingMutations.mockResolvedValue([mutacao('m1')]);
    api.post.mockResolvedValue({ data: null });
    expect(await flush()).toEqual({ done: true, results: [] });
  });

  it('lote misto trata cada operação pelo próprio resultado', async () => {
    getPendingMutations.mockResolvedValue([
      mutacao('m1'),
      mutacao('m2'),
      mutacao('m3'),
    ]);
    api.post.mockResolvedValue(
      resposta([
        { clientMutationId: 'mut-m1', status: 'applied' },
        { clientMutationId: 'mut-m2', status: 'conflict', error: 'x' },
        { clientMutationId: 'mut-m3', status: 'error', error: 'y' },
      ])
    );
    await flush();
    expect(removeMutation).toHaveBeenCalledWith('m1');
    expect(addConflict).toHaveBeenCalledTimes(1);
    expect(updateMutation).toHaveBeenCalledWith(
      'm3',
      expect.objectContaining({ status: 'error' })
    );
  });
});

/**
 * As vendas represadas na fila só entram no caixa no momento do sync. Quem
 * mostra o saldo é o banner, que busca por conta própria e não tem como
 * adivinhar que a fila acabou de esvaziar.
 */
describe('aviso de que o caixa mudou', () => {
  const avisos = jest.fn();
  beforeEach(() => { window.addEventListener(CAIXA_MUDOU, avisos); });
  afterEach(() => { window.removeEventListener(CAIXA_MUDOU, avisos); });

  it('sync que aplicou avisa', async () => {
    getPendingMutations.mockResolvedValue([mutacao('m1')]);
    api.post.mockResolvedValue(resposta([{ clientMutationId: 'mut-m1', status: 'applied' }]));
    await flush();
    expect(avisos).toHaveBeenCalled();
  });

  it('duplicada avisa igual: o saldo mudou numa tentativa que a tela não viu', async () => {
    getPendingMutations.mockResolvedValue([mutacao('m1')]);
    api.post.mockResolvedValue(resposta([{ clientMutationId: 'mut-m1', status: 'duplicate' }]));
    await flush();
    expect(avisos).toHaveBeenCalled();
  });

  it('lote que não entrou não avisa nada', async () => {
    // Avisar aqui mandaria o banner buscar um saldo que não mudou — e a cada
    // ciclo do motor, com a fila presa em erro.
    getPendingMutations.mockResolvedValue([mutacao('m1')]);
    api.post.mockResolvedValue(resposta([{ clientMutationId: 'mut-m1', status: 'error', error: '500' }]));
    await flush();
    expect(avisos).not.toHaveBeenCalled();
  });
});

describe('falhas de transporte', () => {
  it('erro de rede marca offline e NÃO mexe na fila', async () => {
    // Se o flush limpasse a fila ao falhar, o evento inteiro sumiria.
    getPendingMutations.mockResolvedValue([mutacao('m1')]);
    api.post.mockRejectedValue(Object.assign(new Error('Network'), { response: undefined }));
    expect(await flush()).toEqual({ offline: true });
    expect(markOffline).toHaveBeenCalled();
    expect(removeMutation).not.toHaveBeenCalled();
    expect(updateMutation).not.toHaveBeenCalled();
  });

  it.each([401, 500, 503])(
    'HTTP %i deixa tudo pendente para a próxima tentativa',
    async (status) => {
      // 401 é o caso do token que expirou durante o offline: a fila espera o
      // re-login em vez de perder as operações.
      getPendingMutations.mockResolvedValue([mutacao('m1')]);
      api.post.mockRejectedValue(
        Object.assign(new Error('erro'), { response: { status } })
      );
      expect(await flush()).toEqual({ httpError: status });
      expect(removeMutation).not.toHaveBeenCalled();
    }
  );
});

describe('gatilhos automáticos', () => {
  it('assina a reconexão e tenta esvaziar o que ficou da sessão anterior', async () => {
    startSyncEngine();
    expect(subscribe).toHaveBeenCalled();
    expect(getPendingMutations).toHaveBeenCalled();
  });

  it('ligar duas vezes não duplica os gatilhos', async () => {
    startSyncEngine();
    startSyncEngine();
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('a reconexão dispara um flush', async () => {
    let aoMudar;
    subscribe.mockImplementation((fn) => {
      aoMudar = fn;
      return () => {};
    });
    startSyncEngine();
    getPendingMutations.mockClear();
    aoMudar(true);
    expect(getPendingMutations).toHaveBeenCalled();
  });

  it('ficar offline não dispara flush', async () => {
    let aoMudar;
    subscribe.mockImplementation((fn) => {
      aoMudar = fn;
      return () => {};
    });
    startSyncEngine();
    getPendingMutations.mockClear();
    aoMudar(false);
    expect(getPendingMutations).not.toHaveBeenCalled();
  });

  it('o flush periódico só roda online', async () => {
    jest.useFakeTimers();
    isOnline.mockReturnValue(false);
    startSyncEngine();
    getPendingMutations.mockClear();
    jest.advanceTimersByTime(60000);
    expect(getPendingMutations).not.toHaveBeenCalled();
    jest.useRealTimers();
  });

  it('parar cancela o flush periódico', async () => {
    jest.useFakeTimers();
    startSyncEngine();
    stopSyncEngine();
    getPendingMutations.mockClear();
    jest.advanceTimersByTime(60000);
    expect(getPendingMutations).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});
