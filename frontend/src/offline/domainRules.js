/**
 * Regras de domínio replicadas para o DISPLAY offline exato. Aplicam a mutação na
 * réplica local (`entities`) espelhando o que o backend + triggers fazem, para que
 * as telas mostrem os mesmos valores estando offline. A fonte da verdade continua
 * sendo o servidor (o pull-refresh sobrescreve tudo no sync).
 *
 * Paridade (mantenha em sincronia com o servidor):
 *  - valor/rake/chips  ⇐ do MEIO DE ENTRADA (buy_types) quando há buy_type_id,
 *    com o dia como reserva ⇐ tournament_player_service.register_player /
 *    add_rebuy / add_addon
 *  - stage_cash += amount, prize_pool = Σentradas×(1−rake/100), registered_players±1,
 *    total_spent ⇐ triggers (cash_management / fix_prizepool_delete / fix_player_count /
 *    calculate_total_spent).
 *  - sangria proporcional ⇐ cash_register_service.perform_sangria.
 */
import { getEntity, putEntity } from './db';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const nowISO = () => new Date().toISOString();

const rakePctFor = (day, buyType) =>
  buyType && buyType.rake_percentage != null
    ? Number(buyType.rake_percentage)
    : Number((day && day.rake_percentage) || 0);

/**
 * Valor e fichas vêm do MEIO DE ENTRADA quando ele existe; o dia é só reserva
 * (venda pela categoria, réplica ainda não hidratada, cadastro legado).
 *
 * O teste é `!= null` e não "se for verdadeiro" de propósito: zero é um valor
 * legítimo — o dia final costuma ter buy-in zerado, porque quem chega lá vem
 * classificado — e cair na reserva do dia cobraria de quem não deve pagar.
 *
 * Isto TEM de bater com o backend: se o offline calcular diferente, a mesma
 * venda grava valores diferentes conforme a rede, e a divergência só aparece
 * no fechamento do caixa, quando ninguém mais consegue reconstituir o que
 * aconteceu.
 */
/** Tipo LEGADO: o da ETAPA, de quando ele só dizia o rake.
 *
 * Reconhece-se por NÃO pertencer a um TORNEIO — e não por ter campo nulo. Todos
 * eles ficaram com `chips = 0` quando a coluna foi criada (`NOT NULL DEFAULT
 * 0`) e vários têm `amount = 0`, porque naquele desenho o valor vinha sempre do
 * dia. Tratá-los como tipo do torneio entregaria ZERO ficha e cobraria ZERO.
 * (As linhas da época em que a lista era por DIA ganharam `tournament_id` na
 * migração; uma que não tenha ganhado cai aqui também — melhor o preço do dia
 * do que zero.)
 *
 * O backend usa exatamente a mesma regra. Se as duas pontas divergirem, a mesma
 * venda grava valores diferentes conforme haja rede ou não, e a diferença só
 * aparece no fechamento do caixa. */
const ehLegado = (buyType) => !!buyType && !buyType.tournament_id;

/** Valor/fichas: do TIPO quando ele é do torneio; do dia quando é legado ou não
 *  há tipo. Zero configurado no tipo é decisão (uma entrada de cortesia existe),
 *  por isso o teste é `!= null` e não `||`. */
const doTipoOuDoDia = (buyType, campo, reservaDoDia) =>
  buyType && !ehLegado(buyType) && buyType[campo] != null
    ? Number(buyType[campo])
    : Number(reservaDoDia || 0);

/** Aplica um valor de entrada (buy_in/rebuy/addon) ao caixa da etapa + prize pool do dia. */
const bumpStageCashAndPool = async (day, tournamentId, amount, rakePct) => {
  // prize pool do dia (incremental): += amount × (1 − rake/100)
  if (day) {
    const contrib = amount * (1 - rakePct / 100);
    day.prize_pool = round2(Number(day.prize_pool || 0) + contrib);
    await putEntity('tournament_days', day);
  }
  // caixa da etapa (+= amount): resolve stage via tournament na réplica
  const tournament = await getEntity('tournaments', tournamentId);
  const stageId = tournament && tournament.stage_id;
  if (stageId) {
    const sc = await getEntity('stage_cash_register', stageId) ||
      // algumas réplicas guardam por id da linha; tenta por stage_id só
      null;
    if (sc) {
      sc.current_balance = round2(Number(sc.current_balance || 0) + amount);
      sc.total_received = round2(Number(sc.total_received || 0) + amount);
      await putEntity('stage_cash_register', sc);
    }
  }
};

/** Registro de jogador (buy-in). Espelha register_player + triggers. */
export const applyRegister = async (body) => {
  const day = body.tournament_day_id ? await getEntity('tournament_days', body.tournament_day_id) : null;
  const buyType = body.buy_type_id ? await getEntity('buy_types', body.buy_type_id) : null;

  const count = body.buy_in_count || 1;
  const buyIn = doTipoOuDoDia(buyType, 'amount', day && day.buy_in);
  const rakePct = rakePctFor(day, buyType);
  const startingChips = doTipoOuDoDia(buyType, 'chips', day && day.starting_chips);

  const isTicket = body.payment_source === 'ticket';
  const amount = isTicket ? 0 : buyIn * count;
  const totalChips = startingChips * count;

  const tp = {
    id: body.client_id,
    client_id: body.client_id,
    tournament_id: body.tournament_id,
    tournament_day_id: body.tournament_day_id || null,
    player_id: body.player_id,
    buy_in_count: count,
    rebuy_count: 0,
    addon_count: 0,
    total_buy_in_amount: amount,
    total_rebuy_amount: 0,
    total_addon_amount: 0,
    total_chips: totalChips,
    total_spent: amount,
    status: 'active',
    registered_at: nowISO(),
    _offline: true,
  };
  await putEntity('tournament_players', tp);

  const txn = {
    id: body.client_mutation_id,
    client_id: body.client_mutation_id,
    tournament_id: body.tournament_id,
    player_id: body.player_id,
    tournament_player_id: body.client_id,
    type: 'buy_in',
    amount,
    payment_source: body.payment_source || 'cash',
    payment_method: body.payment_method || 'cash',
    buy_type_id: body.buy_type_id || null,
    // Retrato do que foi vendido, como o backend passa a gravar: renomear ou
    // apagar o meio de entrada não pode reescrever o recibo, e o estorno
    // devolve ESTAS fichas — não as que o cadastro disser depois.
    buy_type_name: (buyType && buyType.name) || null,
    chips: totalChips,
    rake_percentage: rakePct,
    rake_amount: round2(amount * rakePct / 100),
    created_at: nowISO(),
    _offline: true,
  };
  await putEntity('transactions', txn);

  if (day) {
    day.registered_players = Number(day.registered_players || 0) + 1;
    await putEntity('tournament_days', day);
    await bumpStageCashAndPool(day, body.tournament_id, amount, rakePct);
  }
  return { tp, txn };
};

/** Rebuy. Espelha add_rebuy (reativa eliminado; valor/rake/fichas do meio de entrada). */
export const applyRebuy = async (body) => {
  const tp = await getEntity('tournament_players', body.tournament_player_id);
  if (!tp) return null;
  const day = tp.tournament_day_id ? await getEntity('tournament_days', tp.tournament_day_id) : null;
  const buyType = body.buy_type_id ? await getEntity('buy_types', body.buy_type_id) : null;
  const amount = doTipoOuDoDia(buyType, 'amount', day && day.rebuy_amount);
  const chips = doTipoOuDoDia(buyType, 'chips', (day && day.rebuy_chips) || 10000);
  const rakePct = rakePctFor(day, buyType);

  // Quantidade: a tela NÃO produz mais vendas com quantidade — um "rebuy duplo"
  // virou um meio de entrada próprio, com valor e fichas próprios, porque ele
  // nunca foi rebuy × 2. O tratamento continua aqui porque a fila offline
  // gravada no aparelho antes desta mudança pode ter itens com `quantity`, e
  // eles precisam ser reaplicados exatamente como foram enfileirados.
  const qtd = Math.max(1, parseInt(body.quantity, 10) || 1);

  tp.rebuy_count = Number(tp.rebuy_count || 0) + qtd;
  tp.total_rebuy_amount = round2(Number(tp.total_rebuy_amount || 0) + amount * qtd);
  tp.total_chips = Number(tp.total_chips || 0) + chips * qtd;
  tp.total_spent = round2(Number(tp.total_spent || 0) + amount * qtd);
  tp.status = 'active';
  await putEntity('tournament_players', tp);

  // Uma LINHA por recompra, com o mesmo sufixo que o backend usa — o relatorio
  // conta linhas, e o replay precisa reconhecer as que ja entraram.
  for (let i = 0; i < qtd; i++) {
  const idDaLinha = qtd === 1 ? body.client_mutation_id : `${body.client_mutation_id}:${i}`;
  await putEntity('transactions', {
    id: idDaLinha,
    client_id: idDaLinha,
    tournament_id: tp.tournament_id,
    player_id: tp.player_id,
    tournament_player_id: tp.id,
    type: 'rebuy',
    amount,
    payment_source: body.payment_source || 'cash',
    payment_method: body.payment_method || 'cash',
    buy_type_id: body.buy_type_id || null,
    buy_type_name: (buyType && buyType.name) || null,
    chips,
    rake_percentage: rakePct,
    rake_amount: round2(amount * rakePct / 100),
    created_at: nowISO(),
    _offline: true,
  });
  }
  if (day) await bumpStageCashAndPool(day, tp.tournament_id, amount * qtd, rakePct);
  return { tp };
};

/** Add-on. Espelha add_addon. */
export const applyAddon = async (body) => {
  const tp = await getEntity('tournament_players', body.tournament_player_id);
  if (!tp) return null;
  const day = tp.tournament_day_id ? await getEntity('tournament_days', tp.tournament_day_id) : null;
  const buyType = body.buy_type_id ? await getEntity('buy_types', body.buy_type_id) : null;
  const amount = doTipoOuDoDia(buyType, 'amount', day && day.addon_amount);
  const chips = doTipoOuDoDia(buyType, 'chips', (day && day.addon_chips) || 10000);
  const rakePct = rakePctFor(day, buyType);

  tp.addon_count = Number(tp.addon_count || 0) + 1;
  tp.total_addon_amount = round2(Number(tp.total_addon_amount || 0) + amount);
  tp.total_chips = Number(tp.total_chips || 0) + chips;
  tp.total_spent = round2(Number(tp.total_spent || 0) + amount);
  await putEntity('tournament_players', tp);

  await putEntity('transactions', {
    id: body.client_mutation_id,
    client_id: body.client_mutation_id,
    tournament_id: tp.tournament_id,
    player_id: tp.player_id,
    tournament_player_id: tp.id,
    type: 'addon',
    amount,
    payment_source: body.payment_source || 'cash',
    payment_method: body.payment_method || 'cash',
    buy_type_id: body.buy_type_id || null,
    buy_type_name: (buyType && buyType.name) || null,
    chips,
    rake_percentage: rakePct,
    rake_amount: round2(amount * rakePct / 100),
    created_at: nowISO(),
    _offline: true,
  });
  if (day) await bumpStageCashAndPool(day, tp.tournament_id, amount, rakePct);
  return { tp };
};

/**
 * Sangria (offline). Rake EXATO = proporcional ao rake pendente da etapa
 * (perform_sangria): rake = pending × amount / saldo, líquido = amount − rake.
 * Usa `stage_cash_register` e `pending_rake` da réplica (hidratados pelo CaixaGeral).
 * Reduz o caixa da etapa e o pending; os singletons geral/rake se acertam no sync.
 */
export const applySangria = async (body) => {
  const amount = Number(body.amount || 0);
  const sc = await getEntity('stage_cash_register', body.stage_id);
  const pr = await getEntity('pending_rake', body.stage_id);
  const bal = sc ? Number(sc.current_balance || 0) : 0;
  const pending = pr ? Number(pr.pending || 0) : 0;

  let rake = bal > 0 ? round2(pending * amount / bal) : 0;
  if (rake > amount) rake = amount;

  if (sc) {
    sc.current_balance = round2(bal - amount);
    sc.total_sangrias = round2(Number(sc.total_sangrias || 0) + amount);
    await putEntity('stage_cash_register', sc);
  }
  if (pr) {
    pr.pending = round2(Math.max(0, pending - rake));
    await putEntity('pending_rake', pr);
  }
  return { rake, net: round2(amount - rake) };
};

/** Cadastro de jogador (offline): grava na réplica com o id do cliente como PK. */
export const applyPlayerCreate = async (body) => {
  await putEntity('players', { ...body, id: body.client_id, _offline: true });
};

/** Eliminação (offline): marca status. Rankings são recalculados no servidor no sync. */
export const applyEliminate = async (body) => {
  const tp = await getEntity('tournament_players', body.tournament_player_id);
  if (!tp) return null;
  tp.status = 'eliminated';
  tp.eliminated_at = nowISO();
  await putEntity('tournament_players', tp);
  return { tp };
};
