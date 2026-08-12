/**
 * Regras de domínio replicadas para o display offline.
 *
 * Por que replicar em JS o que o servidor já faz: numa casa de poker sem
 * internet, o operador continua registrando jogador, rebuy e sangria. Se a
 * tela mostrasse números aproximados, o caixa da etapa exibido não bateria
 * com o dinheiro na gaveta — e é justamente nesse momento que ninguém pode
 * conferir com o servidor.
 *
 * A fonte da verdade continua sendo o servidor: no sync, o pull-refresh
 * sobrescreve a réplica. O que estes testes protegem é a PARIDADE — se a
 * conta daqui divergir da do backend, o operador vê um valor durante o
 * evento e outro depois de reconectar, e não confia mais em nenhum dos dois.
 */
import {
  applyRegister,
  applyRebuy,
  applyAddon,
  applySangria,
  applyPlayerCreate,
  applyEliminate,
} from './domainRules';
import { putEntity } from './db';

// Réplica local em memória. As funções são comuns (não `jest.fn`) de
// propósito: o CRA liga `resetMocks`, que apaga a implementação de qualquer
// mock antes de cada teste — e o armazenamento sumiria junto.
jest.mock('./db', () => {
  const memoria = new Map();
  return {
    __memoria: memoria,
    getEntity: async (tabela, id) => memoria.get(`${tabela}:${id}`) || null,
    putEntity: async (tabela, linha) => {
      memoria.set(`${tabela}:${linha.id}`, linha);
      return linha;
    },
  };
});

const { __memoria: memoria } = jest.requireMock('./db');

const TOUR = 'tour-1';
const DIA = 'dia-1';
const ETAPA = 'etapa-1';
const JOGADOR = 'jog-1';

const guardar = (tabela, linha) => memoria.set(`${tabela}:${linha.id}`, linha);
const ler = (tabela, id) => memoria.get(`${tabela}:${id}`);

beforeEach(() => {
  memoria.clear();
  jest.clearAllMocks();

  guardar('tournaments', { id: TOUR, stage_id: ETAPA });
  guardar('tournament_days', {
    id: DIA,
    tournament_id: TOUR,
    buy_in: 300,
    rebuy_amount: 300,
    addon_amount: 150,
    rake_percentage: 20,
    starting_chips: 30000,
    rebuy_chips: 30000,
    addon_chips: 15000,
    registered_players: 0,
    prize_pool: 0,
  });
  guardar('stage_cash_register', {
    id: ETAPA,
    current_balance: 0,
    total_received: 0,
    total_sangrias: 0,
  });
});

const corpoRegistro = (extra = {}) => ({
  client_id: 'tp-local-1',
  client_mutation_id: 'mut-1',
  tournament_id: TOUR,
  tournament_day_id: DIA,
  player_id: JOGADOR,
  ...extra,
});

describe('registro de jogador', () => {
  it('cria a inscrição com o valor e as fichas do dia', async () => {
    const { tp } = await applyRegister(corpoRegistro());
    expect(tp.total_buy_in_amount).toBe(300);
    expect(tp.total_chips).toBe(30000);
    expect(tp.status).toBe('active');
  });

  it('marca a linha como criada offline', async () => {
    // É o que permite à tela distinguir o que ainda não subiu e ao motor de
    // sync saber o que reenviar.
    const { tp, txn } = await applyRegister(corpoRegistro());
    expect(tp._offline).toBe(true);
    expect(txn._offline).toBe(true);
  });

  it('o id gerado no cliente vira a chave da inscrição', async () => {
    // Um rebuy feito logo em seguida, ainda offline, precisa referenciar
    // esta inscrição — e o id do servidor ainda não existe.
    const { tp } = await applyRegister(corpoRegistro());
    expect(tp.id).toBe('tp-local-1');
    expect(ler('tournament_players', 'tp-local-1')).toBeTruthy();
  });

  it('a transação aponta para a inscrição pelo mesmo id local', async () => {
    const { txn } = await applyRegister(corpoRegistro());
    expect(txn.tournament_player_id).toBe('tp-local-1');
    expect(txn.type).toBe('buy_in');
  });

  it('entrada dupla cobra o dobro e dá o dobro de fichas', async () => {
    const { tp } = await applyRegister(corpoRegistro({ buy_in_count: 2 }));
    expect(tp.total_buy_in_amount).toBe(600);
    expect(tp.total_chips).toBe(60000);
  });

  it('entrada por ticket não cobra nada, mas dá as fichas', async () => {
    // O ticket já foi pago no satélite; cobrar de novo seria cobrança dupla.
    const { tp, txn } = await applyRegister(
      corpoRegistro({ payment_source: 'ticket' })
    );
    expect(tp.total_buy_in_amount).toBe(0);
    expect(tp.total_chips).toBe(30000);
    expect(txn.amount).toBe(0);
  });

  it('incrementa o contador de inscritos do dia', async () => {
    await applyRegister(corpoRegistro());
    expect(ler('tournament_days', DIA).registered_players).toBe(1);
  });

  it('o prêmio cresce descontando o rake', async () => {
    // 300 × (1 − 20%) = 240. É a mesma conta do trigger do servidor.
    await applyRegister(corpoRegistro());
    expect(ler('tournament_days', DIA).prize_pool).toBe(240);
  });

  it('o caixa da etapa recebe o valor BRUTO', async () => {
    // O rake só sai do caixa na sangria; o dinheiro que entrou na gaveta é
    // o valor cheio.
    await applyRegister(corpoRegistro());
    const caixa = ler('stage_cash_register', ETAPA);
    expect(caixa.current_balance).toBe(300);
    expect(caixa.total_received).toBe(300);
  });

  it('o rake do TIPO DE COMPRA vence o percentual do dia', async () => {
    // Um freeroll ou uma entrada promocional tem rake próprio; usar o do dia
    // colocaria dinheiro a mais no prêmio.
    guardar('buy_types', { id: 'bt-1', rake_percentage: 0 });
    await applyRegister(corpoRegistro({ buy_type_id: 'bt-1' }));
    expect(ler('tournament_days', DIA).prize_pool).toBe(300);
  });

  it('tipo de compra com rake zero não cai no padrão do dia', async () => {
    // Zero é um valor válido; tratá-lo como "ausente" reintroduziria os 20%.
    guardar('buy_types', { id: 'bt-0', rake_percentage: 0 });
    const { txn } = await applyRegister(corpoRegistro({ buy_type_id: 'bt-0' }));
    expect(txn.rake_percentage).toBe(0);
    expect(txn.rake_amount).toBe(0);
  });

  it('grava o rake em valor na transação', async () => {
    const { txn } = await applyRegister(corpoRegistro());
    expect(txn.rake_percentage).toBe(20);
    expect(txn.rake_amount).toBe(60);
  });

  it('registro sem dia não mexe em prêmio nem em caixa', async () => {
    const { tp } = await applyRegister(
      corpoRegistro({ tournament_day_id: null })
    );
    expect(tp.total_buy_in_amount).toBe(0);
    expect(ler('stage_cash_register', ETAPA).current_balance).toBe(0);
  });

  it('a forma de pagamento é preservada', async () => {
    const { txn } = await applyRegister(
      corpoRegistro({ payment_method: 'pix' })
    );
    expect(txn.payment_method).toBe('pix');
  });

  it('sem forma informada assume dinheiro', async () => {
    const { txn } = await applyRegister(corpoRegistro());
    expect(txn.payment_method).toBe('cash');
    expect(txn.payment_source).toBe('cash');
  });

  it('torneio sem etapa na réplica não quebra o registro', async () => {
    // Réplica ainda não hidratada por completo: o registro precisa acontecer
    // de qualquer jeito, é a operação que não pode parar.
    memoria.delete(`tournaments:${TOUR}`);
    const { tp } = await applyRegister(corpoRegistro());
    expect(tp.total_buy_in_amount).toBe(300);
  });
});

describe('rebuy', () => {
  const corpoRebuy = (extra = {}) => ({
    tournament_player_id: 'tp-local-1',
    client_mutation_id: 'mut-2',
    ...extra,
  });

  beforeEach(async () => {
    await applyRegister(corpoRegistro());
    jest.clearAllMocks();
  });

  it('soma valor, fichas e contador', async () => {
    const { tp } = await applyRebuy(corpoRebuy());
    expect(tp.rebuy_count).toBe(1);
    expect(tp.total_rebuy_amount).toBe(300);
    expect(tp.total_chips).toBe(60000);
    expect(tp.total_spent).toBe(600);
  });

  it('reativa quem estava eliminado', async () => {
    // É exatamente para isso que serve o rebuy: o jogador voltou.
    await applyEliminate({ tournament_player_id: 'tp-local-1' });
    const { tp } = await applyRebuy(corpoRebuy());
    expect(tp.status).toBe('active');
  });

  it('alimenta prêmio e caixa como o buy-in', async () => {
    await applyRebuy(corpoRebuy());
    expect(ler('tournament_days', DIA).prize_pool).toBe(480); // 240 + 240
    expect(ler('stage_cash_register', ETAPA).current_balance).toBe(600);
  });

  it('não incrementa o número de inscritos', async () => {
    // Rebuy é uma entrada nova no dinheiro, mas não uma pessoa nova no salão.
    await applyRebuy(corpoRebuy());
    expect(ler('tournament_days', DIA).registered_players).toBe(1);
  });

  it('inscrição inexistente devolve null em vez de estourar', async () => {
    expect(await applyRebuy(corpoRebuy({ tournament_player_id: 'nao-existe' }))).toBeNull();
  });

  it('rebuy sem valor configurado no dia não cobra nada', async () => {
    const dia = ler('tournament_days', DIA);
    dia.rebuy_amount = null;
    await putEntity('tournament_days', dia);
    const { tp } = await applyRebuy(corpoRebuy());
    expect(tp.total_rebuy_amount).toBe(0);
  });

  it('sem fichas de rebuy configuradas usa o padrão de 10 mil', async () => {
    const dia = ler('tournament_days', DIA);
    dia.rebuy_chips = null;
    await putEntity('tournament_days', dia);
    const { tp } = await applyRebuy(corpoRebuy());
    expect(tp.total_chips).toBe(40000); // 30000 + 10000
  });
});

describe('add-on', () => {
  const corpoAddon = (extra = {}) => ({
    tournament_player_id: 'tp-local-1',
    client_mutation_id: 'mut-3',
    ...extra,
  });

  beforeEach(async () => {
    await applyRegister(corpoRegistro());
    jest.clearAllMocks();
  });

  it('soma valor, fichas e contador próprios', async () => {
    const { tp } = await applyAddon(corpoAddon());
    expect(tp.addon_count).toBe(1);
    expect(tp.total_addon_amount).toBe(150);
    expect(tp.total_chips).toBe(45000);
    expect(tp.total_spent).toBe(450);
  });

  it('não reativa eliminado', async () => {
    // Diferente do rebuy: add-on é ficha extra para quem está jogando.
    await applyEliminate({ tournament_player_id: 'tp-local-1' });
    const { tp } = await applyAddon(corpoAddon());
    expect(tp.status).toBe('eliminated');
  });

  it('alimenta prêmio e caixa', async () => {
    await applyAddon(corpoAddon());
    expect(ler('tournament_days', DIA).prize_pool).toBe(360); // 240 + 120
    expect(ler('stage_cash_register', ETAPA).current_balance).toBe(450);
  });

  it('inscrição inexistente devolve null', async () => {
    expect(await applyAddon(corpoAddon({ tournament_player_id: 'x' }))).toBeNull();
  });

  it('sem fichas de add-on configuradas usa o padrão', async () => {
    const dia = ler('tournament_days', DIA);
    dia.addon_chips = null;
    await putEntity('tournament_days', dia);
    const { tp } = await applyAddon(corpoAddon());
    expect(tp.total_chips).toBe(40000);
  });
});

describe('sangria', () => {
  beforeEach(() => {
    guardar('stage_cash_register', {
      id: ETAPA,
      current_balance: 1000,
      total_received: 1000,
      total_sangrias: 0,
    });
    guardar('pending_rake', { id: ETAPA, pending: 200 });
  });

  it('o rake sai proporcional ao que foi retirado', async () => {
    // Retirando metade do caixa, sai metade do rake pendente. Retirar o rake
    // inteiro na primeira sangria deixaria o clube sem rake nas seguintes.
    const r = await applySangria({ stage_id: ETAPA, amount: 500 });
    expect(r.rake).toBe(100);
    expect(r.net).toBe(400);
  });

  it('sangria total leva todo o rake pendente', async () => {
    const r = await applySangria({ stage_id: ETAPA, amount: 1000 });
    expect(r.rake).toBe(200);
    expect(r.net).toBe(800);
  });

  it('reduz o caixa e acumula o total sangrado', async () => {
    await applySangria({ stage_id: ETAPA, amount: 300 });
    const caixa = ler('stage_cash_register', ETAPA);
    expect(caixa.current_balance).toBe(700);
    expect(caixa.total_sangrias).toBe(300);
  });

  it('abate o rake retirado do pendente', async () => {
    await applySangria({ stage_id: ETAPA, amount: 500 });
    expect(ler('pending_rake', ETAPA).pending).toBe(100);
  });

  it('o pendente nunca fica negativo', async () => {
    guardar('pending_rake', { id: ETAPA, pending: 50 });
    await applySangria({ stage_id: ETAPA, amount: 1000 });
    expect(ler('pending_rake', ETAPA).pending).toBe(0);
  });

  it('o rake nunca passa do valor retirado', async () => {
    // Dado inconsistente (pendente maior que o caixa) não pode produzir uma
    // sangria líquida negativa.
    guardar('pending_rake', { id: ETAPA, pending: 5000 });
    const r = await applySangria({ stage_id: ETAPA, amount: 100 });
    expect(r.rake).toBe(100);
    expect(r.net).toBe(0);
  });

  it('caixa zerado não tenta dividir por zero', async () => {
    guardar('stage_cash_register', { id: ETAPA, current_balance: 0 });
    const r = await applySangria({ stage_id: ETAPA, amount: 100 });
    expect(r.rake).toBe(0);
    expect(r.net).toBe(100);
  });

  it('sem rake pendente a sangria sai inteira', async () => {
    memoria.delete(`pending_rake:${ETAPA}`);
    const r = await applySangria({ stage_id: ETAPA, amount: 400 });
    expect(r.rake).toBe(0);
    expect(r.net).toBe(400);
  });

  it('etapa sem caixa na réplica não quebra', async () => {
    memoria.delete(`stage_cash_register:${ETAPA}`);
    expect(await applySangria({ stage_id: ETAPA, amount: 100 })).toEqual({
      rake: 0,
      net: 100,
    });
  });

  it('arredonda para centavos', async () => {
    // Sem arredondar, o float acumula resto e a tela mostra 12 casas.
    guardar('stage_cash_register', { id: ETAPA, current_balance: 3 });
    guardar('pending_rake', { id: ETAPA, pending: 1 });
    const r = await applySangria({ stage_id: ETAPA, amount: 1 });
    expect(r.rake).toBe(0.33);
    expect(r.net).toBe(0.67);
  });
});

describe('cadastro de jogador offline', () => {
  it('grava usando o id do cliente como chave', async () => {
    // O mesmo uuid vai para o servidor no sync, então a inscrição feita em
    // seguida continua apontando para o jogador certo.
    await applyPlayerCreate({ client_id: 'jog-local-1', name: 'Fulano' });
    const jogador = ler('players', 'jog-local-1');
    expect(jogador.name).toBe('Fulano');
    expect(jogador._offline).toBe(true);
  });
});

describe('eliminação', () => {
  beforeEach(async () => {
    await applyRegister(corpoRegistro());
  });

  it('marca o status e o horário', async () => {
    const { tp } = await applyEliminate({ tournament_player_id: 'tp-local-1' });
    expect(tp.status).toBe('eliminated');
    expect(tp.eliminated_at).toBeTruthy();
  });

  it('inscrição inexistente devolve null', async () => {
    expect(await applyEliminate({ tournament_player_id: 'x' })).toBeNull();
  });
});
