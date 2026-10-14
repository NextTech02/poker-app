-- ============================================================================
-- Premiação por eliminação: KO fixo, PKO e Mystery Bounty
-- Date: 2026-10-13
-- ----------------------------------------------------------------------------
-- Parte do pozo acumulado vira prêmio por ELIMINAÇÃO, separado das posições
-- (ex.: pozo 10.000, KO 40% → 4.000 em KOs e 6.000 nas posições).
--
--   KO fixo  quem elimina leva o bounty inteiro da vítima.
--   PKO      quem elimina leva uma parte em dinheiro (padrão 50%) e o resto
--            soma no próprio bounty; o campeão leva o próprio bounty no fim.
--   Mystery  ao iniciar a fase, o pozo KO congela em envelopes (um por jogador
--            vivo); cada eliminação na fase sorteia um.
--
-- Desenho:
--   * Cada venda CONGELA `transactions.bounty_amount` (como já faz com o
--     rake): mudar o % depois não reescreve o passado, e estornar a venda tira
--     a parte KO junto. Pozo KO = Σ bounty_amount das vendas ativas.
--   * O bounty atual de um jogador é DERIVADO do livro abaixo (nunca um
--     contador): vendas + o que ele ganhou somando − o que perdeu caindo.
--   * `tournament_knockouts` é o livro das eliminações (sobrevive à reentrada,
--     que reaproveita a linha de tournament_players e apaga eliminated_at);
--     `tournament_knockout_payouts` é o que cada eliminador recebe.
--   * O pagamento reaproveita transactions.type = 'prize' (caixa, DRE e extrato
--     já tratam como saída). `prize_kind` separa posição de KO nos relatórios.
--   * `tournament_days.prize_pool` NÃO muda: continua sendo o pozo acumulado.
--
-- Compatível com o backend anterior: só colunas novas com padrão, tabelas
-- novas e uma RPC que ganha uma coluna a mais (lida por nome).
--
-- organization_id: as tabelas novas têm default current_org_id(), mas o
-- backend grava o valor EXPLICITAMENTE (copiado do torneio) — o replay do
-- modo offline (/sync) roda com a service_role, onde current_org_id() é nulo.
--
-- Pré-requisitos: saas_phase3a_rls_helpers (current_org_id/is_platform_admin)
-- e mfa_2fa (mfa_satisfeito). Bloco `_exige_mfa` próprio: o loop da migração de
-- 2FA não é retroativo.
-- ============================================================================

DO $$
BEGIN
  IF to_regproc('public.current_org_id') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_saas_phase3a_rls_helpers.sql (current_org_id)';
  END IF;
  IF to_regproc('public.mfa_satisfeito') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_mfa_2fa.sql (mfa_satisfeito)';
  END IF;
END $$;

-- 1) Configuração no torneio ------------------------------------------------
ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS ko_format varchar(10) NOT NULL DEFAULT 'none',
  ADD COLUMN IF NOT EXISTS ko_percentage numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ko_cash_share numeric(5,2) NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS ko_closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS mystery_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS mystery_day_id uuid REFERENCES public.tournament_days(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS mystery_pool numeric(12,2),
  ADD COLUMN IF NOT EXISTS mystery_players_at_start integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_tournaments_ko_format') THEN
    ALTER TABLE public.tournaments
      ADD CONSTRAINT chk_tournaments_ko_format CHECK (ko_format IN ('none','ko','pko','mystery'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_tournaments_ko_percentage') THEN
    ALTER TABLE public.tournaments
      ADD CONSTRAINT chk_tournaments_ko_percentage CHECK (ko_percentage BETWEEN 0 AND 100);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_tournaments_ko_cash_share') THEN
    ALTER TABLE public.tournaments
      ADD CONSTRAINT chk_tournaments_ko_cash_share CHECK (ko_cash_share BETWEEN 0 AND 100);
  END IF;
END $$;

COMMENT ON COLUMN public.tournaments.ko_format IS
  'Premiação por eliminação: none | ko (fixo) | pko (progressivo) | mystery';
COMMENT ON COLUMN public.tournaments.ko_percentage IS
  '% do pozo líquido (valor − rake) de cada venda que vai para o pozo KO';
COMMENT ON COLUMN public.tournaments.ko_cash_share IS
  'PKO: % do bounty da vítima pago em dinheiro a quem elimina (o resto soma no bounty dele). KO fixo = 100';

-- 2) Venda: parte KO congelada; prêmio: tipo ---------------------------------
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS bounty_amount numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS prize_kind varchar(10);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_transactions_prize_kind') THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT chk_transactions_prize_kind CHECK (prize_kind IS NULL OR prize_kind IN ('position','knockout'));
  END IF;
END $$;

COMMENT ON COLUMN public.transactions.bounty_amount IS
  'Parte KO desta venda, congelada na hora (como rake_amount). Σ das vendas ativas = pozo KO';
COMMENT ON COLUMN public.transactions.prize_kind IS
  'Em type = prize: position (faixa de premiação) ou knockout (prêmio por eliminação)';

-- 3) Idempotência do replay offline da eliminação ---------------------------
ALTER TABLE public.tournament_players
  ADD COLUMN IF NOT EXISTS eliminated_cmid text;

-- 4) Livro das eliminações ---------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tournament_knockouts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL DEFAULT current_org_id() REFERENCES public.organizations(id) ON DELETE CASCADE,
  tournament_id         uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  tournament_day_id     uuid REFERENCES public.tournament_days(id) ON DELETE CASCADE,
  -- Vítima. Nulo só no kind 'unclaimed' (bounties sem autor entregues ao campeão).
  eliminated_tp_id      uuid REFERENCES public.tournament_players(id) ON DELETE CASCADE,
  eliminated_player_id  uuid REFERENCES public.players(id) ON DELETE SET NULL,
  -- elimination: alguém caiu | closing: encerramento paga ao vivo o próprio
  -- bounty | unclaimed: sobras sem autor vão ao campeão
  kind                  varchar(12) NOT NULL DEFAULT 'elimination'
                          CHECK (kind IN ('elimination','closing','unclaimed')),
  format                varchar(10) NOT NULL CHECK (format IN ('ko','pko','mystery')),
  -- Bounty da vítima NAQUELE momento (ou valor do envelope sorteado). Congelado.
  bounty_value          numeric(12,2) NOT NULL DEFAULT 0 CHECK (bounty_value >= 0),
  cash_share            numeric(5,2) NOT NULL DEFAULT 100,
  status                varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active','undone')),
  client_mutation_id    text UNIQUE,
  created_by            uuid DEFAULT auth.uid(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  undone_by             uuid,
  undone_at             timestamptz
);
CREATE INDEX IF NOT EXISTS idx_knockouts_tournament ON public.tournament_knockouts(tournament_id, status);
CREATE INDEX IF NOT EXISTS idx_knockouts_victim ON public.tournament_knockouts(eliminated_tp_id);
CREATE INDEX IF NOT EXISTS idx_knockouts_org ON public.tournament_knockouts(organization_id);

-- 5) O que cada eliminador recebe -------------------------------------------
CREATE TABLE IF NOT EXISTS public.tournament_knockout_payouts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL DEFAULT current_org_id() REFERENCES public.organizations(id) ON DELETE CASCADE,
  tournament_id         uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  knockout_id           uuid NOT NULL REFERENCES public.tournament_knockouts(id) ON DELETE CASCADE,
  eliminator_tp_id      uuid REFERENCES public.tournament_players(id) ON DELETE CASCADE,
  eliminator_player_id  uuid REFERENCES public.players(id) ON DELETE SET NULL,
  cash_amount           numeric(12,2) NOT NULL DEFAULT 0 CHECK (cash_amount >= 0),
  added_to_bounty       numeric(12,2) NOT NULL DEFAULT 0 CHECK (added_to_bounty >= 0),
  paid                  boolean NOT NULL DEFAULT false,
  paid_at               timestamptz,
  paid_by               text,
  paid_by_user          uuid,
  transaction_id        uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ko_payouts_knockout ON public.tournament_knockout_payouts(knockout_id);
CREATE INDEX IF NOT EXISTS idx_ko_payouts_tournament ON public.tournament_knockout_payouts(tournament_id, paid);
CREATE INDEX IF NOT EXISTS idx_ko_payouts_eliminator ON public.tournament_knockout_payouts(eliminator_tp_id);
CREATE INDEX IF NOT EXISTS idx_ko_payouts_org ON public.tournament_knockout_payouts(organization_id);

-- 6) Envelopes do Mystery ----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tournament_mystery_envelopes (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL DEFAULT current_org_id() REFERENCES public.organizations(id) ON DELETE CASCADE,
  tournament_id         uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  value                 numeric(12,2) NOT NULL CHECK (value > 0),
  drawn_knockout_id     uuid REFERENCES public.tournament_knockouts(id) ON DELETE SET NULL,
  drawn_at              timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mystery_envelopes_tournament
  ON public.tournament_mystery_envelopes(tournament_id, drawn_knockout_id);
CREATE INDEX IF NOT EXISTS idx_mystery_envelopes_org ON public.tournament_mystery_envelopes(organization_id);

-- 7) RLS por organização + 2FA ----------------------------------------------
DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tournament_knockouts','tournament_knockout_payouts','tournament_mystery_envelopes'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_org_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated '
      'USING ((organization_id = (select public.current_org_id())) or (select public.is_platform_admin())) '
      'WITH CHECK ((organization_id = (select public.current_org_id())) or (select public.is_platform_admin()))',
      t || '_org_isolation', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_exige_mfa', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
      'USING ((select public.mfa_satisfeito()))',
      t || '_exige_mfa', t);
  END LOOP;
END $rls$;

-- 8) Realtime: a Gestão de Mesas e a Premiação se atualizam sozinhas ---------
DO $publica$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tournament_knockouts','tournament_knockout_payouts'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $publica$;

-- 9) Totais de entradas do torneio com a parte KO ---------------------------
-- RETURNS TABLE muda de forma: precisa DROP + CREATE. O backend lê as colunas
-- por NOME, então funciona antes e depois desta troca.
DROP FUNCTION IF EXISTS public.get_tournament_entry_totals(uuid);
CREATE FUNCTION public.get_tournament_entry_totals(p_tournament_id uuid)
RETURNS TABLE(total numeric, total_rake numeric, total_bounty numeric)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT COALESCE(sum(amount),0)::numeric,
         COALESCE(sum(rake_amount),0)::numeric,
         COALESCE(sum(bounty_amount),0)::numeric
  FROM transactions
  WHERE tournament_id = p_tournament_id
    AND type IN ('buy_in','rebuy','addon')
    AND COALESCE(status,'active') = 'active';
$$;

-- 10) Débito/crédito ATÔMICO do caixa geral ---------------------------------
-- O pagamento de prêmio lia o saldo no Python e gravava o total calculado:
-- dois caixas pagando KOs ao mesmo tempo perderiam um débito. Aqui o banco
-- desconta relativo e só se houver saldo (NULL = saldo insuficiente).
-- SECURITY INVOKER: roda com o JWT do usuário, o RLS por organização vale.
CREATE OR REPLACE FUNCTION public.debit_general_cash_register(p_register_id uuid, p_amount numeric)
RETURNS numeric
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = public AS $$
  UPDATE general_cash_register
     SET current_balance = current_balance - p_amount,
         updated_at      = now()
   WHERE id = p_register_id
     AND current_balance >= p_amount
  RETURNING current_balance;
$$;

CREATE OR REPLACE FUNCTION public.credit_general_cash_register(p_register_id uuid, p_amount numeric)
RETURNS numeric
LANGUAGE sql VOLATILE SECURITY INVOKER SET search_path = public AS $$
  UPDATE general_cash_register
     SET current_balance = current_balance + p_amount,
         updated_at      = now()
   WHERE id = p_register_id
  RETURNING current_balance;
$$;

COMMENT ON FUNCTION public.debit_general_cash_register(uuid, numeric) IS
  'Paga prêmio do caixa geral: desconta relativo e só com saldo suficiente; NULL = recusado';
COMMENT ON FUNCTION public.credit_general_cash_register(uuid, numeric) IS
  'Desfaz um débito do caixa geral quando o resto do pagamento falhou';

-- 11) Excluir organização leva as tabelas novas (antes de transactions) ------
-- ESTADO EM PRODUÇÃO (2026-10-14): as seções 1–10 estão aplicadas
-- (`knockouts_parte1_esquema`). Esta seção 11 NÃO foi aplicada: o conector do
-- Supabase recusou o payload ("Invalid or expired requestState") três vezes.
-- Não é indispensável: as FKs das tabelas novas são ON DELETE CASCADE para
-- organizations, tournaments e tournament_players, então delete_organization
-- já as apaga em cascata. Aplicar pelo SQL Editor quando for conveniente, só
-- para a contagem de linhas apagadas listar as tabelas do KO.
CREATE OR REPLACE FUNCTION public.delete_organization(p_org uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_status text;
    v_name   text;
    v_t      text;
    v_del    jsonb := '{}'::jsonb;
    v_n      bigint;
    v_users  uuid[];
    v_u      uuid;
    v_removed int := 0;
    v_order  text[] := ARRAY[
        'cashbox_transactions',
        'bar_tab_payments','bar_tab_items','bar_stock_movements','bar_tabs',
        'tournament_knockout_payouts','tournament_mystery_envelopes','tournament_knockouts',
        'prize_allocations','transactions','seat_allocations',
        'credit_transactions','chip_consignment_sales',
        'satellite_ticket_transfers','satellite_tickets',
        'tournament_players','blinds','tournament_tables','tournament_days',
        'expenses','expense_categories','other_revenues',
        'tournaments','player_credits','chip_consignments','staff_payments',
        'cashbox_sessions','cashboxes','stage_cash_register','sangria_transactions',
        'blind_templates','buy_types','stages',
        'cash_transactions','cash_rake_entries','cash_jackpot_payouts','cash_waitlist',
        'cash_player_sessions','cash_seats','cash_tables','cash_jackpot_fund',
        'cash_game_types','cash_days',
        'bar_shifts','bar_products','bar_product_categories',
        'loyalty_ledger','loyalty_redemptions','loyalty_coupon_redemptions',
        'loyalty_goal_claims','loyalty_birthday_grants','loyalty_accounts',
        'loyalty_rewards','loyalty_coupons','loyalty_goals','loyalty_tiers',
        'loyalty_settings',
        'players','sponsors','staff',
        'permission_groups','payment_methods','app_settings','general_cash_register',
        'rake_register','sync_mutations','org_modules'
    ];
BEGIN
    SELECT status, name INTO v_status, v_name FROM public.organizations WHERE id = p_org;
    IF v_status IS NULL THEN
        RAISE EXCEPTION 'Organizacao nao encontrada.';
    END IF;
    IF v_status = 'active' THEN
        RAISE EXCEPTION 'Suspenda a organizacao antes de exclui-la.';
    END IF;

    SELECT COALESCE(array_agg(DISTINCT auth_user_id), '{}'::uuid[])
      INTO v_users
      FROM public.staff
     WHERE organization_id = p_org AND auth_user_id IS NOT NULL;

    BEGIN
        EXECUTE 'UPDATE public.cashboxes SET current_session_id = NULL WHERE organization_id = $1' USING p_org;
    EXCEPTION WHEN undefined_column THEN NULL;
    END;

    BEGIN
        EXECUTE 'UPDATE public.tournament_days SET qualifies_to_day_id = NULL WHERE organization_id = $1' USING p_org;
    EXCEPTION WHEN undefined_column THEN NULL;
    END;

    FOREACH v_t IN ARRAY v_order LOOP
        BEGIN
            EXECUTE format('DELETE FROM public.%I WHERE organization_id = $1', v_t) USING p_org;
            GET DIAGNOSTICS v_n = ROW_COUNT;
            IF v_n > 0 THEN
                v_del := v_del || jsonb_build_object(v_t, v_n);
            END IF;
        EXCEPTION WHEN undefined_table THEN NULL;
        END;
    END LOOP;

    DELETE FROM public.organizations WHERE id = p_org;

    FOREACH v_u IN ARRAY v_users LOOP
        CONTINUE WHEN EXISTS (SELECT 1 FROM public.staff s WHERE s.auth_user_id = v_u);
        CONTINUE WHEN EXISTS (SELECT 1 FROM public.platform_admins pa WHERE pa.auth_user_id = v_u);
        BEGIN
            DELETE FROM auth.users WHERE id = v_u;
            v_removed := v_removed + 1;
        EXCEPTION WHEN others THEN
            NULL;
        END;
    END LOOP;

    RETURN jsonb_build_object(
        'organization', v_name,
        'deleted', v_del,
        'accounts_removed', v_removed
    );
END $function$;

-- Conferência ----------------------------------------------------------------
-- select policyname, permissive from pg_policies where tablename like 'tournament_k%' or tablename like 'tournament_mystery%';
--   -> *_org_isolation PERMISSIVE + *_exige_mfa RESTRICTIVE nas três tabelas
-- select * from get_tournament_entry_totals('<tournament uuid>');  -- 3 colunas
