-- ============================================================================
-- Estrutura de blinds: reordenar os níveis de um dia numa transação só
-- ============================================================================
-- POR QUE: arrastar um nível (ou um intervalo) na tela de estrutura gravava a
-- nova ordem nível a nível (um PATCH por linha). O índice único
-- `idx_blinds_day_level_unique (tournament_day_id, level)` recusa a primeira
-- linha que pula para a posição de outra — era o erro que o diretor via ao
-- arrastar para cima ou para baixo.
--
-- Esta função recebe a ORDEM inteira (array de ids, na posição final) e
-- renumera em duas fases dentro de UMA transação: primeiro tira todos os
-- níveis do caminho do índice (deslocamento positivo, porque `level` tem
-- CHECK (level > 0)), depois grava a posição final. Se qualquer passo falhar,
-- nada muda.
--
-- SECURITY INVOKER: a RLS de `blinds` vale para quem chama (o backend chama
-- como o usuário da requisição).
--
-- Chamada pelo backend em PUT /tournament-days/{id}/blinds/order, que antes
-- valida a lista e, com o dia em andamento, trava os níveis até o atual.
--
-- IDEMPOTENTE.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.reorder_day_blinds(p_day_id uuid, p_ids uuid[])
RETURNS integer
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_total integer;
  v_n integer := coalesce(array_length(p_ids, 1), 0);
BEGIN
  SELECT count(*) INTO v_total
    FROM public.blinds
   WHERE tournament_day_id = p_day_id;

  IF v_n <> v_total
     OR (SELECT count(DISTINCT u) FROM unnest(p_ids) AS u) <> v_n
     OR EXISTS (
          SELECT 1
            FROM unnest(p_ids) AS u(id)
           WHERE NOT EXISTS (
                   SELECT 1 FROM public.blinds b
                    WHERE b.id = u.id AND b.tournament_day_id = p_day_id))
  THEN
    RAISE EXCEPTION 'ordem_incompleta: a lista precisa ter exatamente os blinds do dia'
      USING ERRCODE = 'P0001';
  END IF;

  -- Fase 1: tira todo mundo do caminho do índice único (dia, nível).
  UPDATE public.blinds
     SET level = level + 100000
   WHERE tournament_day_id = p_day_id;

  -- Fase 2: posição final = índice na lista.
  UPDATE public.blinds AS b
     SET level = u.ord::integer,
         updated_at = now()
    FROM unnest(p_ids) WITH ORDINALITY AS u(id, ord)
   WHERE b.id = u.id
     AND b.tournament_day_id = p_day_id;

  RETURN v_total;
END
$$;

COMMENT ON FUNCTION public.reorder_day_blinds(uuid, uuid[]) IS
  'Renumera os blinds de um dia na ordem do array (posição = nível), em uma transação. '
  'Usada pelo arrastar da tela de estrutura; nível a nível colidia com o índice único.';

GRANT EXECUTE ON FUNCTION public.reorder_day_blinds(uuid, uuid[]) TO authenticated, service_role;
