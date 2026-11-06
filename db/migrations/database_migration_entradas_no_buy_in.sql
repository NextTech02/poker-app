-- Buy-in que vale mais de uma entrada ("Buy-in Doble").
--
-- Continuação de database_migration_entradas_por_meio.sql, que limitava a
-- configuração à recompra. O clube decide quanto cada meio vale, então a Entrada
-- também pode valer mais de uma.
--
-- A diferença para a recompra: `buy_in_count` é também a base de ATIVOS, e uma
-- pessoa senta na mesa, não duas. Por isso a entrada a mais fica guardada à parte:
--
--   tournament_players.extra_entries  entradas além da pessoa. No "Buy-in Doble",
--                                     buy_in_count é 2 e extra_entries é 1.
--
--   ENTRADAS = Σ buy_in_count                  o que o salão confere no telão
--   PESSOAS  = Σ buy_in_count − Σ extra_entries  quem senta
--   ATIVOS   = PESSOAS − eliminations_count
--
-- Quem lê `buy_in_count` para mostrar entradas (TV, relatórios, painéis, campo da
-- Premiação) segue igual e passa a somar N. `entradas_do_dia`, o teto das
-- eliminações, passa a contar pessoas.
--
-- Add-on, taxa e meio por equipe continuam valendo 1: o meio por equipe é cobrado
-- de cada integrante à parte, sem passar pela inscrição.
--
-- Vendas feitas antes da migração continuam valendo 1.
--
-- Rodar ANTES do deploy do backend: ele lê `extra_entries` no relógio da TV e na
-- conta de ativos, e sem a coluna essas leituras falham. O código antigo segue
-- funcionando depois dela: a coluna tem padrão 0.

BEGIN;

ALTER TABLE public.tournament_players
  ADD COLUMN IF NOT EXISTS extra_entries integer NOT NULL DEFAULT 0;

ALTER TABLE public.tournament_players
  DROP CONSTRAINT IF EXISTS tournament_players_extra_entries_check;
ALTER TABLE public.tournament_players
  ADD CONSTRAINT tournament_players_extra_entries_check CHECK (extra_entries >= 0);

ALTER TABLE public.buy_types
  DROP CONSTRAINT IF EXISTS buy_types_entry_count_check;
ALTER TABLE public.buy_types
  ADD CONSTRAINT buy_types_entry_count_check
  CHECK (entry_count BETWEEN 1 AND 10
         AND (entry_count = 1 OR (category IN ('buy_in', 'rebuy') AND NOT per_team)));

-- Teto das eliminações: pessoas, não entradas. Só a soma mudou.
CREATE OR REPLACE FUNCTION public.entradas_do_dia(p_day_id uuid)
 RETURNS integer
 LANGUAGE sql
 STABLE
 SET search_path TO 'pg_catalog', 'public'
AS $function$
  SELECT GREATEST(
    COALESCE((
      SELECT SUM(COALESCE(tp.buy_in_count, 0) - COALESCE(tp.extra_entries, 0))
           + COUNT(*) FILTER (WHERE tp.is_qualified_entry
                                AND COALESCE(tp.status, '') <> 'cancelled')
        FROM public.tournament_players tp
       WHERE tp.tournament_day_id = p_day_id
    ), 0),
    COALESCE((
      SELECT CASE WHEN d.day_type = 'final'
                  THEN COALESCE(d.registered_players, 0) ELSE 0 END
        FROM public.tournament_days d
       WHERE d.id = p_day_id
    ), 0)
  )::int;
$function$;

-- Relatório do período: buy-ins em entradas, não em linhas.
CREATE OR REPLACE FUNCTION public.get_reports_totals(p_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(total_revenue numeric, total_buy_ins integer, total_rebuys integer, total_addons integer, avg_buy_in numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT
    COALESCE(sum(amount) FILTER (WHERE type IN ('buy_in','rebuy','addon')),0)::numeric,
    COALESCE(sum(entry_count) FILTER (WHERE type='buy_in'),0)::int,
    COALESCE(sum(entry_count) FILTER (WHERE type='rebuy'),0)::int,
    count(*) FILTER (WHERE type='addon' AND NOT COALESCE(is_fee, false))::int,
    COALESCE(avg(amount) FILTER (WHERE type='buy_in'),0)::numeric
  FROM transactions
  WHERE (p_start IS NULL OR created_at >= p_start)
    AND (p_end IS NULL OR created_at <= p_end)
    AND COALESCE(status,'active') = 'active';
$function$;

-- Estorno do buy-in: zera os extras junto. Só essa linha mudou.
CREATE OR REPLACE FUNCTION public.undo_entry_counters_once(p_transaction_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tx        public.transactions%rowtype;
  v_dia_id    uuid;
  v_modo      text;
  v_fichas    integer;
  v_inseridos int;
BEGIN
  SELECT * INTO v_tx FROM public.transactions WHERE id = p_transaction_id;
  IF NOT FOUND OR v_tx.tournament_player_id IS NULL THEN
    RETURN false;
  END IF;
  IF COALESCE(v_tx.type, '') NOT IN ('buy_in', 'rebuy', 'addon') THEN
    RETURN false;
  END IF;

  INSERT INTO public.transaction_counter_refunds
    (transaction_id, tournament_player_id, organization_id)
  VALUES (p_transaction_id, v_tx.tournament_player_id, v_tx.organization_id)
  ON CONFLICT (transaction_id) DO NOTHING;
  GET DIAGNOSTICS v_inseridos = ROW_COUNT;
  IF v_inseridos = 0 THEN
    RETURN false;
  END IF;

  SELECT tp.tournament_day_id, COALESCE(t.elimination_mode, 'bulk')
    INTO v_dia_id, v_modo
    FROM public.tournament_players tp
    LEFT JOIN public.tournaments t ON t.id = tp.tournament_id
   WHERE tp.id = v_tx.tournament_player_id;

  IF v_tx.type = 'rebuy' THEN
    SELECT COALESCE(v_tx.chips, rebuy_chips, 0) INTO v_fichas
      FROM public.tournament_days WHERE id = v_dia_id;
    v_fichas := COALESCE(v_fichas, COALESCE(v_tx.chips, 0));
    UPDATE public.tournament_players
       SET rebuy_count        = GREATEST(COALESCE(rebuy_count, 0) - COALESCE(v_tx.entry_count, 1), 0),
           total_rebuy_amount = GREATEST(COALESCE(total_rebuy_amount, 0) - COALESCE(v_tx.amount, 0), 0),
           total_chips        = GREATEST(COALESCE(total_chips, 0) - COALESCE(v_fichas, 0), 0)
     WHERE id = v_tx.tournament_player_id;

    IF v_dia_id IS NOT NULL THEN
      IF v_modo = 'table' THEN
        UPDATE public.tournament_players
           SET status        = 'eliminated',
               eliminated_at = COALESCE(eliminated_at, now())
         WHERE id = v_tx.tournament_player_id
           AND status IN ('active', 'registered');
        PERFORM public.recontar_eliminacoes(v_dia_id);
      ELSIF COALESCE(v_tx.client_id, '') !~ ':[1-9][0-9]*$' THEN
        PERFORM public.registrar_eliminacao(v_dia_id, 1);
      END IF;
    END IF;
  ELSIF v_tx.type = 'addon' AND COALESCE(v_tx.is_fee, false) THEN
    v_fichas := COALESCE(v_tx.chips, 0);
    UPDATE public.tournament_players
       SET fee_count        = GREATEST(COALESCE(fee_count, 0) - 1, 0),
           total_fee_amount = GREATEST(COALESCE(total_fee_amount, 0) - COALESCE(v_tx.amount, 0), 0),
           total_chips      = GREATEST(COALESCE(total_chips, 0) - COALESCE(v_fichas, 0), 0)
     WHERE id = v_tx.tournament_player_id;
  ELSIF v_tx.type = 'addon' THEN
    SELECT COALESCE(v_tx.chips, addon_chips, 0) INTO v_fichas
      FROM public.tournament_days WHERE id = v_dia_id;
    v_fichas := COALESCE(v_fichas, COALESCE(v_tx.chips, 0));
    UPDATE public.tournament_players
       SET addon_count        = GREATEST(COALESCE(addon_count, 0) - 1, 0),
           total_addon_amount = GREATEST(COALESCE(total_addon_amount, 0) - COALESCE(v_tx.amount, 0), 0),
           total_chips        = GREATEST(COALESCE(total_chips, 0) - COALESCE(v_fichas, 0), 0)
     WHERE id = v_tx.tournament_player_id;
  ELSE
    UPDATE public.tournament_players
       SET status               = 'cancelled',
           total_buy_in_amount  = 0,
           buy_in_count         = 0,
           extra_entries        = 0,
           total_chips          = 0
     WHERE id = v_tx.tournament_player_id;

    IF v_dia_id IS NOT NULL THEN
      UPDATE public.tournament_days
         SET registered_players = GREATEST(COALESCE(registered_players, 0) - 1, 0)
       WHERE id = v_dia_id;

      IF v_modo = 'table' THEN
        PERFORM public.recontar_eliminacoes(v_dia_id);
      ELSE
        UPDATE public.tournament_days d
           SET eliminations_count = LEAST(COALESCE(d.eliminations_count, 0),
                                          public.entradas_do_dia(d.id))
         WHERE d.id = v_dia_id;
      END IF;
    END IF;
  END IF;

  UPDATE public.tournament_players
     SET total_spent = COALESCE(total_buy_in_amount, 0)
                     + COALESCE(total_rebuy_amount, 0)
                     + COALESCE(total_addon_amount, 0)
                     + COALESCE(total_fee_amount, 0)
   WHERE id = v_tx.tournament_player_id;

  RETURN true;
END $function$;

COMMIT;
