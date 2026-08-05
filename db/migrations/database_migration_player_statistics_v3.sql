-- player_statistics v3: adiciona `final_tables` (mesas finais, top 9) e
-- `hours_played` (horas jogadas = soma de eliminated_at − registered_at das
-- participações finalizadas). Colunas novas ao FINAL (compatível com CREATE OR
-- REPLACE VIEW). Mantém security_invoker=on (respeita o RLS de quem consulta).

create or replace view public.player_statistics
with (security_invoker=on) as
 WITH tp_agg AS (
         SELECT tp.player_id,
            count(*) AS entries,
            count(DISTINCT tp.tournament_id) AS tournaments_played,
            count(DISTINCT tp.tournament_day_id) AS days_played,
            COALESCE(sum(tp.buy_in_count), 0::bigint) AS total_buy_ins,
            COALESCE(sum(tp.rebuy_count), 0::bigint) AS total_rebuys,
            COALESCE(sum(tp.addon_count), 0::bigint) AS total_addons,
            COALESCE(sum(tp.total_buy_in_amount), 0::numeric) AS total_buy_in_amount,
            COALESCE(sum(tp.total_rebuy_amount), 0::numeric) AS total_rebuy_amount,
            COALESCE(sum(tp.total_addon_amount), 0::numeric) AS total_addon_amount,
            COALESCE(sum(tp.total_spent), 0::numeric) AS total_spent,
            count(*) FILTER (WHERE tp.final_position = 1) AS first_places,
            count(*) FILTER (WHERE tp.final_position <= 3) AS top_3_finishes,
            count(*) FILTER (WHERE tp.final_position IS NOT NULL) AS finished_count,
            count(*) FILTER (WHERE tp.status::text = 'eliminated'::text) AS eliminated_count,
            min(tp.final_position) AS best_position,
            avg(tp.final_position) AS avg_position,
            min(tp.registered_at) AS first_played,
            max(tp.registered_at) AS last_played,
            count(*) FILTER (WHERE tp.final_position >= 1 AND tp.final_position <= 9) AS final_tables,
            COALESCE(sum(EXTRACT(epoch FROM (tp.eliminated_at - tp.registered_at)))
                     FILTER (WHERE tp.eliminated_at IS NOT NULL
                             AND tp.registered_at IS NOT NULL
                             AND tp.eliminated_at > tp.registered_at), 0::numeric) / 3600.0 AS hours_played
           FROM tournament_players tp
          GROUP BY tp.player_id
        ), prize_agg AS (
         SELECT pa.player_id,
            COALESCE(sum(pa.prize_amount) FILTER (WHERE pa.prize_type::text = 'cash'::text), 0::numeric) AS total_prizes,
            count(*) AS prize_count
           FROM prize_allocations pa
          WHERE pa.player_id IS NOT NULL
          GROUP BY pa.player_id
        )
 SELECT p.id,
    p.name,
    p.nickname,
    COALESCE(t.tournaments_played, 0::bigint) AS tournaments_played,
    COALESCE(t.entries, 0::bigint) AS entries,
    COALESCE(t.days_played, 0::bigint) AS days_played,
    COALESCE(t.total_buy_ins, 0::bigint) AS total_buy_ins,
    COALESCE(t.total_rebuys, 0::bigint) AS total_rebuys,
    COALESCE(t.total_addons, 0::bigint) AS total_addons,
    COALESCE(t.total_buy_in_amount, 0::numeric) AS total_buy_in_amount,
    COALESCE(t.total_rebuy_amount, 0::numeric) AS total_rebuy_amount,
    COALESCE(t.total_addon_amount, 0::numeric) AS total_addon_amount,
    COALESCE(t.total_spent, 0::numeric) AS total_spent,
    COALESCE(pr.total_prizes, 0::numeric) AS total_prizes,
    COALESCE(pr.total_prizes, 0::numeric) - COALESCE(t.total_spent, 0::numeric) AS net_profit,
    COALESCE(t.first_places, 0::bigint) AS first_places,
    COALESCE(t.top_3_finishes, 0::bigint) AS top_3_finishes,
    COALESCE(pr.prize_count, 0::bigint) AS itm_count,
    COALESCE(t.eliminated_count, 0::bigint) AS eliminated_count,
    t.best_position,
    t.avg_position,
    t.first_played,
    t.last_played,
        CASE
            WHEN COALESCE(t.tournaments_played, 0::bigint) > 0 THEN t.first_places::numeric / t.tournaments_played::numeric
            ELSE 0::numeric
        END AS win_rate,
        CASE
            WHEN COALESCE(t.tournaments_played, 0::bigint) > 0 THEN COALESCE(pr.prize_count, 0::bigint)::numeric / t.tournaments_played::numeric
            ELSE 0::numeric
        END AS itm_rate,
        CASE
            WHEN COALESCE(t.entries, 0::bigint) > 0 THEN COALESCE(t.total_rebuys, 0::bigint)::numeric / t.entries::numeric
            ELSE 0::numeric
        END AS rebuy_rate,
        CASE
            WHEN COALESCE(t.total_spent, 0::numeric) > 0::numeric THEN (COALESCE(pr.total_prizes, 0::numeric) - t.total_spent) / t.total_spent
            ELSE 0::numeric
        END AS roi,
    COALESCE(t.final_tables, 0::bigint) AS final_tables,
    COALESCE(t.hours_played, 0::numeric) AS hours_played
   FROM players p
     LEFT JOIN tp_agg t ON t.player_id = p.id
     LEFT JOIN prize_agg pr ON pr.player_id = p.id;
