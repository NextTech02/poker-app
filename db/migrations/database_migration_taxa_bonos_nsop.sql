-- ============================================================================
-- NSOP: os Bonos (Bono Dealer, Bono Simple, Bono Doble, Bonus Dealer…) passam
-- de add-on para TAXA — pedido do clube em 2026-10-14.
-- ============================================================================
-- RODAR SÓ DEPOIS de:
--   1. database_migration_categoria_taxa.sql aplicada;
--   2. deploy do backend e do frontend (o backend antigo não conhece a
--      categoria 'fee' e recusaria listar os meios do torneio).
-- e SEM JOGO ROLANDO (mexe nos contadores dos jogadores).
--
-- Critério: meios do NSOP, categoria add-on, nome começando por "bon" (Bono /
-- Bonus). Os "Addon"/"Add-on" de verdade não entram.
--
-- O que muda, por venda ATIVA de bono:
--   transactions.is_fee = true                      (o type continua 'addon')
--   tournament_players: addon_count/total_addon_amount  →  fee_count/total_fee_amount
-- O dinheiro não muda (valor, rake, pool, caixa, total gasto e fichas iguais).
-- Vendas canceladas também recebem a marca (os contadores delas já voltaram).
-- ============================================================================
DO $$
DECLARE
  v_org constant uuid := '3f54ef14-2da1-47b0-b58c-3e1e0c757604';
BEGIN
  CREATE TEMP TABLE _bonos ON COMMIT DROP AS
    SELECT id FROM public.buy_types
     WHERE organization_id = v_org AND category = 'addon' AND name ILIKE 'bon%';

  -- Contadores: só o que as vendas ATIVAS somaram como add-on.
  WITH por_jogador AS (
    SELECT x.tournament_player_id AS tp_id, count(*) AS n, sum(x.amount) AS total
      FROM public.transactions x
     WHERE x.buy_type_id IN (SELECT id FROM _bonos)
       AND x.type = 'addon'
       AND COALESCE(x.status, 'active') = 'active'
       AND NOT COALESCE(x.is_fee, false)
       AND x.tournament_player_id IS NOT NULL
     GROUP BY x.tournament_player_id
  )
  UPDATE public.tournament_players tp
     SET addon_count        = GREATEST(COALESCE(tp.addon_count, 0) - p.n, 0),
         total_addon_amount = GREATEST(COALESCE(tp.total_addon_amount, 0) - p.total, 0),
         fee_count          = COALESCE(tp.fee_count, 0) + p.n,
         total_fee_amount   = COALESCE(tp.total_fee_amount, 0) + p.total
    FROM por_jogador p
   WHERE tp.id = p.tp_id;

  UPDATE public.transactions
     SET is_fee = true
   WHERE buy_type_id IN (SELECT id FROM _bonos)
     AND type = 'addon'
     AND NOT COALESCE(is_fee, false);

  UPDATE public.buy_types SET category = 'fee' WHERE id IN (SELECT id FROM _bonos);
END $$;
