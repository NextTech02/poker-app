-- ============================================================================
-- FIADO DA CASA — Fase 3: prêmio de torneio (posição e KO) desconta a dívida
-- ----------------------------------------------------------------------------
-- Conta única do jogador: quem deve fiado e ganha prêmio recebe o LÍQUIDO; a
-- parte abatida quita a dívida.
--
-- DECISÕES QUE ESTE ARQUIVO MATERIALIZA:
--   * O prêmio continua BRUTO em `transactions.amount`, `prize_allocations.
--     prize_amount` e `tournament_knockout_payouts.cash_amount`: o DRE, o
--     pool, o "total pago", as estatísticas do jogador e o invariante do KO
--     somam o bruto. Abater ali também contaria o desconto duas vezes.
--   * O abatido vai em `transactions.house_debt_offset`, e o lançamento
--     `prize_offset` do razão nasce NO MESMO INSERT (trigger) — o mesmo
--     desenho do cash-out. Se a dívida não cobre o abatimento (corrida com um
--     recebimento), a transação do prêmio não existe.
--   * O caixa geral é debitado só pelo LÍQUIDO (pelo backend, com a RPC
--     atômica debit_general_cash_register). O prêmio não passa por gaveta de
--     operador (resolve_transaction_cashbox já pula 'prize').
--   * Prêmio com abatimento é imutável e não se estorna (o que o gerou já foi
--     pago e quitado).
--
-- ORDEM: DEPOIS de database_migration_fiado_fase0.sql. Mexe em `transactions`
-- (tabela quente do torneio): aplicar FORA de horário de evento. Reaplicável.
-- ============================================================================

SET lock_timeout = '5s';

DO $guard$ BEGIN
  IF to_regclass('public.house_credit_entries') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_fiado_fase0.sql';
  END IF;
  IF to_regclass('public.tournament_knockout_payouts') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_knockouts.sql';
  END IF;
END $guard$;


-- ── 1) Colunas ──────────────────────────────────────────────────────────────
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS house_debt_offset          DECIMAL(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS house_debt_offset_expected DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS house_debt_offset_reason   TEXT;

-- Reimpressão do comprovante: bruto, abatido e líquido ficam na linha paga.
ALTER TABLE public.prize_allocations
  ADD COLUMN IF NOT EXISTS debt_offset DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS net_paid    DECIMAL(12,2);
ALTER TABLE public.tournament_knockout_payouts
  ADD COLUMN IF NOT EXISTS debt_offset DECIMAL(12,2),
  ADD COLUMN IF NOT EXISTS net_paid    DECIMAL(12,2);

ALTER TABLE public.house_credit_entries
  ADD COLUMN IF NOT EXISTS transaction_id UUID REFERENCES public.transactions(id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_house_credit_entries_premio
  ON public.house_credit_entries (transaction_id)
  WHERE transaction_id IS NOT NULL;

DO $checks$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_abatimento_fiado') THEN
    ALTER TABLE public.transactions ADD CONSTRAINT transactions_abatimento_fiado
      CHECK (house_debt_offset >= 0
             AND house_debt_offset <= amount
             AND (house_debt_offset = 0 OR type = 'prize'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hce_premio_aponta_transacao') THEN
    ALTER TABLE public.house_credit_entries ADD CONSTRAINT hce_premio_aponta_transacao
      CHECK (type <> 'prize_offset' OR transaction_id IS NOT NULL);
  END IF;
END $checks$;


-- ── 2) Porta de entrada do razão: prize_offset só do INSERT do prêmio ───────
-- Corpo de database_migration_fiado_fase0.sql, com o ramo do prize_offset
-- trocado (lá ele exigia uma flag de RPC; aqui segue o desenho do cash-out).
CREATE OR REPLACE FUNCTION public.house_credit_entry_gate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_priv  boolean := current_user IN ('service_role', 'postgres', 'supabase_admin');
  v_cb    record;
  v_tx    record;
  v_pr    record;
  v_orig  record;
  v_sess  uuid;
BEGIN
  IF NOT v_priv AND pg_trigger_depth() < 2 THEN
    NEW.created_by := auth.uid();
  END IF;

  IF NEW.type = 'payment' THEN
    SELECT id, organization_id, status, stage_id, cash_day_id, bar_shift_id
      INTO v_cb FROM public.cashboxes WHERE id = NEW.cashbox_id;
    IF NOT FOUND OR v_cb.status IS DISTINCT FROM 'open' THEN
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
    -- Só nasce do INSERT do prêmio (trg_transactions_fiado_lancar), coerente
    -- com ele. Inserido solto seria dívida perdoada sem prêmio nenhum.
    IF pg_trigger_depth() < 2 THEN
      RAISE EXCEPTION 'REGRA_FIADO:lancamento_so_pelo_caixa';
    END IF;
    SELECT id, organization_id, player_id, type, house_debt_offset
      INTO v_pr FROM public.transactions WHERE id = NEW.transaction_id;
    IF NOT FOUND
       OR v_pr.organization_id IS DISTINCT FROM NEW.organization_id
       OR v_pr.player_id IS DISTINCT FROM NEW.player_id
       OR v_pr.type IS DISTINCT FROM 'prize'
       OR v_pr.house_debt_offset IS DISTINCT FROM NEW.amount THEN
      RAISE EXCEPTION 'REGRA_FIADO:lancamento_incoerente';
    END IF;
    NEW.module := 'tournament';
    NEW.cashbox_id := NULL;
  END IF;

  RETURN NEW;
END $fn$;


-- ── 3) Prêmio com abatimento → prize_offset, no mesmo INSERT ────────────────
CREATE OR REPLACE FUNCTION public.transactions_fiado_lancar()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF COALESCE(NEW.house_debt_offset, 0) > 0 THEN
    INSERT INTO public.house_credit_entries
      (organization_id, player_id, type, amount, transaction_id, created_by, reason)
    VALUES
      (NEW.organization_id, NEW.player_id, 'prize_offset', NEW.house_debt_offset,
       NEW.id, NEW.created_by, NEW.house_debt_offset_reason);
  END IF;
  RETURN NEW;
END $fn$;

-- ── 4) Prêmio que abateu fiado não muda nem se estorna ──────────────────────
CREATE OR REPLACE FUNCTION public.transactions_fiado_imutavel()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF (COALESCE(OLD.house_debt_offset, 0) > 0 OR COALESCE(NEW.house_debt_offset, 0) > 0)
     AND (NEW.amount IS DISTINCT FROM OLD.amount
          OR NEW.type IS DISTINCT FROM OLD.type
          OR NEW.player_id IS DISTINCT FROM OLD.player_id
          OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
          OR NEW.house_debt_offset IS DISTINCT FROM OLD.house_debt_offset
          OR NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'REGRA_FIADO:lancamento_imutavel';
  END IF;
  RETURN NEW;
END $fn$;

CREATE OR REPLACE TRIGGER trg_transactions_fiado_lancar
  AFTER INSERT ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.transactions_fiado_lancar();
CREATE OR REPLACE TRIGGER trg_transactions_fiado_imutavel
  BEFORE UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.transactions_fiado_imutavel();

RESET lock_timeout;

-- ── 5) Conferência ──────────────────────────────────────────────────────────
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname IN ('transactions_abatimento_fiado','hce_premio_aponta_transacao');
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.transactions'::regclass AND tgname LIKE '%fiado%';
