-- Migration: get_tournament_summary RPC (single round-trip aggregation)
-- Description: Replaces the O(1 + N + N*M) per-row query cascade in
--   TournamentService.get_tournament_summary with ONE database call.
--   The function aggregates entries/day-counts per tournament with GROUP BY,
--   derives each tournament's status from its days, persists the derived status
--   (only when it actually changed), and returns the full summary as a JSON
--   array. The backend maps each element straight into TournamentSummary.
--
--   Relies on existing indexes: idx_tournaments_stage_id,
--   idx_tournament_days_tournament_id, idx_tournament_players_tournament_day_id.
--
-- Params:
--   p_stage_id      uuid - when set, only tournaments of this stage
--   p_tournament_id uuid - when set, only this tournament
-- Returns: jsonb array of tournament summary objects (sponsor_name,
--          total_entries and total_days merged into each tournament row).

CREATE OR REPLACE FUNCTION get_tournament_summary(
    p_stage_id uuid DEFAULT NULL,
    p_tournament_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    result jsonb;
BEGIN
    -- 1) Persist derived status, but only for in-scope tournaments whose
    --    stored status is actually out of sync (keeps writes minimal).
    UPDATE tournaments t
    SET status = der.derived
    FROM (
        SELECT td.tournament_id AS id,
               CASE
                   WHEN bool_or(td.status = 'active') THEN 'active'
                   WHEN bool_or(td.status = 'completed')
                        AND bool_and(td.status IN ('completed', 'cancelled')) THEN 'completed'
                   ELSE 'pending'
               END AS derived
        FROM tournament_days td
        GROUP BY td.tournament_id
    ) der
    WHERE t.id = der.id
      AND t.status IS DISTINCT FROM der.derived
      AND (p_stage_id IS NULL OR t.stage_id = p_stage_id)
      AND (p_tournament_id IS NULL OR t.id = p_tournament_id);

    -- 2) Aggregate and return everything in one shot.
    SELECT coalesce(jsonb_agg(row_obj ORDER BY created_at DESC), '[]'::jsonb)
    INTO result
    FROM (
        SELECT
            to_jsonb(t)
            || jsonb_build_object(
                   'sponsor_name', s.name,
                   'total_entries', coalesce(da.total_entries, 0),
                   'total_days', coalesce(da.total_days, 0)
               ) AS row_obj,
            t.created_at AS created_at
        FROM tournaments t
        LEFT JOIN sponsors s ON s.id = t.sponsor_id
        LEFT JOIN (
            SELECT td.tournament_id,
                   count(*) AS total_days,
                   coalesce(
                       sum(CASE WHEN td.day_type <> 'final' THEN dp.entries ELSE 0 END),
                       0
                   ) AS total_entries
            FROM tournament_days td
            LEFT JOIN (
                SELECT tournament_day_id,
                       sum(coalesce(buy_in_count, 0) + coalesce(rebuy_count, 0)) AS entries
                FROM tournament_players
                GROUP BY tournament_day_id
            ) dp ON dp.tournament_day_id = td.id
            GROUP BY td.tournament_id
        ) da ON da.tournament_id = t.id
        WHERE (p_stage_id IS NULL OR t.stage_id = p_stage_id)
          AND (p_tournament_id IS NULL OR t.id = p_tournament_id)
    ) sub;

    RETURN result;
END;
$$;

COMMENT ON FUNCTION get_tournament_summary(uuid, uuid) IS
    'Single round-trip aggregation for the tournaments list. Returns a jsonb array of tournament summaries (with sponsor_name, total_entries, total_days) and syncs derived status. Replaces the per-row N+1 cascade in the API.';
