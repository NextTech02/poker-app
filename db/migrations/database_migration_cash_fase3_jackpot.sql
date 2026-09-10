-- ============================================================================
-- CASH GAME — Fase 3: jackpot e o DRE do clube só-cash
-- ----------------------------------------------------------------------------
-- ORDEM: aplicar DEPOIS de database_migration_cash_fase2_waitlist.sql.
--
-- O JACKPOT NÃO É RECEITA. É dinheiro dos JOGADORES, retido para pagamento
-- futuro — um passivo. Somá-lo ao faturamento faria o clube contabilizar como
-- lucro algo que vai devolver, e a conta só apareceria no dia em que alguém
-- levasse o prêmio.
--
-- Por isso o fundo é uma tabela própria, com saldo próprio, fora de qualquer
-- soma de receita.
-- ============================================================================

DO $$ BEGIN
  IF to_regclass('public.cash_waitlist') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_cash_fase2_waitlist.sql';
  END IF;
END $$;


-- ── 1) O fundo ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cash_jackpot_fund (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID NOT NULL DEFAULT public.current_org_id()
                     REFERENCES public.organizations(id) ON DELETE CASCADE,
    current_balance  DECIMAL(12,2) NOT NULL DEFAULT 0,
    total_collected  DECIMAL(12,2) NOT NULL DEFAULT 0,
    total_paid       DECIMAL(12,2) NOT NULL DEFAULT 0,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Um fundo por clube. O jackpot atravessa dias e mesas: é o acumulado que
    -- os jogadores veem no telão, não algo que reinicia toda noite.
    UNIQUE (organization_id)
);

COMMENT ON TABLE public.cash_jackpot_fund IS
  'PASSIVO: dinheiro dos jogadores retido para pagamento futuro. Nunca entra em nenhuma soma de receita do clube.';


-- ── 2) Os pagamentos ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cash_jackpot_payouts (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id     UUID NOT NULL DEFAULT public.current_org_id()
                        REFERENCES public.organizations(id) ON DELETE RESTRICT,
    cash_day_id         UUID REFERENCES public.cash_days(id) ON DELETE SET NULL,
    table_id            UUID REFERENCES public.cash_tables(id) ON DELETE SET NULL,
    player_id           UUID REFERENCES public.players(id) ON DELETE RESTRICT,
    kind                VARCHAR(20) NOT NULL DEFAULT 'bad_beat'
                        CHECK (kind IN ('bad_beat','high_hand','promo','other')),
    amount              DECIMAL(12,2) NOT NULL CHECK (amount > 0),
    description         TEXT,
    -- O pagamento SAI da gaveta: é uma `cash_transaction` do tipo
    -- jackpot_payout, que o espelho já leva para o caixa do operador.
    cash_transaction_id UUID REFERENCES public.cash_transactions(id) ON DELETE SET NULL,
    paid_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    paid_by             UUID REFERENCES auth.users(id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cash_jackpot_payouts_org
    ON public.cash_jackpot_payouts(organization_id, paid_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_jackpot_payouts_day
    ON public.cash_jackpot_payouts(cash_day_id);


-- ── 3) O fundo acompanha a apuração ─────────────────────────────────────────
-- Cada contagem da caixa da mesa separa rake (receita) de jackpot (passivo). O
-- jackpot contado entra no fundo aqui, e é a única porta de entrada dele.
CREATE OR REPLACE FUNCTION public.cash_jackpot_accumulate()
RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
BEGIN
    IF COALESCE(NEW.jackpot_amount, 0) <= 0 THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.cash_jackpot_fund
        (organization_id, current_balance, total_collected)
    VALUES (NEW.organization_id, NEW.jackpot_amount, NEW.jackpot_amount)
    ON CONFLICT (organization_id) DO UPDATE SET
        current_balance = public.cash_jackpot_fund.current_balance + EXCLUDED.current_balance,
        total_collected = public.cash_jackpot_fund.total_collected + EXCLUDED.total_collected,
        updated_at = now();

    RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_cash_jackpot_accumulate ON public.cash_rake_entries;
CREATE TRIGGER trg_cash_jackpot_accumulate
    AFTER INSERT ON public.cash_rake_entries
    FOR EACH ROW EXECUTE FUNCTION public.cash_jackpot_accumulate();


CREATE OR REPLACE FUNCTION public.cash_jackpot_pay()
RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
BEGIN
    UPDATE public.cash_jackpot_fund
       SET current_balance = current_balance - NEW.amount,
           total_paid = total_paid + NEW.amount,
           updated_at = now()
     WHERE organization_id = NEW.organization_id;
    RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_cash_jackpot_pay ON public.cash_jackpot_payouts;
CREATE TRIGGER trg_cash_jackpot_pay
    AFTER INSERT ON public.cash_jackpot_payouts
    FOR EACH ROW EXECUTE FUNCTION public.cash_jackpot_pay();


-- ── 4) Despesas e receitas do clube SÓ-CASH ─────────────────────────────────
-- `expenses.stage_id` e `other_revenues.stage_id` eram NOT NULL: um clube que
-- só faz cash game não conseguia lançar UMA despesa. Sem despesa não há
-- resultado — só faturamento —, e o DRE dele mostraria lucro onde há aluguel,
-- equipe e bar a pagar.
--
-- A âncora vira polimórfica, como já foi feito em `cashboxes`: etapa (torneio)
-- OU dia (cash). Ao menos uma — um lançamento sem âncora nenhuma não entra em
-- nenhum DRE e vira dinheiro invisível.
ALTER TABLE public.expenses ALTER COLUMN stage_id DROP NOT NULL;
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS cash_day_id UUID
      REFERENCES public.cash_days(id) ON DELETE SET NULL;
ALTER TABLE public.expenses DROP CONSTRAINT IF EXISTS expenses_ancora;
ALTER TABLE public.expenses ADD CONSTRAINT expenses_ancora
  CHECK (num_nonnulls(stage_id, cash_day_id) >= 1);
CREATE INDEX IF NOT EXISTS idx_expenses_cash_day
  ON public.expenses(cash_day_id, status);

ALTER TABLE public.other_revenues ALTER COLUMN stage_id DROP NOT NULL;
ALTER TABLE public.other_revenues
  ADD COLUMN IF NOT EXISTS cash_day_id UUID
      REFERENCES public.cash_days(id) ON DELETE SET NULL;
ALTER TABLE public.other_revenues DROP CONSTRAINT IF EXISTS other_revenues_ancora;
ALTER TABLE public.other_revenues ADD CONSTRAINT other_revenues_ancora
  CHECK (num_nonnulls(stage_id, cash_day_id) >= 1);
CREATE INDEX IF NOT EXISTS idx_other_revenues_cash_day
  ON public.other_revenues(cash_day_id, status);

COMMENT ON CONSTRAINT expenses_ancora ON public.expenses IS
  'A despesa pertence a uma etapa (torneio) e/ou a um dia (cash game). Sem âncora ela não entraria em DRE nenhum.';


-- ── 5) RLS das tabelas novas ────────────────────────────────────────────────
DO $$
DECLARE t text;
  tabelas text[] := ARRAY['cash_jackpot_fund', 'cash_jackpot_payouts'];
BEGIN
  FOREACH t IN ARRAY tabelas LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_org_isolation', t);
    EXECUTE format($f$
      CREATE POLICY %I ON public.%I FOR ALL TO authenticated
      USING (organization_id = (SELECT public.current_org_id())
             OR (SELECT public.is_platform_admin()))
      WITH CHECK (organization_id = (SELECT public.current_org_id())
             OR (SELECT public.is_platform_admin()))
    $f$, t || '_org_isolation', t);
  END LOOP;
END $$;


-- ── 6) Agregado do faturamento por dia ──────────────────────────────────────
-- SECURITY INVOKER: o RLS precisa continuar valendo. Uma função DEFINER aqui
-- devolveria o faturamento de OUTRO clube — foi exatamente o que
-- database_migration_saas_phase5_fix_definer_leak.sql teve de corrigir.
CREATE OR REPLACE FUNCTION public.cash_daily_revenue(p_from date, p_to date)
RETURNS TABLE(
    cash_day_id uuid,
    business_date date,
    status text,
    rake numeric,
    jackpot numeric,
    buy_ins numeric,
    cash_outs numeric,
    tables_count int,
    players_count int
)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $fn$
  SELECT
    d.id,
    d.business_date,
    d.status::text,
    COALESCE(r.rake, 0)::numeric,
    COALESCE(r.jackpot, 0)::numeric,
    COALESCE(t.entradas, 0)::numeric,
    COALESCE(t.saidas, 0)::numeric,
    COALESCE(m.qtd, 0)::int,
    COALESCE(p.qtd, 0)::int
  FROM public.cash_days d
  LEFT JOIN LATERAL (
      SELECT SUM(rake_amount) AS rake, SUM(jackpot_amount) AS jackpot
        FROM public.cash_rake_entries WHERE cash_day_id = d.id
  ) r ON true
  LEFT JOIN LATERAL (
      -- Canceladas de fora: o dinheiro voltou para a mão do jogador.
      SELECT
        SUM(CASE WHEN type IN ('buy_in','rebuy') THEN amount ELSE 0 END) AS entradas,
        SUM(CASE WHEN type IN ('cash_out','jackpot_payout') THEN amount ELSE 0 END) AS saidas
        FROM public.cash_transactions
       WHERE cash_day_id = d.id AND COALESCE(status,'active') = 'active'
  ) t ON true
  LEFT JOIN LATERAL (
      SELECT count(*) AS qtd FROM public.cash_tables WHERE cash_day_id = d.id
  ) m ON true
  LEFT JOIN LATERAL (
      SELECT count(DISTINCT player_id) AS qtd
        FROM public.cash_player_sessions WHERE cash_day_id = d.id
  ) p ON true
  WHERE (p_from IS NULL OR d.business_date >= p_from)
    AND (p_to IS NULL OR d.business_date <= p_to)
  ORDER BY d.business_date DESC;
$fn$;

COMMENT ON FUNCTION public.cash_daily_revenue(date, date) IS
  'Faturamento por DIA. `rake` é a receita da casa; `buy_ins` é giro (troca de dinheiro por ficha) e NÃO é receita; `jackpot` é passivo.';


-- ── 7) Conferência ──────────────────────────────────────────────────────────
-- Nenhuma tabela de cash sem RLS. Deve retornar 0 linhas:
--   SELECT tablename FROM pg_tables
--    WHERE schemaname='public' AND tablename LIKE 'cash%' AND NOT rowsecurity;
--
-- Todo lançamento financeiro tem âncora. Deve retornar 0:
--   SELECT count(*) FROM public.expenses WHERE stage_id IS NULL AND cash_day_id IS NULL;
