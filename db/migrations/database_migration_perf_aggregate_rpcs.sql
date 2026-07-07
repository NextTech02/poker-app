-- Migration: aggregate RPCs (perf)
-- Description: evitam o padrão "buscar N linhas -> somar em Python" (transferir
--   milhares de linhas a cada chamada). Cada função resolve a agregação no banco
--   e devolve 1 linha. Os serviços chamam a RPC e caem no fetch+soma se ela
--   não existir (fallback). Usadas por: DashboardService.get_stats,
--   PrizeAllocationService.calculate_total_entries, CashRegisterService
--   .get_stage_pending_rake, ReportService.get_reports.

CREATE OR REPLACE FUNCTION public.get_dashboard_stats(p_stage_id uuid DEFAULT NULL)
RETURNS TABLE(active_tournaments int, total_players int, total_revenue numeric, today_revenue numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH tours AS (
    SELECT id FROM tournaments WHERE p_stage_id IS NULL OR stage_id = p_stage_id
  ), days AS (
    SELECT id FROM tournament_days WHERE p_stage_id IS NULL OR tournament_id IN (SELECT id FROM tours)
  )
  SELECT
    (SELECT count(*)::int FROM tournament_days td
       WHERE td.status = 'active' AND (p_stage_id IS NULL OR td.id IN (SELECT id FROM days))),
    (SELECT count(*)::int FROM tournament_players tp
       WHERE tp.status = 'active' AND (p_stage_id IS NULL OR tp.tournament_day_id IN (SELECT id FROM days))),
    COALESCE((SELECT sum(amount) FROM transactions tx
       WHERE p_stage_id IS NULL OR tx.tournament_id IN (SELECT id FROM tours)), 0)::numeric,
    COALESCE((SELECT sum(amount) FROM transactions tx
       WHERE tx.created_at >= current_date
         AND (p_stage_id IS NULL OR tx.tournament_id IN (SELECT id FROM tours))), 0)::numeric;
$$;

CREATE OR REPLACE FUNCTION public.get_tournament_entry_totals(p_tournament_id uuid)
RETURNS TABLE(total numeric, total_rake numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(sum(amount),0)::numeric, COALESCE(sum(rake_amount),0)::numeric
  FROM transactions
  WHERE tournament_id = p_tournament_id AND type IN ('buy_in','rebuy','addon');
$$;

CREATE OR REPLACE FUNCTION public.get_stage_pending_rake(p_stage_id uuid)
RETURNS numeric
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT GREATEST(0,
    COALESCE((SELECT sum(rake_amount) FROM transactions
       WHERE type IN ('buy_in','rebuy','addon')
         AND tournament_id IN (SELECT id FROM tournaments WHERE stage_id = p_stage_id)), 0)
    -
    COALESCE((SELECT sum(rake_amount) FROM sangria_transactions WHERE stage_id = p_stage_id), 0)
  )::numeric;
$$;

CREATE OR REPLACE FUNCTION public.get_reports_totals(p_start timestamptz DEFAULT NULL, p_end timestamptz DEFAULT NULL)
RETURNS TABLE(total_revenue numeric, total_buy_ins int, total_rebuys int, total_addons int, avg_buy_in numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT
    COALESCE(sum(amount) FILTER (WHERE type IN ('buy_in','rebuy','addon')),0)::numeric,
    count(*) FILTER (WHERE type='buy_in')::int,
    count(*) FILTER (WHERE type='rebuy')::int,
    count(*) FILTER (WHERE type='addon')::int,
    COALESCE(avg(amount) FILTER (WHERE type='buy_in'),0)::numeric
  FROM transactions
  WHERE (p_start IS NULL OR created_at >= p_start)
    AND (p_end IS NULL OR created_at <= p_end);
$$;
