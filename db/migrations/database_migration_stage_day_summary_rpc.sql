-- Migration: stage & tournament-day summary RPCs (single round-trip aggregation)
-- Description: One-call aggregations replacing the batched (2 round-trip) paths
--   in StageService.get_stages and TournamentDayService.get_tournament_day_summary.
--   Both return a jsonb array; the backend maps each element into its Pydantic
--   summary model. Backends keep a Python fallback if these aren't deployed yet.

-- ── Stages with tournament_count ──────────────────────────────────────────────
-- p_statuses: optional text[] filter on stages.status (NULL = all).
CREATE OR REPLACE FUNCTION get_stage_summaries(p_statuses text[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT coalesce(
        jsonb_agg(
            to_jsonb(s) || jsonb_build_object('tournament_count', coalesce(tc.cnt, 0))
            ORDER BY s.created_at DESC
        ),
        '[]'::jsonb
    )
    FROM stages s
    LEFT JOIN (
        SELECT stage_id, count(*) AS cnt
        FROM tournaments
        WHERE stage_id IS NOT NULL
        GROUP BY stage_id
    ) tc ON tc.stage_id = s.id
    WHERE p_statuses IS NULL OR s.status = ANY(p_statuses);
$$;

COMMENT ON FUNCTION get_stage_summaries(text[]) IS
    'Single round-trip: all stages (optionally filtered by status array) with their tournament_count.';

-- ── Tournament-day summaries with entry/buy-in/rebuy/addon totals ──────────────
CREATE OR REPLACE FUNCTION get_tournament_day_summaries(
    p_tournament_id uuid DEFAULT NULL,
    p_day_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT coalesce(
        jsonb_agg(
            to_jsonb(td) || jsonb_build_object(
                'total_buy_ins', coalesce(a.buy_ins, 0),
                'total_rebuys', coalesce(a.rebuys, 0),
                'total_addons', coalesce(a.addons, 0),
                'total_entries', coalesce(a.buy_ins, 0) + coalesce(a.rebuys, 0)
            )
            ORDER BY td.day_number ASC
        ),
        '[]'::jsonb
    )
    FROM tournament_days td
    LEFT JOIN (
        SELECT tournament_day_id,
               sum(coalesce(buy_in_count, 0)) AS buy_ins,
               sum(coalesce(rebuy_count, 0)) AS rebuys,
               sum(coalesce(addon_count, 0)) AS addons
        FROM tournament_players
        GROUP BY tournament_day_id
    ) a ON a.tournament_day_id = td.id
    WHERE (p_tournament_id IS NULL OR td.tournament_id = p_tournament_id)
      AND (p_day_id IS NULL OR td.id = p_day_id);
$$;

COMMENT ON FUNCTION get_tournament_day_summaries(uuid, uuid) IS
    'Single round-trip: tournament-day summaries with total_entries/buy_ins/rebuys/addons aggregated per day.';
