-- Migration: recalculate_tournament_rankings RPC (single round-trip)
-- Description: Replaces the per-player UPDATE loop in
--   RankingService.calculate_rankings (N round-trips for N eliminated players)
--   with ONE call. Positions are assigned with a window function in SQL:
--   players are ranked by elimination time (oldest first); the first eliminated
--   gets the highest position and the last eliminated gets position 2
--   (position 1 is reserved for the winner) — identical to the previous logic:
--       position = total_eliminated - row_number() + 2   (row_number over eliminated_at asc)
--   The updated rankings are returned as a jsonb array.

CREATE OR REPLACE FUNCTION recalculate_tournament_rankings(p_tournament_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
    result jsonb;
BEGIN
    WITH elim AS (
        SELECT id,
               row_number() OVER (ORDER BY eliminated_at ASC) AS rn,
               count(*) OVER () AS total
        FROM tournament_players
        WHERE tournament_id = p_tournament_id
          AND status = 'eliminated'
    )
    UPDATE tournament_players tp
    SET final_position = elim.total - elim.rn + 2
    FROM elim
    WHERE tp.id = elim.id;

    SELECT coalesce(
        jsonb_agg(
            jsonb_build_object(
                'player_id', tp.player_id,
                'player_name', p.name,
                'position', tp.final_position,
                'eliminated_at', tp.eliminated_at
            )
            ORDER BY tp.final_position ASC
        ),
        '[]'::jsonb
    )
    INTO result
    FROM tournament_players tp
    JOIN players p ON p.id = tp.player_id
    WHERE tp.tournament_id = p_tournament_id
      AND tp.status = 'eliminated';

    RETURN result;
END;
$$;

COMMENT ON FUNCTION recalculate_tournament_rankings(uuid) IS
    'Single round-trip ranking recalculation: assigns final_position to all eliminated players via a window function (was an N-UPDATE loop) and returns the updated rankings as jsonb.';
