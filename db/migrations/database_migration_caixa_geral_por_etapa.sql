-- Migration: Caixa Geral por etapa + composição das entradas por método de pagamento
-- Description: duas RPCs de agregação usadas por CashRegisterService
--   .get_stage_cash_summary e .get_stage_totals_by_payment_method.
--   Nenhuma tabela ou coluna nova: tudo sai do que já existe
--   (sangria_transactions.stage_id e transactions via tournaments.stage_id).
--   Os serviços chamam a RPC dentro de try/except e caem no fetch+soma em
--   Python se ela não existir, então o deploy do código NÃO depende desta
--   migração ter rodado — ela só troca N linhas trafegadas por 1.
--
-- Por que não existe "saldo do caixa geral por etapa": general_cash_register é
-- um saldo único da organização, movimentado também por despesas pagas, outras
-- receitas e pagamentos de funcionários — nenhum deles guarda stage_id. O que
-- dá para provar por etapa é o quanto ela MANDOU para o caixa geral (soma dos
-- net_amount das sangrias dela).

-- SECURITY INVOKER (nao DEFINER) de proposito. Estas funcoes so AGREGAM tabelas
-- que o usuario ja pode ler, entao o RLS faz o filtro por organizacao sozinho.
-- Com DEFINER elas rodariam com o privilegio do dono e IGNORARIAM o RLS: foi
-- exatamente isso que causou o vazamento entre clubes corrigido em
-- database_migration_saas_phase5_fix_definer_leak.sql (o dashboard de um cliente
-- recem-criado mostrava o faturamento de OUTRO).
CREATE OR REPLACE FUNCTION public.get_stage_cash_summary(p_stage_id uuid)
RETURNS TABLE(
  total_sangrias numeric,
  sangria_count int,
  rake_extracted numeric,
  net_to_general numeric,
  rake_generated numeric
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT
    COALESCE((SELECT sum(amount) FROM sangria_transactions WHERE stage_id = p_stage_id), 0)::numeric,
    COALESCE((SELECT count(*) FROM sangria_transactions WHERE stage_id = p_stage_id), 0)::int,
    COALESCE((SELECT sum(rake_amount) FROM sangria_transactions WHERE stage_id = p_stage_id), 0)::numeric,
    COALESCE((SELECT sum(net_amount) FROM sangria_transactions WHERE stage_id = p_stage_id), 0)::numeric,
    -- Rake GERADO pelas entradas da etapa. Prêmio pago não entra: sai do caixa.
    COALESCE((SELECT sum(rake_amount) FROM transactions
       WHERE type IN ('buy_in','rebuy','addon')
         AND tournament_id IN (SELECT id FROM tournaments WHERE stage_id = p_stage_id)), 0)::numeric;
$$;

-- Composição das ENTRADAS da etapa por forma de pagamento. É o número que diz
-- quanto do caixa deve estar em espécie na gaveta: o trigger do caixa da etapa
-- soma buy-in/rebuy/addon independente do método, misturando PIX e cartão com
-- dinheiro. payment_method nulo vira uma linha própria (entradas antigas,
-- gravadas antes do cadastro de métodos) — somá-las em 'cash' inflaria a
-- conferência do caixa físico.
CREATE OR REPLACE FUNCTION public.get_stage_totals_by_payment_method(p_stage_id uuid)
RETURNS TABLE(payment_method text, total numeric, entries int)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT tx.payment_method::text, sum(tx.amount)::numeric, count(*)::int
  FROM transactions tx
  WHERE tx.type IN ('buy_in','rebuy','addon')
    AND tx.tournament_id IN (SELECT id FROM tournaments WHERE stage_id = p_stage_id)
  GROUP BY tx.payment_method
  ORDER BY sum(tx.amount) DESC;
$$;
