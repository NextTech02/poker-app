-- Migration: bulk_update_chip_counts RPC (perf)
-- Description: atualiza final_chip_count de vários jogadores de um dia num único
--   UPDATE set-based (unnest dos arrays) em vez de 1 update por jogador (N+1).
--   Usado por TournamentDayService.bulk_update_chips (com fallback no app).

CREATE OR REPLACE FUNCTION public.bulk_update_chip_counts(
  p_day_id uuid,
  p_player_ids uuid[],
  p_chips integer[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  n integer;
BEGIN
  UPDATE tournament_players tp
  SET final_chip_count = data.chips
  FROM (
    SELECT unnest(p_player_ids) AS pid, unnest(p_chips) AS chips
  ) AS data
  WHERE tp.tournament_day_id = p_day_id
    AND tp.player_id = data.pid;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
