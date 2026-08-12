/**
 * Substrato de persistência offline (IndexedDB).
 *
 * Não é cache: é o que segura o dinheiro do evento quando a internet cai. Um
 * registro enfileirado precisa sobreviver a um F5, a um navegador fechado e a
 * um notebook que descarregou — se sumir, o buy-in aconteceu no salão e não
 * existe em lugar nenhum.
 *
 * Os testes rodam contra um IndexedDB de verdade (fake-indexeddb), não um
 * mock: o que interessa aqui é o comportamento das transações e dos índices,
 * que um objeto em memória não reproduz.
 */
import 'fake-indexeddb/auto';
import {
  uuid,
  getMeta,
  setMeta,
  getDeviceId,
  putEntity,
  putEntities,
  getEntity,
  getAllByTable,
  deleteEntity,
  clearTables,
  enqueueMutation,
  getQueue,
  getPendingMutations,
  getPendingCount,
  updateMutation,
  removeMutation,
  addConflict,
  getConflicts,
  removeConflict,
  clearOfflineDB,
  putGetCache,
  getGetCache,
} from './db';

const entrada = (id, extra = {}) => ({
  id,
  kind: 'register',
  method: 'post',
  url: '/tournament-players',
  status: 'pending',
  createdAt: Date.now(),
  ...extra,
});

beforeEach(async () => {
  await clearOfflineDB();
});

describe('uuid', () => {
  it('gera identificadores distintos', () => {
    const ids = new Set(Array.from({ length: 200 }, uuid));
    expect(ids.size).toBe(200);
  });

  it('tem o formato de um uuid v4', () => {
    expect(uuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('funciona sem crypto.randomUUID', () => {
    // Navegador em contexto não seguro (http numa rede local do clube) não
    // expõe randomUUID; sem o fallback, nenhuma operação offline seria
    // enfileirada.
    const original = global.crypto.randomUUID;
    global.crypto.randomUUID = undefined;
    expect(uuid()).toMatch(/^[0-9a-f]{8}-/i);
    global.crypto.randomUUID = original;
  });
});

describe('meta', () => {
  it('guarda e devolve um valor', async () => {
    await setMeta('cursor', '2026-06-08');
    expect(await getMeta('cursor')).toBe('2026-06-08');
  });

  it('chave ausente devolve o padrão informado', async () => {
    expect(await getMeta('nao-existe', 'padrao')).toBe('padrao');
  });

  it('chave ausente sem padrão devolve null', async () => {
    expect(await getMeta('nao-existe')).toBeNull();
  });

  it('o id do dispositivo é gerado uma vez e reaproveitado', async () => {
    // A fila é reexecutada por dispositivo; um id novo a cada carga tornaria
    // impossível dizer de onde veio cada operação numa casa com vários caixas.
    const primeiro = await getDeviceId();
    expect(await getDeviceId()).toBe(primeiro);
  });

  it('o id do dispositivo sobrevive à limpeza do logout', async () => {
    const antes = await getDeviceId();
    await clearOfflineDB();
    expect(await getDeviceId()).toBe(antes);
  });
});

describe('réplica local de entidades', () => {
  it('grava e lê uma linha', async () => {
    await putEntity('players', { id: 'p1', name: 'Fulano' });
    expect(await getEntity('players', 'p1')).toEqual({ id: 'p1', name: 'Fulano' });
  });

  it('linha sem id é ignorada', async () => {
    // Sem id não há chave; gravar criaria uma linha inalcançável.
    expect(await putEntity('players', { name: 'sem id' })).toBeNull();
    expect(await putEntity('players', null)).toBeNull();
  });

  it('regravar substitui a linha', async () => {
    await putEntity('players', { id: 'p1', name: 'Antigo' });
    await putEntity('players', { id: 'p1', name: 'Novo' });
    expect((await getEntity('players', 'p1')).name).toBe('Novo');
  });

  it('tabelas diferentes não colidem no mesmo id', async () => {
    // A chave é "{tabela}:{id}"; sem o prefixo, um jogador e um torneio com o
    // mesmo id sobrescreveriam um ao outro.
    await putEntity('players', { id: 'x', tipo: 'jogador' });
    await putEntity('tournaments', { id: 'x', tipo: 'torneio' });
    expect((await getEntity('players', 'x')).tipo).toBe('jogador');
    expect((await getEntity('tournaments', 'x')).tipo).toBe('torneio');
  });

  it('linha inexistente devolve null', async () => {
    expect(await getEntity('players', 'nao-existe')).toBeNull();
  });

  it('grava um lote numa transação só', async () => {
    const n = await putEntities('players', [
      { id: 'p1', name: 'Um' },
      { id: 'p2', name: 'Dois' },
    ]);
    expect(n).toBe(2);
    expect(await getAllByTable('players')).toHaveLength(2);
  });

  it('lote vazio não abre transação', async () => {
    expect(await putEntities('players', [])).toBe(0);
    expect(await putEntities('players', null)).toBe(0);
  });

  it('linhas sem id são descartadas no lote', async () => {
    // Um snapshot do servidor pode trazer lixo; descartar a linha ruim é
    // melhor que perder o lote inteiro.
    await putEntities('players', [{ id: 'p1' }, { name: 'sem id' }, null]);
    expect(await getAllByTable('players')).toHaveLength(1);
  });

  it('lista por tabela não traz linhas de outra', async () => {
    await putEntity('players', { id: 'p1' });
    await putEntity('tournaments', { id: 't1' });
    expect(await getAllByTable('players')).toEqual([{ id: 'p1' }]);
  });

  it('apaga uma linha', async () => {
    await putEntity('players', { id: 'p1' });
    await deleteEntity('players', 'p1');
    expect(await getEntity('players', 'p1')).toBeNull();
  });

  it('limpa uma tabela inteira sem tocar nas outras', async () => {
    // Ao trocar de etapa, a réplica da etapa anterior precisa sair — senão a
    // tela soma jogadores de dois eventos diferentes.
    await putEntities('tournament_players', [{ id: 'a' }, { id: 'b' }]);
    await putEntity('players', { id: 'p1' });
    await clearTables('tournament_players');
    expect(await getAllByTable('tournament_players')).toEqual([]);
    expect(await getAllByTable('players')).toHaveLength(1);
  });

  it('limpa várias tabelas de uma vez', async () => {
    await putEntity('tournament_players', { id: 'a' });
    await putEntity('transactions', { id: 'b' });
    await putEntity('players', { id: 'p1' });
    await clearTables(['tournament_players', 'transactions']);
    expect(await getAllByTable('tournament_players')).toEqual([]);
    expect(await getAllByTable('transactions')).toEqual([]);
    expect(await getAllByTable('players')).toHaveLength(1);
  });
});

describe('fila de mutações', () => {
  it('guarda uma entrada', async () => {
    await enqueueMutation(entrada('m1'));
    expect(await getQueue()).toHaveLength(1);
  });

  it('devolve na ordem em que foram criadas', async () => {
    // A ordem é CAUSAL: o registro do jogador precisa subir antes do rebuy
    // dele, senão o servidor rejeita a referência.
    await enqueueMutation(entrada('m3', { createdAt: 300 }));
    await enqueueMutation(entrada('m1', { createdAt: 100 }));
    await enqueueMutation(entrada('m2', { createdAt: 200 }));
    expect((await getQueue()).map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('pendentes incluem as que falharam', async () => {
    // Erro transitório (rede caiu no meio do envio) precisa ser retentado;
    // deixá-lo de fora perderia a operação em silêncio.
    await enqueueMutation(entrada('m1', { status: 'pending' }));
    await enqueueMutation(entrada('m2', { status: 'error' }));
    await enqueueMutation(entrada('m3', { status: 'done' }));
    await enqueueMutation(entrada('m4', { status: 'conflict' }));
    expect((await getPendingMutations()).map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('o contador de pendentes bate com a lista', async () => {
    // É o número que a UI mostra no indicador de "N operações não enviadas".
    await enqueueMutation(entrada('m1', { status: 'pending' }));
    await enqueueMutation(entrada('m2', { status: 'error' }));
    await enqueueMutation(entrada('m3', { status: 'done' }));
    expect(await getPendingCount()).toBe(2);
  });

  it('fila vazia conta zero', async () => {
    expect(await getPendingCount()).toBe(0);
  });

  it('atualiza uma entrada preservando o resto', async () => {
    await enqueueMutation(entrada('m1', { attempts: 0 }));
    const atualizada = await updateMutation('m1', { status: 'error', attempts: 1 });
    expect(atualizada.status).toBe('error');
    expect(atualizada.attempts).toBe(1);
    expect(atualizada.url).toBe('/tournament-players');
  });

  it('atualizar entrada inexistente devolve null', async () => {
    expect(await updateMutation('nao-existe', { status: 'done' })).toBeNull();
  });

  it('remove uma entrada', async () => {
    await enqueueMutation(entrada('m1'));
    await removeMutation('m1');
    expect(await getQueue()).toEqual([]);
  });
});

describe('conflitos', () => {
  it('guarda, lista e remove', async () => {
    // Conflito não pode ser descartado em silêncio: o operador precisa
    // decidir o que fazer com um registro duplicado ou um assento tomado.
    await addConflict({ id: 'c1', reason: 'jogador já inscrito' });
    expect(await getConflicts()).toHaveLength(1);
    await removeConflict('c1');
    expect(await getConflicts()).toEqual([]);
  });
});

describe('cache de respostas GET', () => {
  it('guarda e devolve a última resposta', async () => {
    // É o que faz a tela abrir com os últimos dados vistos em vez de vazia
    // quando o operador dá F5 sem internet.
    await putGetCache('u1|/players', [{ id: 'p1' }]);
    expect(await getGetCache('u1|/players')).toEqual([{ id: 'p1' }]);
  });

  it('chave ausente devolve null', async () => {
    expect(await getGetCache('nao-existe')).toBeNull();
  });

  it('a chave separa usuários diferentes', async () => {
    // A chave é escopada por usuário/organização: sem isso, um operador veria
    // no cache os dados do clube do outro.
    await putGetCache('u1|/players', ['do usuário 1']);
    await putGetCache('u2|/players', ['do usuário 2']);
    expect(await getGetCache('u1|/players')).toEqual(['do usuário 1']);
  });
});

describe('limpeza do logout', () => {
  it('apaga fila, réplica, conflitos e cache', async () => {
    await enqueueMutation(entrada('m1'));
    await putEntity('players', { id: 'p1' });
    await addConflict({ id: 'c1' });
    await putGetCache('k', [1]);

    await clearOfflineDB();

    expect(await getQueue()).toEqual([]);
    expect(await getAllByTable('players')).toEqual([]);
    expect(await getConflicts()).toEqual([]);
    expect(await getGetCache('k')).toBeNull();
  });
});
