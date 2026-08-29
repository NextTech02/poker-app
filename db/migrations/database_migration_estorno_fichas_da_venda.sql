-- ============================================================================
-- O estorno devolve as fichas DAQUELA venda
-- ============================================================================
-- Já APLICADA em produção (Supabase) em 29/08/2026.
--
-- ORDEM DE APLICAÇÃO: esta é a versão VIGENTE de `undo_entry_counters_once`.
-- Ela substitui a de database_migration_recompra_desfaz_eliminacao.sql — ao
-- reconstruir o banco do zero, aplique aquele arquivo antes deste, e este
-- depois de database_migration_meios_de_entrada_por_dia.sql (que cria a coluna
-- `transactions.chips` de que ela depende).
--
-- POR QUÊ: até agora o estorno lia `tournament_days.rebuy_chips` /
-- `addon_chips`, o que valia enquanto todo rebuy entregava a mesma coisa. Com
-- meios de entrada por dia, um "rebuy duplo" entrega fichas próprias — e
-- cancelá-lo devolveria as fichas de um rebuy simples, deixando o jogador com
-- fichas que ninguém pagou.
--
-- A fonte passa a ser `transactions.chips`, congelada no momento da venda. Ler
-- do TIPO na hora de cancelar seria errado por outro motivo: o tipo pode ter
-- sido editado depois (10.000 -> 15.000 fichas), e o estorno devolveria mais do
-- que a venda entregou.
--
-- O COALESCE com o campo do dia atende as vendas ANTERIORES a esta mudança, que
-- não têm `chips` gravado: para elas o comportamento antigo continua certo.
--
-- CONFERIDO em produção, numa transação revertida: venda com chips = 25.000
-- devolve 25.000; venda antiga sem chips devolve os 10.000 do dia.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.undo_entry_counters_once(p_transaction_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tx        public.transactions%rowtype;
  v_dia_id    uuid;
  v_fichas    integer;
  v_inseridos int;
  v_restantes int;
BEGIN
  SELECT * INTO v_tx FROM public.transactions WHERE id = p_transaction_id;
  IF NOT FOUND OR v_tx.tournament_player_id IS NULL THEN
    RETURN false;
  END IF;
  -- COALESCE porque `NULL NOT IN (...)` é NULL, e não TRUE: sem ele uma linha
  -- de tipo nulo escaparia da guarda e cairia no ramo do buy-in.
  IF COALESCE(v_tx.type, '') NOT IN ('buy_in', 'rebuy', 'addon') THEN
    RETURN false;
  END IF;

  INSERT INTO public.transaction_counter_refunds
    (transaction_id, tournament_player_id, organization_id)
  VALUES (p_transaction_id, v_tx.tournament_player_id, v_tx.organization_id)
  ON CONFLICT (transaction_id) DO NOTHING;
  GET DIAGNOSTICS v_inseridos = ROW_COUNT;
  IF v_inseridos = 0 THEN
    RETURN false;   -- já acertada: as fichas (e o inscrito) já saíram uma vez
  END IF;

  SELECT tournament_day_id INTO v_dia_id
    FROM public.tournament_players WHERE id = v_tx.tournament_player_id;

  IF v_tx.type = 'rebuy' THEN
    -- Fichas da VENDA; o campo do dia só para as vendas antigas, sem o retrato.
    SELECT COALESCE(v_tx.chips, rebuy_chips, 0) INTO v_fichas
      FROM public.tournament_days WHERE id = v_dia_id;
    v_fichas := COALESCE(v_fichas, COALESCE(v_tx.chips, 0));
    UPDATE public.tournament_players
       SET rebuy_count        = GREATEST(COALESCE(rebuy_count, 0) - 1, 0),
           total_rebuy_amount = GREATEST(COALESCE(total_rebuy_amount, 0) - COALESCE(v_tx.amount, 0), 0),
           total_chips        = GREATEST(COALESCE(total_chips, 0) - COALESCE(v_fichas, 0), 0)
     WHERE id = v_tx.tournament_player_id
    RETURNING rebuy_count INTO v_restantes;

    -- Só quando não sobra nenhuma recompra o jogador volta a estar fora da mesa
    -- (a venda desconta UMA eliminação por venda, mesmo sendo várias recompras;
    -- devolver uma por transação faria sair 1 e voltarem 5). Teto no total de
    -- buy-ins do dia: não há mais eliminados do que gente que entrou.
    IF v_dia_id IS NOT NULL AND COALESCE(v_restantes, 0) = 0 THEN
      UPDATE public.tournament_days d
         SET eliminations_count = LEAST(
               COALESCE(d.eliminations_count, 0) + 1,
               (SELECT COALESCE(SUM(COALESCE(tp.buy_in_count, 0)), 0)
                  FROM public.tournament_players tp
                 WHERE tp.tournament_day_id = d.id)
             )
       WHERE d.id = v_dia_id;
    END IF;
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
    -- Buy-in: a inscrição inteira é desfeita. `buy_in_count` zera junto com o
    -- valor porque é ELE que todo agregado de ENTRADAS conta — sem isso o dia
    -- mostra 78 entradas com receita de 77.
    UPDATE public.tournament_players
       SET status               = 'cancelled',
           total_buy_in_amount  = 0,
           buy_in_count         = 0,
           total_chips          = 0
     WHERE id = v_tx.tournament_player_id;

    -- O trigger update_tournament_player_count só mexe no inscrito em
    -- INSERT/DELETE da linha; cancelar é UPDATE, então o dia é acertado aqui —
    -- MENOS UM, nunca uma recontagem.
    IF v_dia_id IS NOT NULL THEN
      UPDATE public.tournament_days
         SET registered_players = GREATEST(COALESCE(registered_players, 0) - 1, 0)
       WHERE id = v_dia_id;

      -- Uma entrada a menos pode deixar o contador de eliminações acima do novo
      -- total. Sem este aparo, "entradas - eliminações" viraria negativo.
      UPDATE public.tournament_days d
         SET eliminations_count = LEAST(
               COALESCE(d.eliminations_count, 0),
               (SELECT COALESCE(SUM(COALESCE(tp.buy_in_count, 0)), 0)
                  FROM public.tournament_players tp
                 WHERE tp.tournament_day_id = d.id)
             )
       WHERE d.id = v_dia_id;
    END IF;
  END IF;

  -- `total_spent` costuma ser recalculado por trigger BEFORE UPDATE; regravado
  -- aqui para o número fechar mesmo onde o trigger não existe.
  UPDATE public.tournament_players
     SET total_spent = COALESCE(total_buy_in_amount, 0)
                     + COALESCE(total_rebuy_amount, 0)
                     + COALESCE(total_addon_amount, 0)
   WHERE id = v_tx.tournament_player_id;

  RETURN true;
END $function$;
