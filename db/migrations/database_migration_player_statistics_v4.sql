-- ============================================================================
-- player_statistics v4: o perfil do jogador para de contar torneio que ele NÃO
-- disputou.
-- ----------------------------------------------------------------------------
-- Quando um buy-in é cancelado, o estorno zera o dinheiro e os contadores da
-- inscrição e marca a linha de `tournament_players` como 'cancelled'
-- (database_migration_cancel_sale.sql, seção 2 — a linha NUNCA é apagada,
-- porque `transactions.tournament_player_id` é ON DELETE CASCADE e apagá-la
-- levaria junto o histórico financeiro do jogador).
--
-- A v3 agregava `tournament_players` SEM olhar o status. Os valores somavam
-- zero (o estorno já os zerou), mas os três contadores de LINHA continuavam
-- contando a inscrição desfeita:
--     count(*)                          -> entries
--     count(DISTINCT tp.tournament_id)  -> tournaments_played
--     count(DISTINCT tp.tournament_day_id) -> days_played
-- Resultado: no perfil aparecia "12 torneios disputados" para quem jogou 11 —
-- e o cálculo de win_rate, itm_rate, rebuy_rate e ROI, que dividem por esses
-- contadores, saía menor do que a realidade. O jogador cobra o clube pelo
-- ranking dele, então esse número precisa bater.
--
-- A correção é filtrar a inscrição cancelada JÁ NA CTE: uma inscrição desfeita
-- não é entrada, não é torneio disputado, não é dia jogado e não entra na
-- primeira/última participação.
--
-- ADITIVA e IDEMPOTENTE: CREATE OR REPLACE VIEW com EXATAMENTE as mesmas
-- colunas (mesmos nomes, mesma ordem, mesmos tipos) da v3 — é o que o Postgres
-- exige para o REPLACE funcionar. Nenhuma mudança de código acompanha esta
-- migração: o backend lê as mesmas colunas antes e depois, então rodar a
-- migração antes ou depois do deploy dá no mesmo.
--
-- Tolerante a banco antigo: se nenhuma linha tiver status 'cancelled' (base sem
-- a migração do cancelamento), o filtro não descarta nada e a view devolve
-- exatamente os números de hoje. O COALESCE cobre a linha com status nulo.
--
-- Mantém security_invoker=on: a view respeita o RLS de quem consulta, e não o
-- do dono — sem isso um clube veria a estatística do jogador de outro
-- (ver database_migration_saas_phase5_fix_definer_leak.sql).
-- ============================================================================

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
          -- <<< v4: inscrição desfeita por cancelamento de buy-in não conta em
          -- NADA. Ela fica na base só para a auditoria da venda estornada.
          WHERE COALESCE(tp.status::text, '') <> 'cancelled'::text
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

COMMENT ON VIEW public.player_statistics IS
  'Estatísticas por jogador. v4: ignora inscrições com status cancelled (buy-in estornado) — '
  'elas ficam na base para auditoria da venda, mas não são torneio disputado nem entrada.';
