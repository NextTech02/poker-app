-- ============================================================================
-- Cancelamento de venda (ESTORNO LÓGICO) + troca de forma de pagamento
-- ----------------------------------------------------------------------------
-- Princípio inegociável: a venda NUNCA é apagada. Três motivos verificados no
-- próprio banco:
--   1. `trigger_update_stage_cash_on_transaction` é AFTER INSERT apenas
--      (database_migration_cash_management.sql) — um DELETE deixaria
--      stage_cash_register.current_balance inflado PARA SEMPRE.
--   2. `trigger_mirror_transaction_to_cashbox` também é INSERT-only e
--      cashbox_transactions.transaction_id é ON DELETE SET NULL — a linha do
--      ledger sobreviveria órfã e o saldo do caixa do operador nunca voltaria.
--   3. transactions.tournament_player_id é ON DELETE CASCADE — apagar a
--      inscrição levaria junto o histórico financeiro do jogador.
-- Estorno lógico preserva a auditoria (quem cancelou, quando, por quê) e é a
-- única forma de a sangria e o fechamento de caixa da noite fecharem.
--
-- O ESTORNO em si (desfazer caixa da etapa, caixa do operador, contadores do
-- jogador e a fidelidade — pontos, NÍVEL e CASHBACK) é feito no service em Python
-- (backend/app/services/transaction_service.py) e NÃO por uma função
-- SECURITY DEFINER: o backend executa as queries COM O JWT DO USUÁRIO
-- (supabase_client._SupabaseProxy), então o RLS por organização é aplicado a
-- cada passo do estorno. Uma função DEFINER passaria por cima disso — foi
-- exatamente esse atalho que causou o vazamento entre clubes corrigido em
-- database_migration_saas_phase5_fix_definer_leak.sql.
--
-- ADITIVA e IDEMPOTENTE. O código tolera o schema antigo: sem a coluna
-- `status`, as somas continuam contando tudo (comportamento de hoje) e o
-- cancelamento responde com uma mensagem clara em vez de 500.
--
-- CONTINUA em database_migration_cancel_sale_idempotencia.sql: `cancel_steps`
-- sozinho não torna o estorno repetível (ele é gravado DEPOIS do passo, numa
-- segunda chamada que pode falhar). Lá ficam os RECIBOS que fazem cada passo
-- decidir por conta própria se já rodou — `stage_cash_refunds` para o caixa da
-- etapa e `loyalty_ledger.cashback_delta` para o cashback.
-- ============================================================================

-- ============================================================
-- 1) transactions: estado de cancelamento + auditoria
-- ============================================================
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS status        VARCHAR(12) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS cancelled_at  TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancelled_by  UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS cancel_reason TEXT,
  -- Passos do estorno já concluídos (contadores, caixa_etapa, caixa_operador,
  -- fidelidade). O estorno mexe em quatro lugares diferentes e NÃO é uma
  -- transação de banco: se um passo estoura (timeout, RLS, rede), é esta lista
  -- que permite à retentativa retomar SÓ o que faltou. Sem ela, o estorno pela
  -- metade virava permanente — a segunda tentativa via "já cancelada" e
  -- respondia sucesso com o caixa da etapa inflado.
  ADD COLUMN IF NOT EXISTS cancel_steps  TEXT[] NOT NULL DEFAULT '{}';

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_status_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_status_check
  CHECK (status IN ('active', 'cancelling', 'cancelled'));

-- Índice parcial: toda soma de dinheiro passa a contar SÓ as ativas, e as
-- canceladas são a minoria — indexar só elas basta para o planner.
CREATE INDEX IF NOT EXISTS idx_transactions_cancelled
  ON transactions(id) WHERE status <> 'active';

COMMENT ON COLUMN transactions.status IS
  'active | cancelling | cancelled. Venda cancelada continua na base (auditoria) mas sai de TODAS as somas de dinheiro. '
  '''cancelling'' = estorno em andamento: já saiu das somas, mas ainda faltam passos (ver cancel_steps).';
COMMENT ON COLUMN transactions.cancel_steps IS
  'Passos do estorno já concluídos. Existe para a retentativa retomar um cancelamento interrompido sem repetir o que já saiu do caixa.';
COMMENT ON COLUMN transactions.cancel_reason IS
  'Motivo obrigatório informado pelo admin no cancelamento — é o que explica a diferença no fechamento do caixa.';

-- ============================================================
-- 2) tournament_players aceita 'cancelled'
--    (buy-in estornado: a inscrição deixa de valer, mas a linha fica)
-- ============================================================
ALTER TABLE tournament_players DROP CONSTRAINT IF EXISTS tournament_players_status_check;
ALTER TABLE tournament_players ADD CONSTRAINT tournament_players_status_check
  CHECK (status IN ('registered', 'active', 'eliminated', 'winner', 'cancelled'));

-- ============================================================
-- 3) prize_pool passa a ignorar canceladas
--    Mantém integralmente o COALESCE(NEW, OLD) de
--    database_migration_fix_prizepool_delete.sql (correção do DELETE).
--    O trigger on_transaction_prize_pool_update já cobre UPDATE, então marcar
--    a venda como cancelada recalcula o prize pool sozinho.
-- ============================================================
CREATE OR REPLACE FUNCTION update_tournament_prize_pool()
RETURNS TRIGGER AS $$
DECLARE
    total_entries DECIMAL(10, 2);
    rake_pct DECIMAL(5, 2);
    prize_amount DECIMAL(10, 2);
    day_id UUID;
BEGIN
    IF TG_TABLE_NAME = 'tournament_players' THEN
        day_id := COALESCE(NEW.tournament_day_id, OLD.tournament_day_id);
    ELSIF TG_TABLE_NAME = 'transactions' THEN
        SELECT tp.tournament_day_id INTO day_id
        FROM tournament_players tp
        WHERE tp.id = COALESCE(NEW.tournament_player_id, OLD.tournament_player_id);
    END IF;

    IF day_id IS NOT NULL THEN
        SELECT COALESCE(rake_percentage, 0) INTO rake_pct
        FROM tournament_days
        WHERE id = day_id;

        SELECT COALESCE(SUM(t.amount), 0) INTO total_entries
        FROM transactions t
        JOIN tournament_players tp ON t.tournament_player_id = tp.id
        WHERE tp.tournament_day_id = day_id
          AND t.type IN ('buy_in', 'rebuy', 'addon')
          AND COALESCE(t.status, 'active') = 'active';   -- <<< novo

        prize_amount := total_entries * (1 - (rake_pct / 100));

        UPDATE tournament_days
        SET prize_pool = prize_amount
        WHERE id = day_id;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ============================================================
-- 4) Agregados do banco contam SÓ as vendas ativas
--    Esquecer um destes significa relatório, dashboard ou SANGRIA contando
--    dinheiro que foi devolvido ao jogador.
--    O teste é `= 'active'` (e não `<> 'cancelled'`) de propósito: a venda em
--    'cancelling' já teve o dinheiro devolvido ao jogador e precisa sair das
--    somas no MESMO instante — se continuasse contando durante o estorno, uma
--    sangria feita nesse meio-tempo extrairia rake de dinheiro que já voltou.
--    Todas SECURITY INVOKER: só agregam tabelas que o usuário já lê, então o
--    RLS filtra por organização sozinho (ver saas_phase5_fix_definer_leak).
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_dashboard_stats(p_stage_id uuid DEFAULT NULL)
RETURNS TABLE(active_tournaments int, total_players int, total_revenue numeric, today_revenue numeric)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
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
       WHERE COALESCE(tx.status,'active') = 'active'
         AND (p_stage_id IS NULL OR tx.tournament_id IN (SELECT id FROM tours))), 0)::numeric,
    COALESCE((SELECT sum(amount) FROM transactions tx
       WHERE tx.created_at >= current_date
         AND COALESCE(tx.status,'active') = 'active'
         AND (p_stage_id IS NULL OR tx.tournament_id IN (SELECT id FROM tours))), 0)::numeric;
$$;

CREATE OR REPLACE FUNCTION public.get_tournament_entry_totals(p_tournament_id uuid)
RETURNS TABLE(total numeric, total_rake numeric)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT COALESCE(sum(amount),0)::numeric, COALESCE(sum(rake_amount),0)::numeric
  FROM transactions
  WHERE tournament_id = p_tournament_id
    AND type IN ('buy_in','rebuy','addon')
    AND COALESCE(status,'active') = 'active';
$$;

-- Base da SANGRIA: rake de venda cancelada não pode ser extraído do caixa —
-- seria tirar rake de dinheiro que voltou para o jogador.
CREATE OR REPLACE FUNCTION public.get_stage_pending_rake(p_stage_id uuid)
RETURNS numeric
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT GREATEST(0,
    COALESCE((SELECT sum(rake_amount) FROM transactions
       WHERE type IN ('buy_in','rebuy','addon')
         AND COALESCE(status,'active') = 'active'
         AND tournament_id IN (SELECT id FROM tournaments WHERE stage_id = p_stage_id)), 0)
    -
    COALESCE((SELECT sum(rake_amount) FROM sangria_transactions WHERE stage_id = p_stage_id), 0)
  )::numeric;
$$;

CREATE OR REPLACE FUNCTION public.get_reports_totals(p_start timestamptz DEFAULT NULL, p_end timestamptz DEFAULT NULL)
RETURNS TABLE(total_revenue numeric, total_buy_ins int, total_rebuys int, total_addons int, avg_buy_in numeric)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT
    COALESCE(sum(amount) FILTER (WHERE type IN ('buy_in','rebuy','addon')),0)::numeric,
    count(*) FILTER (WHERE type='buy_in')::int,
    count(*) FILTER (WHERE type='rebuy')::int,
    count(*) FILTER (WHERE type='addon')::int,
    COALESCE(avg(amount) FILTER (WHERE type='buy_in'),0)::numeric
  FROM transactions
  WHERE (p_start IS NULL OR created_at >= p_start)
    AND (p_end IS NULL OR created_at <= p_end)
    AND COALESCE(status,'active') = 'active';
$$;

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
    COALESCE((SELECT sum(rake_amount) FROM transactions
       WHERE type IN ('buy_in','rebuy','addon')
         AND COALESCE(status,'active') = 'active'
         AND tournament_id IN (SELECT id FROM tournaments WHERE stage_id = p_stage_id)), 0)::numeric;
$$;

-- Conferência da gaveta por forma de pagamento: a venda cancelada saiu da
-- gaveta junto com o dinheiro devolvido.
CREATE OR REPLACE FUNCTION public.get_stage_totals_by_payment_method(p_stage_id uuid)
RETURNS TABLE(payment_method text, total numeric, entries int)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT tx.payment_method::text, sum(tx.amount)::numeric, count(*)::int
  FROM transactions tx
  WHERE tx.type IN ('buy_in','rebuy','addon')
    AND COALESCE(tx.status,'active') = 'active'
    AND tx.tournament_id IN (SELECT id FROM tournaments WHERE stage_id = p_stage_id)
  GROUP BY tx.payment_method
  ORDER BY sum(tx.amount) DESC;
$$;

-- ============================================================
-- 5) Caixa do operador: tipo PRÓPRIO para o estorno
--    'adjustment' já tem dono: é a diferença de contagem do fechamento, e por
--    isso o relatório de sessão a EXCLUI do saldo esperado
--    (cashbox_service._compute_session_report: expected = signed - adjustments).
--    Lançar o estorno como ajuste fazia a venda continuar somando no esperado
--    enquanto a devolução era descartada da conta: o relatório acusava o
--    operador de faltar R$ 100 que o ADMIN devolveu ao jogador.
--    O trigger de saldo (update_cashbox_balance_on_transaction) soma
--    signed_amount qualquer que seja o tipo, então nada mais muda.
-- ============================================================
ALTER TABLE cashbox_transactions DROP CONSTRAINT IF EXISTS cashbox_transactions_type_check;
ALTER TABLE cashbox_transactions ADD CONSTRAINT cashbox_transactions_type_check
  CHECK (type IN ('buy_in', 'rebuy', 'addon', 'prize', 'supply', 'sangria', 'refund', 'adjustment'));

COMMENT ON COLUMN cashbox_transactions.type IS
  'buy_in/rebuy/addon/supply = entrada; prize/sangria/refund = saída; adjustment = diferença de contagem do fechamento. '
  'refund = devolução de venda cancelada (saída REAL de dinheiro, entra no saldo esperado da sessão).';

-- Estornos gravados como 'adjustment' pelo backend anterior a este tipo: eles
-- SEMPRE têm transaction_id (o ajuste de fechamento nunca tem), então dá para
-- reclassificá-los com segurança e limpar o relatório retroativamente.
UPDATE cashbox_transactions
   SET type = 'refund'
 WHERE type = 'adjustment'
   AND transaction_id IS NOT NULL;

-- ============================================================
-- 6) Débito RELATIVO no caixa da etapa (usado pelo estorno)
--    O cancelamento não pode ler o saldo no Python e gravar o total calculado:
--    dois cancelamentos simultâneos — ou um cancelamento junto com a venda
--    seguinte, que o trigger soma — perderiam um dos débitos, e o caixa
--    fecharia com sobra sem ninguém conseguir rastrear qual estorno sumiu.
--    SECURITY INVOKER: roda com o JWT do usuário, então o RLS por organização
--    continua valendo (ver saas_phase5_fix_definer_leak).
-- ============================================================
CREATE OR REPLACE FUNCTION public.debit_stage_cash_register(p_stage_id uuid, p_amount numeric)
RETURNS numeric
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = public AS $$
  UPDATE stage_cash_register
     SET current_balance = current_balance - p_amount,
         total_received  = total_received  - p_amount,
         updated_at      = now()
   WHERE stage_id = p_stage_id
  RETURNING current_balance;
$$;

COMMENT ON FUNCTION public.debit_stage_cash_register(uuid, numeric) IS
  'Devolve ao jogador o dinheiro de uma venda cancelada. Pode deixar o saldo NEGATIVO de propósito: '
  'se a venda já foi sangrada, o dinheiro realmente falta na gaveta e mascarar isso esconderia a diferença do fechamento.';

-- ============================================================
-- 7) Recalcula o prize_pool de todos os dias com a regra nova
--    (idempotente: é o mesmo número que o trigger derivaria)
-- ============================================================
UPDATE tournament_days td
SET prize_pool = (
    SELECT COALESCE(SUM(t.amount), 0)
    FROM transactions t
    JOIN tournament_players tp ON t.tournament_player_id = tp.id
    WHERE tp.tournament_day_id = td.id
      AND t.type IN ('buy_in', 'rebuy', 'addon')
      AND COALESCE(t.status, 'active') = 'active'
) * (1 - (COALESCE(td.rake_percentage, 0) / 100));
