-- ============================================================================
-- Meio de entrada da categoria TAXA (fee)
-- ============================================================================
-- Até aqui os "Bono Dealer", "Bono Simple" e afins eram cadastrados como
-- add-on com rake 100%. O dinheiro dava certo (tudo para a casa, nada no
-- pool nem no KO), mas a venda CONTAVA COMO ADD-ON: no total de add-ons do
-- caixa, do relatório, do DRE, do histórico do jogador e na fidelidade.
--
-- Taxa é uma 4ª categoria, com fichas e rake configuráveis como as outras:
--   * a venda continua com transactions.type = 'addon' (todo o caminho do
--     dinheiro — caixa do operador, caixa da etapa, pool, sangria, estorno —
--     segue igual) e ganha a marca congelada `is_fee`;
--   * os contadores do jogador vão para fee_count / total_fee_amount, não
--     para addon_count / total_addon_amount;
--   * não gera pontos de fidelidade nem parte KO.
--
-- COMPATÍVEL com o código atual: colunas novas com padrão, funções com o
-- mesmo resultado enquanto nenhuma venda for taxa. A reclassificação dos
-- Bonos existentes é feita À PARTE, depois do deploy (o backend antigo não
-- conhece a categoria 'fee').
--
-- Sem FK nova (ver a queda de 13/10: FK ambígua derruba o PostgREST).
-- ============================================================================

-- 1. Categoria nova -----------------------------------------------------------
ALTER TABLE public.buy_types DROP CONSTRAINT IF EXISTS buy_types_category_check;
ALTER TABLE public.buy_types
  ADD CONSTRAINT buy_types_category_check
  CHECK (category IN ('buy_in', 'rebuy', 'addon', 'fee'));

-- 2. Marca congelada na venda -------------------------------------------------
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS is_fee boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.transactions.is_fee IS
  'Venda de um meio da categoria TAXA (type continua addon). Não conta como add-on, não gera fidelidade nem parte KO.';

-- 3. Contadores do jogador ----------------------------------------------------
ALTER TABLE public.tournament_players
  ADD COLUMN IF NOT EXISTS fee_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_fee_amount numeric NOT NULL DEFAULT 0;

-- 4. Total gasto inclui as taxas ----------------------------------------------
CREATE OR REPLACE FUNCTION public.calculate_total_spent()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    NEW.total_spent = COALESCE(NEW.total_buy_in_amount, 0)
                    + COALESCE(NEW.total_rebuy_amount, 0)
                    + COALESCE(NEW.total_addon_amount, 0)
                    + COALESCE(NEW.total_fee_amount, 0);
    RETURN NEW;
END;
$function$;

-- 5. Estorno: a taxa devolve os contadores de taxa ----------------------------
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
       SET rebuy_count        = GREATEST(COALESCE(rebuy_count, 0) - 1, 0),
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
    -- Taxa: as fichas são as da própria venda (o dia não tem "fichas de taxa").
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

-- 6. Totais da tela de Relatórios: taxa não é add-on --------------------------
-- Mesmo retorno de antes (CREATE OR REPLACE basta): a receita continua com as
-- taxas; só a CONTAGEM de add-ons deixa de incluí-las.
CREATE OR REPLACE FUNCTION public.get_reports_totals(p_start timestamp with time zone DEFAULT NULL::timestamp with time zone, p_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(total_revenue numeric, total_buy_ins integer, total_rebuys integer, total_addons integer, avg_buy_in numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  SELECT
    COALESCE(sum(amount) FILTER (WHERE type IN ('buy_in','rebuy','addon')),0)::numeric,
    count(*) FILTER (WHERE type='buy_in')::int,
    count(*) FILTER (WHERE type='rebuy')::int,
    count(*) FILTER (WHERE type='addon' AND NOT COALESCE(is_fee, false))::int,
    COALESCE(avg(amount) FILTER (WHERE type='buy_in'),0)::numeric
  FROM transactions
  WHERE (p_start IS NULL OR created_at >= p_start)
    AND (p_end IS NULL OR created_at <= p_end)
    AND COALESCE(status,'active') = 'active';
$function$;

-- 7. Fidelidade: taxa não gera pontos nem cashback ----------------------------
CREATE OR REPLACE FUNCTION public.loyalty_earn_on_transaction()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_settings public.loyalty_settings%rowtype;
  v_mult numeric := 1;
  v_points numeric;
  v_balance numeric;
  v_lifetime numeric;
  v_tier uuid;
  v_cb_pct numeric;
  v_cb numeric;
BEGIN
  IF NEW.player_id IS NULL THEN RETURN NEW; END IF;
  -- Taxa é cobrança da casa, não consumo do jogador.
  IF COALESCE(NEW.is_fee, false) THEN RETURN NEW; END IF;
  IF NOT public.org_has_loyalty(NEW.organization_id) THEN RETURN NEW; END IF;

  SELECT * INTO v_settings FROM public.loyalty_settings WHERE organization_id = NEW.organization_id;
  IF NOT FOUND OR NOT v_settings.enabled THEN RETURN NEW; END IF;
  IF NEW.type IS NULL OR NOT (NEW.type = ANY(v_settings.earn_on)) THEN RETURN NEW; END IF;

  INSERT INTO public.loyalty_accounts (player_id, organization_id)
  VALUES (NEW.player_id, NEW.organization_id)
  ON CONFLICT (player_id) DO NOTHING;

  SELECT COALESCE(t.points_multiplier, 1) INTO v_mult
  FROM public.loyalty_accounts a
  LEFT JOIN public.loyalty_tiers t ON t.id = a.tier_id
  WHERE a.player_id = NEW.player_id;
  v_mult := COALESCE(v_mult, 1);

  v_points := floor(COALESCE(NEW.amount, 0) * v_settings.points_per_currency * v_mult);
  IF v_points > 0 THEN
    UPDATE public.loyalty_accounts
       SET points_balance = points_balance + v_points,
           lifetime_points = lifetime_points + v_points,
           updated_at = now()
     WHERE player_id = NEW.player_id
     RETURNING points_balance, lifetime_points INTO v_balance, v_lifetime;

    v_tier := public.loyalty_tier_for(NEW.organization_id, v_lifetime);
    UPDATE public.loyalty_accounts SET tier_id = v_tier WHERE player_id = NEW.player_id;
  ELSE
    v_points := 0;
    SELECT points_balance INTO v_balance FROM public.loyalty_accounts WHERE player_id = NEW.player_id;
  END IF;

  -- Cashback (dinheiro): % do gasto → saldo de cashback. Perk do tier vence o default.
  SELECT COALESCE(t.cashback_percent, v_settings.cashback_percent) INTO v_cb_pct
  FROM public.loyalty_accounts a
  LEFT JOIN public.loyalty_tiers t ON t.id = a.tier_id
  WHERE a.player_id = NEW.player_id;
  v_cb := round(COALESCE(NEW.amount, 0) * COALESCE(v_cb_pct, 0) / 100.0, 2);
  IF v_cb > 0 THEN
    UPDATE public.loyalty_accounts SET cashback_balance = cashback_balance + v_cb, updated_at = now()
     WHERE player_id = NEW.player_id;
  ELSE
    v_cb := 0;
  END IF;

  -- RECIBO: uma linha por venda, com os pontos E o cashback que ela gerou. É
  -- daqui que o cancelamento tira quanto devolver — sem isto ele precisa
  -- adivinhar pelo nível ATUAL do jogador, que pode ter mudado desde a compra.
  IF v_points > 0 OR v_cb > 0 THEN
    INSERT INTO public.loyalty_ledger
      (organization_id, player_id, delta, balance_after, reason, transaction_id, cashback_delta)
    VALUES
      (NEW.organization_id, NEW.player_id, v_points, COALESCE(v_balance, 0), 'earn_' || NEW.type, NEW.id, v_cb);
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;  -- best-effort: nunca bloqueia a venda
END $function$;
