-- Quantas entradas um meio de entrada vale.
--
-- A "Reentrada Doble" é UMA venda com valor e fichas próprios, mas para o clube
-- ela é DUAS reentradas: os jogadores multiplicam o total de entradas pelo valor
-- da entrada e conferem o arrecadado no telão. Contada como uma, a conta não fecha.
--
--   buy_types.entry_count     o que o clube configura.
--   transactions.entry_count  congelado na venda, como `chips`: o estorno devolve
--                             o que a venda somou mesmo que o meio mude depois.
--
-- Só RECOMPRA pode valer mais de uma. Em Entrada, `buy_in_count` também multiplica
-- o preço e é a base de ATIVOS: uma pessoa senta na mesa, não duas.
--
-- `tournament_players.rebuy_count` passa a somar entradas, não vendas. É ele que a
-- TV, os painéis e os relatórios leem, e também o tamanho do campo da Premiação
-- (lugares pagos). Dinheiro e fichas não mudam: vêm das somas de cada venda.
--
-- Vendas feitas antes da migração continuam valendo 1.
--
-- Rodar ANTES do deploy do backend. O código antigo segue funcionando depois dela:
-- as colunas têm padrão 1.

BEGIN;

ALTER TABLE public.buy_types
  ADD COLUMN IF NOT EXISTS entry_count integer NOT NULL DEFAULT 1;

ALTER TABLE public.buy_types
  DROP CONSTRAINT IF EXISTS buy_types_entry_count_check;
ALTER TABLE public.buy_types
  ADD CONSTRAINT buy_types_entry_count_check
  CHECK (entry_count BETWEEN 1 AND 10 AND (entry_count = 1 OR category = 'rebuy'));

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS entry_count integer NOT NULL DEFAULT 1;

ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_entry_count_check;
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_entry_count_check CHECK (entry_count >= 1);

-- Mudar quanto um meio vale muda o campo da Premiação: entra no registro de atividades.
DROP TRIGGER IF EXISTS trg_log_buy_types_upd ON public.buy_types;
CREATE TRIGGER trg_log_buy_types_upd
  AFTER UPDATE OF name, category, amount, rake_percentage, active, chips, entry_count
  ON public.buy_types
  FOR EACH ROW EXECUTE FUNCTION log_activity();

-- Relatório do período: reentradas em entradas, não em linhas.
CREATE OR REPLACE FUNCTION public.get_reports_totals(p_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(total_revenue numeric, total_buy_ins integer, total_rebuys integer, total_addons integer, avg_buy_in numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT
    COALESCE(sum(amount) FILTER (WHERE type IN ('buy_in','rebuy','addon')),0)::numeric,
    count(*) FILTER (WHERE type='buy_in')::int,
    COALESCE(sum(entry_count) FILTER (WHERE type='rebuy'),0)::int,
    count(*) FILTER (WHERE type='addon' AND NOT COALESCE(is_fee, false))::int,
    COALESCE(avg(amount) FILTER (WHERE type='buy_in'),0)::numeric
  FROM transactions
  WHERE (p_start IS NULL OR created_at >= p_start)
    AND (p_end IS NULL OR created_at <= p_end)
    AND COALESCE(status,'active') = 'active';
$function$;

-- Estorno: a recompra devolve ao contador o que a venda somou. Só essa linha mudou.
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
