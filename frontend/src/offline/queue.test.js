/**
 * Fila de mutações offline.
 *
 * Cada entrada precisa carregar TUDO que o `/sync/batch` usa para reexecutar a
 * operação sozinho: método, url, corpo, parâmetros e uma chave de
 * idempotência. Se faltar o `clientMutationId`, um ack perdido no meio do
 * caminho faz o reenvio criar o buy-in duas vezes — dinheiro cobrado em
 * dobro do jogador.
 *
 * Os `clientEntityIds` existem pelo motivo inverso: um rebuy feito logo depois
 * de um registro, ainda offline, precisa apontar para uma inscrição que o
 * servidor ainda não conhece. O uuid é gerado aqui e vai junto no replay.
 */
import { enqueue, notifyQueueChanged } from './queue';
import { enqueueMutation, uuid, getDeviceId } from './db';
import { OFFLINE_QUEUE_EVENT } from './connectivity';

jest.mock('./db', () => {
  let contador = 0;
  return {
    __gravadas: [],
    enqueueMutation: async function (entrada) {
      jest.requireMock('./db').__gravadas.push(entrada);
      return entrada;
    },
    uuid: () => `uuid-${++contador}`,
    getDeviceId: async () => 'dispositivo-1',
  };
});

const { __gravadas: gravadas } = jest.requireMock('./db');

beforeEach(() => {
  gravadas.length = 0;
});

const base = { kind: 'register', url: '/tournament-players' };

describe('enfileiramento', () => {
  it('persiste a entrada', async () => {
    await enqueue(base);
    expect(gravadas).toHaveLength(1);
    expect(gravadas[0].url).toBe('/tournament-players');
  });

  it('nasce pendente e sem tentativas', async () => {
    const e = await enqueue(base);
    expect(e.status).toBe('pending');
    expect(e.attempts).toBe(0);
    expect(e.error).toBeNull();
  });

  it('carimba o dispositivo de origem', async () => {
    // Numa casa com vários caixas offline ao mesmo tempo, é o que permite
    // dizer de onde veio cada operação na tela de conflitos.
    const e = await enqueue(base);
    expect(e.deviceId).toBe('dispositivo-1');
  });

  it('gera uma chave de idempotência quando não vem uma', async () => {
    // Sem ela, um ack perdido faria o reenvio cobrar o buy-in duas vezes.
    const e = await enqueue(base);
    expect(e.clientMutationId).toBeTruthy();
    expect(e.clientMutationId).not.toBe(e.id);
  });

  it('respeita a chave de idempotência informada', async () => {
    // A tela às vezes gera a chave antes, para poder referenciá-la.
    const e = await enqueue({ ...base, clientMutationId: 'mut-fixa' });
    expect(e.clientMutationId).toBe('mut-fixa');
  });

  it('o método vira minúsculo', async () => {
    // O `/sync/batch` compara o método como texto; "POST" e "post" não podem
    // seguir caminhos diferentes.
    expect((await enqueue({ ...base, method: 'PATCH' })).method).toBe('patch');
  });

  it('sem método assume post', async () => {
    expect((await enqueue(base)).method).toBe('post');
  });

  it('campos opcionais recebem valores neutros', async () => {
    const e = await enqueue(base);
    expect(e.body).toBeNull();
    expect(e.params).toBeNull();
    expect(e.deps).toEqual([]);
    expect(e.clientEntityIds).toEqual({});
    expect(e.meta).toEqual({});
  });

  it('preserva os ids gerados no cliente', async () => {
    // É o que deixa um rebuy offline apontar para uma inscrição que o
    // servidor ainda não conhece.
    const e = await enqueue({
      ...base,
      clientEntityIds: { tournament_players: 'tp-local-1' },
    });
    expect(e.clientEntityIds).toEqual({ tournament_players: 'tp-local-1' });
  });

  it('preserva as dependências declaradas', async () => {
    const e = await enqueue({ ...base, deps: ['fila-0'] });
    expect(e.deps).toEqual(['fila-0']);
  });

  it('guarda o contexto para a tela de conflitos', async () => {
    // Um conflito que só mostra um uuid é inútil para o operador; o nome do
    // jogador é o que permite decidir o que fazer.
    const e = await enqueue({ ...base, meta: { playerName: 'Fulano' } });
    expect(e.meta.playerName).toBe('Fulano');
  });

  it('registra o instante da criação', async () => {
    // A ordem do replay é causal e vem daqui.
    const antes = Date.now();
    const e = await enqueue(base);
    expect(e.createdAt).toBeGreaterThanOrEqual(antes);
  });

  it('cada entrada recebe um id próprio', async () => {
    const a = await enqueue(base);
    const b = await enqueue(base);
    expect(a.id).not.toBe(b.id);
  });
});

describe('aviso à interface', () => {
  it('enfileirar dispara o evento de mudança da fila', async () => {
    // É o que atualiza o contador de "N operações não enviadas" sem
    // precisar de polling.
    const ouvinte = jest.fn();
    window.addEventListener(OFFLINE_QUEUE_EVENT, ouvinte);
    await enqueue(base);
    expect(ouvinte).toHaveBeenCalled();
    window.removeEventListener(OFFLINE_QUEUE_EVENT, ouvinte);
  });

  it('o aviso pode ser disparado sozinho', async () => {
    // O motor de sync usa isso depois de esvaziar a fila.
    const ouvinte = jest.fn();
    window.addEventListener(OFFLINE_QUEUE_EVENT, ouvinte);
    notifyQueueChanged();
    expect(ouvinte).toHaveBeenCalled();
    window.removeEventListener(OFFLINE_QUEUE_EVENT, ouvinte);
  });
});
