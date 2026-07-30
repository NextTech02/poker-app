-- Histórico/estatísticas do jogador — reescreve a view player_statistics com o
-- conjunto completo de métricas.
--
-- Mantém security_invoker=on: a view roda com o RLS do usuário, então já é
-- ISOLADA por organização (uma view sem isso furaria o multi-tenant, como as
-- funções SECURITY DEFINER que foram corrigidas antes).
--
-- Fonte de premiação: prize_allocations (onde a Premiação grava player_id +
-- prize_amount). tp.prize_won é legado e fica sempre 0, então NÃO é usado.
-- Agregação de prêmios num CTE separado para não multiplicar por join (fan-out).

-- DROP + CREATE (não CREATE OR REPLACE): a nova ordem/renome de colunas não é
-- permitida por REPLACE.
DROP VIEW IF EXISTS public.player_statistics;

CREATE VIEW public.player_statistics
WITH (security_invoker = on) AS
WITH tp_agg AS (
  SELECT
    tp.player_id,
    count(*)                                        AS entries,
    count(DISTINCT tp.tournament_id)                AS tournaments_played,
    count(DISTINCT tp.tournament_day_id)            AS days_played,
    COALESCE(sum(tp.buy_in_count), 0)               AS total_buy_ins,
    COALESCE(sum(tp.rebuy_count), 0)                AS total_rebuys,
    COALESCE(sum(tp.addon_count), 0)                AS total_addons,
    COALESCE(sum(tp.total_buy_in_amount), 0)        AS total_buy_in_amount,
    COALESCE(sum(tp.total_rebuy_amount), 0)         AS total_rebuy_amount,
    COALESCE(sum(tp.total_addon_amount), 0)         AS total_addon_amount,
    COALESCE(sum(tp.total_spent), 0)                AS total_spent,
    count(*) FILTER (WHERE tp.final_position = 1)   AS first_places,
    count(*) FILTER (WHERE tp.final_position <= 3)  AS top_3_finishes,
    count(*) FILTER (WHERE tp.final_position IS NOT NULL) AS finished_count,
    count(*) FILTER (WHERE tp.status = 'eliminated') AS eliminated_count,
    min(tp.final_position)                          AS best_position,
    avg(tp.final_position)                          AS avg_position,
    min(tp.registered_at)                           AS first_played,
    max(tp.registered_at)                           AS last_played
  FROM public.tournament_players tp
  GROUP BY tp.player_id
),
prize_agg AS (
  SELECT
    pa.player_id,
    COALESCE(sum(pa.prize_amount) FILTER (WHERE pa.prize_type = 'cash'), 0) AS total_prizes,
    count(*)                                        AS prize_count
  FROM public.prize_allocations pa
  WHERE pa.player_id IS NOT NULL
  GROUP BY pa.player_id
)
SELECT
  p.id,
  p.name,
  p.nickname,
  COALESCE(t.tournaments_played, 0)                 AS tournaments_played,
  COALESCE(t.entries, 0)                            AS entries,
  COALESCE(t.days_played, 0)                        AS days_played,
  COALESCE(t.total_buy_ins, 0)                      AS total_buy_ins,
  COALESCE(t.total_rebuys, 0)                       AS total_rebuys,
  COALESCE(t.total_addons, 0)                       AS total_addons,
  COALESCE(t.total_buy_in_amount, 0)                AS total_buy_in_amount,
  COALESCE(t.total_rebuy_amount, 0)                 AS total_rebuy_amount,
  COALESCE(t.total_addon_amount, 0)                 AS total_addon_amount,
  COALESCE(t.total_spent, 0)                        AS total_spent,
  COALESCE(pr.total_prizes, 0)                      AS total_prizes,
  COALESCE(pr.total_prizes, 0) - COALESCE(t.total_spent, 0) AS net_profit,
  COALESCE(t.first_places, 0)                       AS first_places,
  COALESCE(t.top_3_finishes, 0)                     AS top_3_finishes,
  COALESCE(pr.prize_count, 0)                       AS itm_count,
  COALESCE(t.eliminated_count, 0)                   AS eliminated_count,
  t.best_position,
  t.avg_position,
  t.first_played,
  t.last_played,
  -- taxas em 0..1 (o frontend formata como %)
  CASE WHEN COALESCE(t.tournaments_played, 0) > 0
       THEN t.first_places::numeric / t.tournaments_played ELSE 0 END        AS win_rate,
  CASE WHEN COALESCE(t.tournaments_played, 0) > 0
       THEN COALESCE(pr.prize_count, 0)::numeric / t.tournaments_played ELSE 0 END AS itm_rate,
  CASE WHEN COALESCE(t.entries, 0) > 0
       THEN COALESCE(t.total_rebuys, 0)::numeric / t.entries ELSE 0 END      AS rebuy_rate,
  CASE WHEN COALESCE(t.total_spent, 0) > 0
       THEN (COALESCE(pr.total_prizes, 0) - t.total_spent) / t.total_spent ELSE 0 END AS roi
FROM public.players p
LEFT JOIN tp_agg t   ON t.player_id = p.id
LEFT JOIN prize_agg pr ON pr.player_id = p.id;
