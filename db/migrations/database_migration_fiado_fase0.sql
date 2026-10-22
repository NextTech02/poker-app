-- ============================================================================
-- FIADO DA CASA — Fase 0: conta-corrente do jogador, razão e ganchos do cash
-- ----------------------------------------------------------------------------
-- O DESENHO EM UMA FRASE: o gerente habilita o jogador com um limite; o caixa
-- do cash vende fichas "no fiado" (a venda NÃO entra na gaveta); no cash-out a
-- dívida é abatida primeiro e a gaveta paga só o líquido; o jogador quita o
-- resto em qualquer gaveta de cash ou de bar; o gerente pode dar baixa.
--
-- DECISÕES QUE ESTE ARQUIVO MATERIALIZA (não "simplificar" depois):
--   * NÃO É o crédito de patrocinador (`player_credits`, `payment_source =
--     'credit'`): lá o saldo é A FAVOR do jogador e quem deve é o patrocinador.
--     Aqui quem deve é o jogador, ao clube. Por isso os nomes são outros
--     (`house_credit*`, `payment_source = 'house_credit'`, tipo de gaveta
--     `debt_payment`) — misturar os dois faria um relatório somar dívida com
--     saldo.
--   * CADA OPERAÇÃO É UM STATEMENT. Limite, abatimento, estorno e espelho na
--     gaveta acontecem nos triggers do mesmo INSERT/UPDATE. O PostgREST faz de
--     cada requisição uma transação: se o limite estoura, a venda some junto;
--     não existe "vendeu e não lançou a dívida".
--   * O RAZÃO É SÓ-DE-INCLUSÃO DE VERDADE. Todas as políticas do projeto são
--     FOR ALL e o backend grava com o JWT do usuário — qualquer funcionário
--     consegue escrever direto pelo Supabase do navegador. Aqui o usuário tem
--     só SELECT nas contas/config e SELECT+INSERT no razão, e CADA TIPO de
--     lançamento tem uma única porta de entrada conferida pelo banco:
--       payment                      → inserção direta, numa gaveta ABERTA de
--                                      cash ou de bar
--       charge / charge_reversal /
--       cashout_offset               → só pelos triggers de cash_transactions,
--                                      e coerentes com a linha-mãe
--       write_off / payment_reversal → só service role (backend, depois de
--                                      conferir `fiado.manage`)
--       prize_offset                 → reservado para a Fase 3 (prêmio)
--   * O SALDO é aplicado por UMA função SECURITY DEFINER (o usuário não tem
--     UPDATE na conta). É a única exceção ao padrão INVOKER do projeto, e a
--     conta só aceita mudança de saldo vinda dela (flag de transação).
--   * Gaveta de ETAPA (torneio) não recebe fiado nesta fase: o
--     stage_cash_register só soma buy-in/rebuy/addon e o dinheiro não chegaria
--     ao caixa geral.
--   * cash_out guarda o valor das FICHAS em `amount` (a conta de fichas da
--     sessão e do dia não muda) e o abatido em `debt_settled_amount`; a gaveta
--     move só `amount − debt_settled_amount`.
--   * A RPC cash_daily_revenue NÃO muda de assinatura (exigiria DROP): os
--     totais de fiado saem do backend.
--
-- ORDEM: aplicar DEPOIS das migrações de cash (fase0..3, cash_cashout_saldo,
-- sangeur_para_cash), do bar (fase0..2), de mfa_2fa e de activity_logs.
-- Em seguida aplicar database_migration_fiado_fase0b_check.sql (o CHECK de
-- tipos da gaveta, separado porque exige DROP CONSTRAINT). Reaplicável.
-- ============================================================================

SET lock_timeout = '5s';

DO $guard$ BEGIN
  IF to_regclass('public.cash_transactions') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_cash_fase1_core.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'cash_transactions'
                    AND column_name = 'consignment_id') THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_sangeur_para_cash.sql';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'cashboxes'
                    AND column_name = 'bar_shift_id') THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_bar_fase1_core.sql';
  END IF;
  IF to_regproc('public.mfa_satisfeito') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_mfa_2fa.sql';
  END IF;
  IF to_regproc('public.log_activity') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_activity_logs.sql';
  END IF;
END $guard$;


-- ── 1) Configuração por organização ─────────────────────────────────────────
-- Fora de `app_settings` de propósito: aquela tabela é legível por anônimo e
-- gravável por qualquer funcionário. Sem linha = padrões (COALESCE no uso).
CREATE TABLE IF NOT EXISTS public.house_credit_settings (
  organization_id UUID PRIMARY KEY REFERENCES public.organizations(id) ON DELETE RESTRICT,
  due_days        INTEGER NOT NULL DEFAULT 30 CHECK (due_days BETWEEN 1 AND 3650),
  block_overdue   BOOLEAN NOT NULL DEFAULT true,
  default_limit   DECIMAL(12,2) NOT NULL DEFAULT 0 CHECK (default_limit >= 0),
  updated_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- ── 2) Conta do jogador (1 por org + jogador) ───────────────────────────────
-- Nada disto vai em `players`: GET /players e o PlayerSelect entregam a lista
-- inteira a qualquer funcionário logado.
CREATE TABLE IF NOT EXISTS public.house_credit_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL DEFAULT public.current_org_id()
                  REFERENCES public.organizations(id) ON DELETE RESTRICT,
  player_id       UUID NOT NULL REFERENCES public.players(id) ON DELETE RESTRICT,
  enabled         BOOLEAN NOT NULL DEFAULT false,
  credit_limit    DECIMAL(12,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  -- Quanto o jogador DEVE. Só a função de aplicação mexe (ver guarda).
  balance         DECIMAL(12,2) NOT NULL DEFAULT 0 CHECK (balance >= 0),
  open_since      TIMESTAMPTZ,
  enabled_at      TIMESTAMPTZ,
  notes           TEXT,
  updated_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT house_credit_accounts_org_player_key UNIQUE (organization_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_house_credit_accounts_devedores
  ON public.house_credit_accounts (organization_id) WHERE balance > 0;


-- ── 3) Razão (só-de-inclusão) ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.house_credit_entries (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id     UUID NOT NULL DEFAULT public.current_org_id()
                      REFERENCES public.organizations(id),
  -- Preenchidos pelo trigger de aplicação (NOT NULL é conferido depois dele).
  account_id          UUID NOT NULL REFERENCES public.house_credit_accounts(id),
  player_id           UUID NOT NULL REFERENCES public.players(id),
  type                VARCHAR(20) NOT NULL CHECK (type IN (
                        'charge','charge_reversal','cashout_offset',
                        'payment','payment_reversal','write_off','prize_offset')),
  amount              DECIMAL(12,2) NOT NULL CHECK (amount > 0),
  signed_amount       DECIMAL(12,2) NOT NULL,
  balance_after       DECIMAL(12,2) NOT NULL,
  module              VARCHAR(16) NOT NULL DEFAULT 'cash'
                      CHECK (module IN ('cash','bar','tournament','club')),
  cash_transaction_id UUID REFERENCES public.cash_transactions(id),
  reverses_entry_id   UUID REFERENCES public.house_credit_entries(id),
  cashbox_id          UUID REFERENCES public.cashboxes(id),
  cash_day_id         UUID REFERENCES public.cash_days(id),
  bar_shift_id        UUID REFERENCES public.bar_shifts(id),
  payment_method      VARCHAR(50),
  reason              TEXT,
  notes               TEXT,
  client_mutation_id  TEXT,
  created_by          UUID REFERENCES auth.users(id),
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT hce_baixa_com_motivo
    CHECK (type <> 'write_off' OR NULLIF(btrim(reason), '') IS NOT NULL),
  CONSTRAINT hce_recebimento_tem_gaveta
    CHECK (type NOT IN ('payment','payment_reversal') OR cashbox_id IS NOT NULL),
  CONSTRAINT hce_estorno_aponta_original
    CHECK (type <> 'payment_reversal' OR reverses_entry_id IS NOT NULL),
  CONSTRAINT hce_cash_aponta_venda
    CHECK (type NOT IN ('charge','charge_reversal','cashout_offset') OR cash_transaction_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_house_credit_entries_conta
  ON public.house_credit_entries (account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_house_credit_entries_org
  ON public.house_credit_entries (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_house_credit_entries_jogador
  ON public.house_credit_entries (player_id);
-- Duplo clique / retry do recebimento.
CREATE UNIQUE INDEX IF NOT EXISTS uq_house_credit_entries_cmid
  ON public.house_credit_entries (organization_id, client_mutation_id)
  WHERE client_mutation_id IS NOT NULL;
-- EFEITO ÚNICO: uma dívida, um estorno e um abatimento por venda do cash.
CREATE UNIQUE INDEX IF NOT EXISTS uq_house_credit_entries_por_venda
  ON public.house_credit_entries (cash_transaction_id, type)
  WHERE cash_transaction_id IS NOT NULL;
-- Um recebimento só se estorna uma vez.
CREATE UNIQUE INDEX IF NOT EXISTS uq_house_credit_entries_estorno
  ON public.house_credit_entries (reverses_entry_id)
  WHERE type = 'payment_reversal';


-- ── 4) Colunas novas nas tabelas existentes ─────────────────────────────────
ALTER TABLE public.cash_transactions
  ADD COLUMN IF NOT EXISTS debt_settled_amount  DECIMAL(12,2) NOT NULL DEFAULT 0,
  -- O que o sistema propôs abater (para o relatório de abatimento a menor).
  ADD COLUMN IF NOT EXISTS debt_offset_expected DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS debt_offset_reason   TEXT;

ALTER TABLE public.cash_days
  ADD COLUMN IF NOT EXISTS total_credit_issued DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_debt_offset   DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_debt_payments DECIMAL(12,2) NOT NULL DEFAULT 0;

ALTER TABLE public.cashbox_transactions
  ADD COLUMN IF NOT EXISTS house_credit_entry_id UUID
    REFERENCES public.house_credit_entries(id) ON DELETE SET NULL;

DO $checks$ BEGIN
  -- Fiado só compra fichas.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_tx_fiado_so_compra') THEN
    ALTER TABLE public.cash_transactions ADD CONSTRAINT cash_tx_fiado_so_compra
      CHECK (payment_source IS DISTINCT FROM 'house_credit' OR type IN ('buy_in','rebuy'));
  END IF;
  -- Venda no fiado não tem gaveta: não entrou dinheiro.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_tx_fiado_sem_gaveta') THEN
    ALTER TABLE public.cash_transactions ADD CONSTRAINT cash_tx_fiado_sem_gaveta
      CHECK (payment_source IS DISTINCT FROM 'house_credit' OR cashbox_id IS NULL);
  END IF;
  -- Abatimento só no cash-out, e nunca maior que as fichas.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'cash_tx_abatimento_valido') THEN
    ALTER TABLE public.cash_transactions ADD CONSTRAINT cash_tx_abatimento_valido
      CHECK (debt_settled_amount >= 0
             AND debt_settled_amount <= amount
             AND (debt_settled_amount = 0 OR type = 'cash_out'));
  END IF;
END $checks$;


-- ── 5) Dívida mais antiga em aberto (FIFO) ──────────────────────────────────
-- Os pagamentos quitam as dívidas mais antigas primeiro. A data devolvida é a
-- da primeira carga que o total de baixas ainda não cobriu.
CREATE OR REPLACE FUNCTION public.house_credit_oldest_open(p_account uuid)
RETURNS timestamptz
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $fn$
  WITH baixas AS (
    SELECT COALESCE(SUM(amount), 0) AS total
      FROM public.house_credit_entries
     WHERE account_id = p_account AND signed_amount < 0
  ), cargas AS (
    SELECT created_at, SUM(amount) OVER (ORDER BY created_at, id) AS acumulado
      FROM public.house_credit_entries
     WHERE account_id = p_account AND signed_amount > 0
  )
  SELECT min(c.created_at) FROM cargas c, baixas b WHERE c.acumulado > b.total;
$fn$;


-- ── 6) Porta de entrada do razão (BEFORE INSERT, INVOKER) ───────────────────
-- Nome com "a_" para rodar ANTES da aplicação do saldo (ordem alfabética).
CREATE OR REPLACE FUNCTION public.house_credit_entry_gate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_priv  boolean := current_user IN ('service_role', 'postgres', 'supabase_admin');
  v_cb    record;
  v_tx    record;
  v_orig  record;
  v_sess  uuid;
BEGIN
  -- Quem lança direto não escolhe em nome de quem.
  IF NOT v_priv AND pg_trigger_depth() < 2 THEN
    NEW.created_by := auth.uid();
  END IF;

  IF NEW.type = 'payment' THEN
    SELECT id, organization_id, status, stage_id, cash_day_id, bar_shift_id
      INTO v_cb FROM public.cashboxes WHERE id = NEW.cashbox_id;
    IF NOT FOUND OR v_cb.status IS DISTINCT FROM 'open' THEN
      -- Gaveta fechada: open_session sobrescreve o saldo e o recebimento sumiria.
      RAISE EXCEPTION 'REGRA_FIADO:caixa_fechado';
    END IF;
    IF v_cb.organization_id IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'REGRA_FIADO:caixa_de_outra_organizacao';
    END IF;
    IF v_cb.stage_id IS NOT NULL THEN
      RAISE EXCEPTION 'REGRA_FIADO:recebimento_so_no_cash_ou_bar';
    END IF;
    NEW.cash_day_id  := v_cb.cash_day_id;
    NEW.bar_shift_id := v_cb.bar_shift_id;
    NEW.module := CASE WHEN v_cb.bar_shift_id IS NOT NULL THEN 'bar' ELSE 'cash' END;

  ELSIF NEW.type = 'write_off' THEN
    IF NOT v_priv THEN
      RAISE EXCEPTION 'REGRA_FIADO:operacao_restrita_ao_gerente';
    END IF;
    NEW.module := 'club';
    NEW.cashbox_id := NULL;

  ELSIF NEW.type = 'payment_reversal' THEN
    IF NOT v_priv THEN
      RAISE EXCEPTION 'REGRA_FIADO:operacao_restrita_ao_gerente';
    END IF;
    SELECT * INTO v_orig FROM public.house_credit_entries
     WHERE id = NEW.reverses_entry_id AND type = 'payment';
    IF NOT FOUND
       OR v_orig.organization_id IS DISTINCT FROM NEW.organization_id
       OR v_orig.player_id IS DISTINCT FROM NEW.player_id THEN
      RAISE EXCEPTION 'REGRA_FIADO:recebimento_nao_encontrado';
    END IF;
    IF NEW.amount <> v_orig.amount THEN
      RAISE EXCEPTION 'REGRA_FIADO:estorno_deve_ser_do_valor_inteiro valor=%', v_orig.amount;
    END IF;
    -- O dinheiro volta da MESMA gaveta, e só enquanto a sessão que o recebeu
    -- estiver aberta: depois da conferência, o estorno mexeria num caixa já
    -- contado.
    SELECT c.status, c.current_session_id INTO v_cb
      FROM public.cashboxes c WHERE c.id = v_orig.cashbox_id;
    SELECT ct.session_id INTO v_sess
      FROM public.cashbox_transactions ct
     WHERE ct.house_credit_entry_id = v_orig.id AND ct.type = 'debt_payment'
     LIMIT 1;
    IF v_cb.status IS DISTINCT FROM 'open' OR v_sess IS DISTINCT FROM v_cb.current_session_id THEN
      RAISE EXCEPTION 'REGRA_FIADO:estorno_fora_da_sessao_do_caixa';
    END IF;
    NEW.cashbox_id   := v_orig.cashbox_id;
    NEW.cash_day_id  := v_orig.cash_day_id;
    NEW.bar_shift_id := v_orig.bar_shift_id;
    NEW.module       := v_orig.module;

  ELSIF NEW.type IN ('charge', 'charge_reversal', 'cashout_offset') THEN
    -- Só nasce do trigger de cash_transactions (profundidade >= 2). Inserido
    -- solto seria dívida perdoada (ou inventada) sem venda nenhuma.
    IF pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'REGRA_FIADO:lancamento_so_pelo_caixa';
    END IF;
    SELECT id, organization_id, player_id, type, amount, payment_source,
           debt_settled_amount, status, cash_day_id
      INTO v_tx FROM public.cash_transactions WHERE id = NEW.cash_transaction_id;
    IF NOT FOUND
       OR v_tx.organization_id IS DISTINCT FROM NEW.organization_id
       OR v_tx.player_id IS DISTINCT FROM NEW.player_id THEN
      RAISE EXCEPTION 'REGRA_FIADO:lancamento_incoerente';
    END IF;
    IF NEW.type = 'charge' AND NOT (
         v_tx.payment_source = 'house_credit' AND v_tx.type IN ('buy_in','rebuy')
         AND v_tx.amount = NEW.amount) THEN
      RAISE EXCEPTION 'REGRA_FIADO:lancamento_incoerente';
    END IF;
    IF NEW.type = 'charge_reversal' AND NOT (
         v_tx.payment_source = 'house_credit' AND v_tx.amount = NEW.amount
         AND v_tx.status IS DISTINCT FROM 'active') THEN
      RAISE EXCEPTION 'REGRA_FIADO:lancamento_incoerente';
    END IF;
    IF NEW.type = 'cashout_offset' AND NOT (
         v_tx.type = 'cash_out' AND v_tx.debt_settled_amount = NEW.amount) THEN
      RAISE EXCEPTION 'REGRA_FIADO:lancamento_incoerente';
    END IF;
    NEW.cash_day_id := v_tx.cash_day_id;
    NEW.module := 'cash';
    NEW.cashbox_id := NULL;

  ELSIF NEW.type = 'prize_offset' THEN
    -- Fase 3: só dentro da RPC de pagamento de prêmio.
    IF current_setting('fiado.premio', true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'REGRA_FIADO:lancamento_so_pelo_caixa';
    END IF;
    NEW.module := 'tournament';
  END IF;

  RETURN NEW;
END $fn$;


-- ── 7) Aplicação do saldo (BEFORE INSERT, SECURITY DEFINER) ─────────────────
-- A trava do limite é o FOR UPDATE na conta: duas vendas simultâneas para o
-- mesmo jogador entram em fila, e a segunda vê o saldo já somado.
CREATE OR REPLACE FUNCTION public.house_credit_entry_apply()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_acc    record;
  v_signed DECIMAL(12,2);
  v_novo   DECIMAL(12,2);
  v_due    integer;
  v_block  boolean;
  v_desde  timestamptz;
BEGIN
  SELECT * INTO v_acc FROM public.house_credit_accounts
   WHERE organization_id = NEW.organization_id AND player_id = NEW.player_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'REGRA_FIADO:fiado_nao_habilitado';
  END IF;
  NEW.account_id := v_acc.id;

  v_signed := CASE WHEN NEW.type IN ('charge','payment_reversal') THEN NEW.amount
                   ELSE -NEW.amount END;

  IF NEW.type = 'charge' THEN
    IF NOT v_acc.enabled THEN
      RAISE EXCEPTION 'REGRA_FIADO:fiado_nao_habilitado';
    END IF;
    IF v_acc.balance + NEW.amount > v_acc.credit_limit THEN
      RAISE EXCEPTION 'REGRA_FIADO:limite_de_fiado_excedido disponivel=% solicitado=%',
        GREATEST(v_acc.credit_limit - v_acc.balance, 0), NEW.amount;
    END IF;
    SELECT COALESCE(s.due_days, 30), COALESCE(s.block_overdue, true)
      INTO v_due, v_block
      FROM (SELECT 1) x
      LEFT JOIN public.house_credit_settings s ON s.organization_id = NEW.organization_id;
    IF v_block AND v_acc.balance > 0 THEN
      v_desde := public.house_credit_oldest_open(v_acc.id);
      IF v_desde IS NOT NULL AND v_desde < now() - make_interval(days => v_due) THEN
        RAISE EXCEPTION 'REGRA_FIADO:fiado_vencido desde=%', v_desde::date;
      END IF;
    END IF;
  ELSIF v_signed < 0 AND NEW.amount > v_acc.balance THEN
    IF NEW.type = 'charge_reversal' THEN
      RAISE EXCEPTION 'REGRA_FIADO:estorno_de_fiado_ja_quitado devido=% solicitado=%',
        v_acc.balance, NEW.amount;
    END IF;
    RAISE EXCEPTION 'REGRA_FIADO:valor_maior_que_a_divida devido=% solicitado=%',
      v_acc.balance, NEW.amount;
  END IF;

  v_novo := v_acc.balance + v_signed;

  PERFORM set_config('fiado.aplicando', '1', true);
  UPDATE public.house_credit_accounts
     SET balance    = v_novo,
         open_since = CASE WHEN v_novo <= 0 THEN NULL
                           WHEN v_acc.balance <= 0 THEN now()
                           ELSE open_since END,
         updated_at = now()
   WHERE id = v_acc.id;
  PERFORM set_config('fiado.aplicando', '', true);

  NEW.signed_amount := v_signed;
  NEW.balance_after := v_novo;
  RETURN NEW;
END $fn$;


-- ── 8) Espelho na gaveta (AFTER INSERT no razão, INVOKER) ───────────────────
CREATE OR REPLACE FUNCTION public.house_credit_entry_mirror()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_sess  uuid;
  v_saldo DECIMAL(12,2);
BEGIN
  IF NEW.type NOT IN ('payment', 'payment_reversal') THEN
    RETURN NEW;
  END IF;

  SELECT current_session_id, current_balance INTO v_sess, v_saldo
    FROM public.cashboxes WHERE id = NEW.cashbox_id FOR UPDATE;

  IF NEW.type = 'payment' THEN
    INSERT INTO public.cashbox_transactions
      (cashbox_id, session_id, type, amount, signed_amount,
       house_credit_entry_id, performed_by, notes, organization_id)
    VALUES
      (NEW.cashbox_id, v_sess, 'debt_payment', NEW.amount, NEW.amount,
       NEW.id, NEW.created_by, NEW.notes, NEW.organization_id);
  ELSE
    IF COALESCE(v_saldo, 0) < NEW.amount THEN
      RAISE EXCEPTION 'REGRA_CAIXA:saldo_insuficiente_no_caixa disponivel=% solicitado=%',
        COALESCE(v_saldo, 0), NEW.amount;
    END IF;
    INSERT INTO public.cashbox_transactions
      (cashbox_id, session_id, type, amount, signed_amount,
       house_credit_entry_id, performed_by, notes, organization_id)
    VALUES
      (NEW.cashbox_id, v_sess, 'refund', NEW.amount, -NEW.amount,
       NEW.id, NEW.created_by, COALESCE(NEW.reason, NEW.notes), NEW.organization_id);
  END IF;
  RETURN NEW;
END $fn$;


-- ── 9) Guardas: razão imutável, saldo só pela aplicação ─────────────────────
CREATE OR REPLACE FUNCTION public.house_credit_entries_imutavel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- Só o dono das funções (delete_organization roda como ele) apaga.
  IF current_user NOT IN ('postgres', 'supabase_admin') THEN
    RAISE EXCEPTION 'REGRA_FIADO:extrato_imutavel';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $fn$;

CREATE OR REPLACE FUNCTION public.house_credit_accounts_guarda()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.balance <> 0 OR NEW.open_since IS NOT NULL THEN
      RAISE EXCEPTION 'REGRA_FIADO:saldo_so_pelo_extrato';
    END IF;
  ELSE
    IF (NEW.balance IS DISTINCT FROM OLD.balance
        OR NEW.open_since IS DISTINCT FROM OLD.open_since)
       AND current_setting('fiado.aplicando', true) IS DISTINCT FROM '1' THEN
      RAISE EXCEPTION 'REGRA_FIADO:saldo_so_pelo_extrato';
    END IF;
    IF NEW.organization_id IS DISTINCT FROM OLD.organization_id
       OR NEW.player_id IS DISTINCT FROM OLD.player_id THEN
      RAISE EXCEPTION 'REGRA_FIADO:conta_imutavel';
    END IF;
    NEW.updated_at := now();
  END IF;
  RETURN NEW;
END $fn$;


-- ── 10) Ganchos em cash_transactions ────────────────────────────────────────
-- 10.1) Venda no fiado → dívida; cash-out com abatimento → baixa. Mesmo
--       statement do INSERT: se o limite recusa, a venda não existe.
CREATE OR REPLACE FUNCTION public.cash_tx_fiado_lancar()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NEW.payment_source = 'house_credit' AND NEW.type IN ('buy_in', 'rebuy') THEN
    INSERT INTO public.house_credit_entries
      (organization_id, player_id, type, amount, cash_transaction_id, created_by, notes)
    VALUES
      (NEW.organization_id, NEW.player_id, 'charge', NEW.amount, NEW.id, NEW.created_by, NEW.notes);
  END IF;
  IF COALESCE(NEW.debt_settled_amount, 0) > 0 THEN
    INSERT INTO public.house_credit_entries
      (organization_id, player_id, type, amount, cash_transaction_id, created_by, reason)
    VALUES
      (NEW.organization_id, NEW.player_id, 'cashout_offset', NEW.debt_settled_amount,
       NEW.id, NEW.created_by, NEW.debt_offset_reason);
  END IF;
  RETURN NEW;
END $fn$;

-- 10.2) Estorno de venda fiada → reverso da dívida, NO MESMO UPDATE do status.
--       Se a dívida já foi quitada e não cobre o estorno, a mudança de status é
--       recusada e a venda continua 'active' — senão ficaria presa em
--       'cancelling', fora da sessão e do dia, com a dívida de pé.
CREATE OR REPLACE FUNCTION public.cash_tx_fiado_estorno()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF COALESCE(OLD.status, 'active') = 'active' AND COALESCE(NEW.status, 'active') <> 'active' THEN
    IF NEW.payment_source = 'house_credit' THEN
      IF NOT EXISTS (SELECT 1 FROM public.house_credit_entries
                      WHERE cash_transaction_id = NEW.id AND type = 'charge_reversal') THEN
        INSERT INTO public.house_credit_entries
          (organization_id, player_id, type, amount, cash_transaction_id, created_by, reason)
        VALUES
          (NEW.organization_id, NEW.player_id, 'charge_reversal', NEW.amount, NEW.id,
           COALESCE(NEW.cancelled_by, auth.uid()), NEW.cancel_reason);
      END IF;
    ELSIF COALESCE(NEW.debt_settled_amount, 0) > 0 THEN
      RAISE EXCEPTION 'REGRA_FIADO:cash_out_com_abatimento_nao_cancelavel';
    END IF;
  ELSIF COALESCE(OLD.status, 'active') <> 'active' AND COALESCE(NEW.status, 'active') = 'active'
        AND (NEW.payment_source = 'house_credit' OR COALESCE(NEW.debt_settled_amount, 0) > 0) THEN
    RAISE EXCEPTION 'REGRA_FIADO:estorno_nao_se_desfaz';
  END IF;
  RETURN NEW;
END $fn$;

-- 10.3) O que gerou dívida/abatimento não muda depois: os efeitos foram
--       calculados no INSERT. Restrito às linhas de fiado para não mexer no
--       resto do cash.
CREATE OR REPLACE FUNCTION public.cash_tx_fiado_imutavel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF (OLD.payment_source = 'house_credit' OR NEW.payment_source = 'house_credit'
      OR COALESCE(OLD.debt_settled_amount, 0) > 0 OR COALESCE(NEW.debt_settled_amount, 0) > 0)
     AND (NEW.amount IS DISTINCT FROM OLD.amount
          OR NEW.type IS DISTINCT FROM OLD.type
          OR NEW.payment_source IS DISTINCT FROM OLD.payment_source
          OR NEW.debt_settled_amount IS DISTINCT FROM OLD.debt_settled_amount
          OR NEW.player_id IS DISTINCT FROM OLD.player_id
          OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
          OR NEW.cash_day_id IS DISTINCT FROM OLD.cash_day_id) THEN
    RAISE EXCEPTION 'REGRA_FIADO:lancamento_imutavel';
  END IF;
  RETURN NEW;
END $fn$;

-- 10.4) A gaveta do operador nunca é ligada a uma venda no fiado.
--       Corpo vigente em prod (sangeur_para_cash) + o desvio no topo.
CREATE OR REPLACE FUNCTION public.resolve_cash_transaction_cashbox()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_cashbox_id UUID;
BEGIN
    -- Fiado não é dinheiro na gaveta. `=` e não `<>`: as linhas antigas têm
    -- payment_source NULL e precisam seguir o caminho de sempre.
    IF NEW.payment_source = 'house_credit' THEN
        NEW.cashbox_id := NULL;
        RETURN NEW;
    END IF;

    IF NEW.consignment_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.cashbox_id IS NOT NULL OR NEW.created_by IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT c.id INTO v_cashbox_id
      FROM public.cashboxes c
      JOIN public.staff s ON s.id = c.staff_id
     WHERE s.auth_user_id = NEW.created_by
       AND c.cash_day_id = NEW.cash_day_id
       AND c.status = 'open';

    IF v_cashbox_id IS NOT NULL THEN
        NEW.cashbox_id := v_cashbox_id;
    END IF;
    RETURN NEW;
END $function$;

-- 10.5) Espelho na gaveta: pula o fiado e, no cash-out, move só o LÍQUIDO.
--       Corpo vigente em prod (cash_cashout_saldo) + as duas mudanças.
CREATE OR REPLACE FUNCTION public.mirror_cash_transaction_to_cashbox()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_session_id UUID;
    v_saldo  DECIMAL(12,2);
    v_type   TEXT;
    v_valor  DECIMAL(12,2);
    v_signed DECIMAL(12,2);
BEGIN
    IF NEW.cashbox_id IS NULL OR NEW.payment_source = 'house_credit' THEN
        RETURN NEW;
    END IF;

    IF NEW.type IN ('buy_in','rebuy') THEN
        v_type := 'cash_buy_in'; v_valor := NEW.amount; v_signed := v_valor;
    ELSIF NEW.type IN ('cash_out','jackpot_payout') THEN
        -- As fichas valem `amount`; o que foi abatido da dívida não sai da
        -- gaveta. Abatimento total = nada a pagar = nada a espelhar.
        v_valor := NEW.amount - COALESCE(NEW.debt_settled_amount, 0);
        IF v_valor <= 0 THEN
            RETURN NEW;
        END IF;
        v_type := 'cash_out'; v_signed := -v_valor;
    ELSE
        RETURN NEW;
    END IF;

    SELECT current_session_id, current_balance
      INTO v_session_id, v_saldo
      FROM public.cashboxes WHERE id = NEW.cashbox_id
       FOR UPDATE;

    IF NEW.type = 'cash_out' AND COALESCE(v_saldo, 0) < v_valor THEN
        RAISE EXCEPTION
          'REGRA_CAIXA:saldo_insuficiente_no_caixa disponivel=% solicitado=%',
          COALESCE(v_saldo, 0), v_valor;
    END IF;

    INSERT INTO public.cashbox_transactions
        (cashbox_id, session_id, type, amount, signed_amount,
         cash_transaction_id, performed_by, notes, organization_id)
    VALUES
        (NEW.cashbox_id, v_session_id, v_type, v_valor, v_signed,
         NEW.id, NEW.created_by, NEW.notes, NEW.organization_id);

    RETURN NEW;
END $function$;


-- ── 11) Triggers ────────────────────────────────────────────────────────────
-- CREATE OR REPLACE TRIGGER (PG14+): sem DROP, que o conector do MCP recusa.
CREATE OR REPLACE TRIGGER trg_house_credit_entries_a_gate
  BEFORE INSERT ON public.house_credit_entries
  FOR EACH ROW EXECUTE FUNCTION public.house_credit_entry_gate();
CREATE OR REPLACE TRIGGER trg_house_credit_entries_b_apply
  BEFORE INSERT ON public.house_credit_entries
  FOR EACH ROW EXECUTE FUNCTION public.house_credit_entry_apply();
CREATE OR REPLACE TRIGGER trg_house_credit_entries_mirror
  AFTER INSERT ON public.house_credit_entries
  FOR EACH ROW EXECUTE FUNCTION public.house_credit_entry_mirror();
CREATE OR REPLACE TRIGGER trg_house_credit_entries_imutavel
  BEFORE UPDATE OR DELETE ON public.house_credit_entries
  FOR EACH ROW EXECUTE FUNCTION public.house_credit_entries_imutavel();

CREATE OR REPLACE TRIGGER trg_house_credit_accounts_guarda
  BEFORE INSERT OR UPDATE ON public.house_credit_accounts
  FOR EACH ROW EXECUTE FUNCTION public.house_credit_accounts_guarda();
CREATE OR REPLACE TRIGGER trg_house_credit_settings_updated_at
  BEFORE UPDATE ON public.house_credit_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE TRIGGER trg_cash_tx_fiado_lancar
  AFTER INSERT ON public.cash_transactions
  FOR EACH ROW EXECUTE FUNCTION public.cash_tx_fiado_lancar();
CREATE OR REPLACE TRIGGER trg_cash_tx_fiado_estorno
  AFTER UPDATE OF status ON public.cash_transactions
  FOR EACH ROW EXECUTE FUNCTION public.cash_tx_fiado_estorno();
CREATE OR REPLACE TRIGGER trg_cash_tx_fiado_imutavel
  BEFORE UPDATE ON public.cash_transactions
  FOR EACH ROW EXECUTE FUNCTION public.cash_tx_fiado_imutavel();


-- ── 12) RLS: contas e config só leitura; razão leitura + inclusão ───────────
-- Sem política de UPDATE/DELETE: o usuário não muda limite, saldo nem extrato
-- por fora do backend. Padrão InitPlan (subquery) como o resto do projeto.
DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['house_credit_settings','house_credit_accounts','house_credit_entries'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = t AND policyname = t || '_org_select') THEN
      EXECUTE format($f$
        CREATE POLICY %I ON public.%I FOR SELECT TO authenticated
        USING (organization_id = (SELECT public.current_org_id())
               OR (SELECT public.is_platform_admin()))
      $f$, t || '_org_select', t);
    END IF;
    -- 2FA: o loop de database_migration_mfa_2fa.sql não é retroativo.
    IF NOT EXISTS (SELECT 1 FROM pg_policies
                    WHERE schemaname = 'public' AND tablename = t AND policyname = t || '_exige_mfa') THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I AS RESTRICTIVE TO authenticated '
        'USING ((SELECT public.mfa_satisfeito()))', t || '_exige_mfa', t);
    END IF;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM pg_policies
                  WHERE schemaname = 'public' AND tablename = 'house_credit_entries'
                    AND policyname = 'house_credit_entries_org_insert') THEN
    CREATE POLICY house_credit_entries_org_insert ON public.house_credit_entries
      FOR INSERT TO authenticated
      WITH CHECK (organization_id = (SELECT public.current_org_id())
                  OR (SELECT public.is_platform_admin()));
  END IF;
END $rls$;


-- ── 13) Log de atividade ────────────────────────────────────────────────────
-- Conta e config: quem mexeu no limite/prazo (o backend grava `updated_by`
-- explícito, porque pelo service role o log_activity registraria "Sistema").
-- Razão: só INSERT — os lançamentos gerados por trigger o próprio log_activity
-- ignora (pg_trigger_depth() > 1), e a venda que os gerou já é logada.
CREATE OR REPLACE TRIGGER trg_log_house_credit_accounts_ins
  AFTER INSERT ON public.house_credit_accounts
  FOR EACH ROW EXECUTE FUNCTION public.log_activity();
CREATE OR REPLACE TRIGGER trg_log_house_credit_accounts_upd
  AFTER UPDATE OF enabled, credit_limit, notes ON public.house_credit_accounts
  FOR EACH ROW EXECUTE FUNCTION public.log_activity();
CREATE OR REPLACE TRIGGER trg_log_house_credit_settings_ins
  AFTER INSERT ON public.house_credit_settings
  FOR EACH ROW EXECUTE FUNCTION public.log_activity();
CREATE OR REPLACE TRIGGER trg_log_house_credit_settings_upd
  AFTER UPDATE OF due_days, block_overdue, default_limit ON public.house_credit_settings
  FOR EACH ROW EXECUTE FUNCTION public.log_activity();
CREATE OR REPLACE TRIGGER trg_log_house_credit_entries_ins
  AFTER INSERT ON public.house_credit_entries
  FOR EACH ROW EXECUTE FUNCTION public.log_activity();


-- ── 14) Realtime: a conta (badge "deve R$ X" nas telas ao vivo) ─────────────
DO $publica$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                  WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
                    AND tablename = 'house_credit_accounts') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.house_credit_accounts;
  END IF;
END $publica$;


-- ── 15) Permissão nova: fiado.manage ────────────────────────────────────────
-- Habilitar jogador, limite, baixa, estorno de recebimento, lista de
-- devedores e configuração. Vender até o limite usa cash.operate; receber usa
-- a permissão de operação do caixa onde se recebe.
-- (a) BACKFILL de quem já administra o clube — sem isso o dono perde acesso no
--     instante do deploy.
UPDATE public.permission_groups
   SET permissions = permissions || ARRAY['fiado.manage']::text[],
       updated_at  = now()
 WHERE 'employees' = ANY(permissions)
   AND NOT ('fiado.manage' = ANY(permissions));

-- (b) provision_organization com a chave em v_all_perms. Corpo vigente em prod
--     (bar_fase0_modulo), MESMA assinatura de 9 parâmetros → CREATE OR REPLACE
--     substitui de verdade (ver database_migration_fix_provision_organization_ambigua.sql).
CREATE OR REPLACE FUNCTION public.provision_organization(p_org_name text, p_org_slug text, p_auth_user uuid, p_admin_name text, p_admin_email text, p_currency text DEFAULT 'BRL'::text, p_plan text DEFAULT 'free'::text, p_language text DEFAULT 'pt-BR'::text, p_modules text[] DEFAULT NULL::text[])
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_org uuid; v_group uuid;
    v_trial_days int; v_trial_ends timestamptz;
    v_idioma text := CASE WHEN COALESCE(NULLIF(p_language, ''), 'pt-BR') IN ('pt-BR','en-US','es-ES')
                          THEN COALESCE(NULLIF(p_language, ''), 'pt-BR') ELSE 'pt-BR' END;
    -- Mesma lista de ALL_PERMISSIONS do backend (staff_service.py).
    v_all_perms text[] := ARRAY['dashboard','stages','tournaments','players','cashier',
      'cashier_players','cashier_tickets','prizes','prizes_release','financial','reports',
      'general_cash','rankings','blinds','tables','broadcast','employees',
      'cashbox.operate','cashbox.admin','sangi','cashier_tickets.master',
      'cash.operate','cash.tables','cash.day','cash.reports','cash.admin',
      'access_log',
      'bar.operate','bar.shift','bar.admin','bar.reports',
      'fiado.manage'];
BEGIN
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_auth_user) THEN
        RAISE EXCEPTION 'Usuario % nao existe em auth.users', p_auth_user;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.plans WHERE code = p_plan) THEN
        RAISE EXCEPTION 'Plano % invalido', p_plan;
    END IF;
    SELECT trial_days INTO v_trial_days FROM public.plans WHERE code = p_plan;
    IF v_trial_days IS NOT NULL THEN
        v_trial_ends := now() + (v_trial_days || ' days')::interval;
    END IF;

    INSERT INTO public.organizations (name, slug, plan_code, plan_started_at, trial_ends_at)
    VALUES (p_org_name, p_org_slug, p_plan, now(), v_trial_ends) RETURNING id INTO v_org;

    -- Módulos contratados. O trigger já semeou 'tournament'; se o cliente
    -- comprou outra combinação, ela manda.
    IF p_modules IS NOT NULL AND array_length(p_modules, 1) > 0 THEN
        INSERT INTO public.org_modules (organization_id, module, enabled)
        SELECT v_org, m, true FROM unnest(p_modules) AS m
        ON CONFLICT (organization_id, module) DO UPDATE SET enabled = true, updated_at = now();
        UPDATE public.org_modules SET enabled = false, updated_at = now()
         WHERE organization_id = v_org AND NOT (module = ANY(p_modules));
    END IF;

    -- O Admin recebe TODAS as permissões; os demais, as suas. O nome e a
    -- descrição vêm traduzidos de cargos_padrao().
    INSERT INTO public.permission_groups (name, description, permissions, organization_id)
    SELECT c.nome, c.descricao, v_all_perms, v_org
      FROM public.cargos_padrao(v_idioma) c WHERE c.eh_admin
    RETURNING id INTO v_group;

    INSERT INTO public.permission_groups (name, description, permissions, organization_id)
    SELECT c.nome, c.descricao, c.permissoes, v_org
      FROM public.cargos_padrao(v_idioma) c WHERE NOT c.eh_admin;

    INSERT INTO public.staff (auth_user_id, name, email, permission_group_id, active, organization_id)
    VALUES (p_auth_user, p_admin_name, p_admin_email, v_group, true, v_org);

    INSERT INTO public.app_settings (currency, language, organization_id)
    VALUES (p_currency, v_idioma, v_org);

    INSERT INTO public.general_cash_register (current_balance, total_received, organization_id) VALUES (0,0,v_org);
    INSERT INTO public.rake_register (total_rake, organization_id) VALUES (0, v_org);

    INSERT INTO public.payment_methods (code, label, active, sort_order, organization_id)
    SELECT f.codigo, f.rotulo, true, f.ordem, v_org
      FROM public.formas_pagamento_padrao(v_idioma) f;

    RETURN v_org;
END $function$;


-- ── 16) delete_organization com as tabelas do fiado ─────────────────────────
-- Corpo vigente EM PROD (a seção 11 de database_migration_knockouts.sql não
-- foi aplicada lá), só com v_order acrescida. O razão sai logo depois do
-- ledger da gaveta (aponta para cash_transactions, cashboxes, cash_days,
-- bar_shifts e players, todos apagados depois); contas e config antes de
-- 'players'. A guarda de imutabilidade do razão libera o dono da função.
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
        'house_credit_entries',
        'bar_tab_payments','bar_tab_items','bar_stock_movements','bar_tabs',
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
        'house_credit_accounts','house_credit_settings',
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

RESET lock_timeout;


-- ── 17) Conferência ─────────────────────────────────────────────────────────
-- Uma assinatura só de provision_organization (deve ser 1):
--   SELECT count(*) FROM pg_proc WHERE proname = 'provision_organization';
-- RLS e 2FA nas tabelas novas (deve ser 0):
--   SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public' AND c.relname LIKE 'house\_credit\_%' AND c.relkind = 'r'
--      AND (NOT c.relrowsecurity OR NOT EXISTS (SELECT 1 FROM pg_policies p
--           WHERE p.tablename = c.relname AND p.policyname = c.relname || '_exige_mfa'));
-- Nenhuma política de UPDATE/DELETE nas tabelas do fiado (deve ser 0):
--   SELECT count(*) FROM pg_policies WHERE tablename LIKE 'house\_credit\_%' AND cmd IN ('UPDATE','DELETE','ALL');
-- Dono das funções (a guarda de imutabilidade libera 'postgres'):
--   SELECT proname, pg_get_userbyid(proowner) FROM pg_proc WHERE proname IN ('delete_organization','house_credit_entry_apply');
-- Admins com a permissão nova (deve ser 0):
--   SELECT count(*) FROM permission_groups WHERE 'employees' = ANY(permissions) AND NOT ('fiado.manage' = ANY(permissions));
