/**
 * Regras de domínio replicadas para o DISPLAY offline exato. Aplicam a mutação na
 * réplica local (`entities`) espelhando o que o backend + triggers fazem, para que
 * as telas mostrem os mesmos valores estando offline. A fonte da verdade continua
 * sendo o servidor (o pull-refresh sobrescreve tudo no sync).
 *
 * Paridade (mantenha em sincronia com o servidor):
 *  - valor/rake/chips  ⇐ tournament_player_service.register_player / add_rebuy / add_addon
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
  const buyIn = Number((day && day.buy_in) || 0);
  const rakePct = rakePctFor(day, buyType);
  const startingChips = Number((day && day.starting_chips) || 0);

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

/** Rebuy. Espelha add_rebuy (reativa eliminado; valor/chips do dia). */
export const applyRebuy = async (body) => {
  const tp = await getEntity('tournament_players', body.tournament_player_id);
  if (!tp) return null;
  const day = tp.tournament_day_id ? await getEntity('tournament_days', tp.tournament_day_id) : null;
  const buyType = body.buy_type_id ? await getEntity('buy_types', body.buy_type_id) : null;
  const amount = Number((day && day.rebuy_amount) || 0);
  const chips = Number((day && day.rebuy_chips) || 10000);
  const rakePct = rakePctFor(day, buyType);

  tp.rebuy_count = Number(tp.rebuy_count || 0) + 1;
  tp.total_rebuy_amount = round2(Number(tp.total_rebuy_amount || 0) + amount);
  tp.total_chips = Number(tp.total_chips || 0) + chips;
  tp.total_spent = round2(Number(tp.total_spent || 0) + amount);
  tp.status = 'active';
  await putEntity('tournament_players', tp);

  await putEntity('transactions', {
    id: body.client_mutation_id,
    client_id: body.client_mutation_id,
    tournament_id: tp.tournament_id,
    player_id: tp.player_id,
    tournament_player_id: tp.id,
    type: 'rebuy',
    amount,
    payment_source: body.payment_source || 'cash',
    payment_method: body.payment_method || 'cash',
    buy_type_id: body.buy_type_id || null,
    rake_percentage: rakePct,
    rake_amount: round2(amount * rakePct / 100),
    created_at: nowISO(),
    _offline: true,
  });
  if (day) await bumpStageCashAndPool(day, tp.tournament_id, amount, rakePct);
  return { tp };
};

/** Add-on. Espelha add_addon. */
export const applyAddon = async (body) => {
  const tp = await getEntity('tournament_players', body.tournament_player_id);
  if (!tp) return null;
  const day = tp.tournament_day_id ? await getEntity('tournament_days', tp.tournament_day_id) : null;
  const buyType = body.buy_type_id ? await getEntity('buy_types', body.buy_type_id) : null;
  const amount = Number((day && day.addon_amount) || 0);
  const chips = Number((day && day.addon_chips) || 10000);
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
    rake_percentage: rakePct,
    rake_amount: round2(amount * rakePct / 100),
    created_at: nowISO(),
    _offline: true,
  });
  if (day) await bumpStageCashAndPool(day, tp.tournament_id, amount, rakePct);
  return { tp };
};

/**
 * Sangria (offline): ajuste BEST-EFFORT na réplica. O rake exato = proporcional ao
 * rake pendente da etapa, é recalculado pelo servidor no sync (perform_sangria).
 * Offline reduzimos o caixa da etapa pelo valor sangrado para o display não ficar
 * atrás; o líquido/rake do caixa geral se acertam na reconciliação.
 */
export const applySangria = async (body) => {
  const sc = await getEntity('stage_cash_register', body.stage_id);
  if (sc) {
    sc.current_balance = round2(Number(sc.current_balance || 0) - Number(body.amount || 0));
    sc.total_sangrias = round2(Number(sc.total_sangrias || 0) + Number(body.amount || 0));
    await putEntity('stage_cash_register', sc);
  }
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
