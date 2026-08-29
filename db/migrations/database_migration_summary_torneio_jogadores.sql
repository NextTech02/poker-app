-- ============================================================================
-- A lista de torneios voltou a contar jogadores
-- ============================================================================
-- Já APLICADA em produção (Supabase) em 29/08/2026.
--
-- SINTOMA: o card do torneio mostrava "0 jogadores" num torneio com DEZ
-- inscritos e o timer rodando.
--
-- CAUSA: esta função é o caminho PRINCIPAL do resumo — o código Python
-- (`_get_tournament_summary_batched`) é só o fallback de quando ela não existe.
-- Quando a contagem foi corrigida no Python ("recompra e add-on não criam
-- jogador novo"), esta função ficou para trás:
--
--   * não devolvia `total_players` nem `total_reentries`. O Pydantic preenchia
--     com o padrão do modelo, que é ZERO — daí o "0 jogadores" na tela, sem
--     nenhum erro em lugar nenhum;
--   * `total_entries` continuava sendo buy-ins + recompras, exatamente a
--     fórmula que o cliente pediu para mudar. A correção nunca teve efeito
--     nesta tela, porque o RPC responde primeiro.
--
-- É o SEGUNDO caso do mesmo tipo nesta base (o outro foi o estorno de fichas,
-- corrigido no Python e esquecido na função SQL). Ao mexer em contagem ou em
-- dinheiro, procure o par SQL antes de dar por encerrado.
--
-- Os TRÊS números são coisas distintas:
--   entrada   = buy-in. Quem recompra voltou ao torneio, não entrou de novo.
--   jogador   = uma pessoa na mesa, por mais que recompre. Inscrição estornada
--               não conta.
--   reentrada = recompra + add-on, que o clube escolhe se exibe.
--
-- CONFERIDO em produção: os 27 torneios devolvem números idênticos pelos dois
-- caminhos (RPC e fallback em Python).
-- ============================================================================
CREATE OR REPLACE FUNCTION public.get_tournament_summary(p_stage_id uuid DEFAULT NULL::uuid, p_tournament_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    result jsonb;
BEGIN
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

    SELECT coalesce(jsonb_agg(row_obj ORDER BY created_at DESC), '[]'::jsonb)
    INTO result
    FROM (
        SELECT
            to_jsonb(t)
            || jsonb_build_object(
                   'sponsor_name',    s.name,
                   'total_entries',   coalesce(da.total_entries, 0),
                   'total_players',   coalesce(da.total_players, 0),
                   'total_reentries', coalesce(da.total_reentries, 0),
                   'total_days',      coalesce(da.total_days, 0)
               ) AS row_obj,
            t.created_at AS created_at
        FROM tournaments t
        LEFT JOIN sponsors s ON s.id = t.sponsor_id
        LEFT JOIN (
            SELECT td.tournament_id,
                   count(*) AS total_days,
                   -- O dia FINAL não entra: quem chega lá veio classificado do
                   -- dia anterior, e contá-lo somaria a mesma pessoa duas vezes.
                   coalesce(sum(CASE WHEN td.day_type <> 'final' THEN dp.entries    ELSE 0 END), 0) AS total_entries,
                   coalesce(sum(CASE WHEN td.day_type <> 'final' THEN dp.jogadores  ELSE 0 END), 0) AS total_players,
                   coalesce(sum(CASE WHEN td.day_type <> 'final' THEN dp.reentradas ELSE 0 END), 0) AS total_reentries
            FROM tournament_days td
            LEFT JOIN (
                SELECT tournament_day_id,
                       sum(coalesce(buy_in_count, 0))                              AS entries,
                       count(*) FILTER (WHERE coalesce(status, '') <> 'cancelled')  AS jogadores,
                       sum(coalesce(rebuy_count, 0) + coalesce(addon_count, 0))     AS reentradas
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
$function$;
