-- ============================================================================
-- Cancelamento de venda — RECIBOS que tornam o estorno repetível sem cobrar duas vezes
-- ----------------------------------------------------------------------------
-- Complementa database_migration_cancel_sale.sql. Dois problemas de dinheiro
-- que a coluna `transactions.cancel_steps` sozinha NÃO resolve:
--
--   1. O marcador `cancel_steps` é gravado DEPOIS do passo, numa segunda
--      chamada que pode falhar (e o backend engole essa falha de propósito,
--      para não perder o estorno inteiro). Se o débito do caixa da etapa passa
--      e o marcador se perde, o admin que clica "cancelar" de novo debita
--      R$ 100 do caixa da etapa PELA SEGUNDA VEZ por uma única venda — e a
--      etapa fecha faltando dinheiro que ninguém tirou da gaveta.
--      Solução: um RECIBO por venda (`stage_cash_refunds`), gravado na MESMA
--      instrução que debita. Ou os dois acontecem, ou nenhum.
--
--   2. O cashback creditado por uma venda não é registrado em lugar nenhum —
--      `loyalty_ledger` só guarda PONTOS. Para estornar, o backend precisava
--      RECALCULAR `valor * %` usando o percentual do nível ATUAL do jogador.
--      Quem comprou como Bronze (0%) e depois subiu para Prata (1%) tinha a
--      venda antiga estornada a 1%: o clube tirava do saldo do jogador um
--      cashback que aquela venda nunca creditou.
--      Solução: o próprio gatilho de ganho passa a gravar o cashback na linha
--      do extrato (`loyalty_ledger.cashback_delta`). Daí em diante o estorno lê
--      o valor EXATO em vez de estimar.
--
-- ADITIVA e IDEMPOTENTE. O backend tolera o schema antigo: sem o recibo ele cai
-- no caminho de hoje, e sem `cashback_delta` ele volta a estimar — mas aí com
-- as três condições do gatilho conferidas, piso em zero e aviso explícito.
-- ============================================================================

-- ============================================================
-- 1) Recibo do estorno do CAIXA DA ETAPA
--    Uma linha por venda cancelada. É a única prova durável de que aquele
--    dinheiro já saiu do caixa da etapa — hoje o débito não deixa rastro
--    nenhum, então nem a auditoria nem a retentativa conseguem saber se já
--    aconteceu.
-- ============================================================
CREATE TABLE IF NOT EXISTS public.stage_cash_refunds (
  transaction_id  uuid PRIMARY KEY REFERENCES public.transactions(id) ON DELETE CASCADE,
  stage_id        uuid NOT NULL,
  amount          numeric(12,2) NOT NULL,
  organization_id uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stage_cash_refunds_stage
  ON public.stage_cash_refunds(stage_id);

COMMENT ON TABLE public.stage_cash_refunds IS
  'Recibo do estorno do caixa da etapa: uma linha por venda cancelada. A PK em transaction_id é o que impede '
  'uma retentativa de cancelamento de debitar o mesmo dinheiro duas vezes.';

GRANT SELECT, INSERT ON TABLE public.stage_cash_refunds TO authenticated;

ALTER TABLE public.stage_cash_refunds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS stage_cash_refunds_org_isolation ON public.stage_cash_refunds;
CREATE POLICY stage_cash_refunds_org_isolation ON public.stage_cash_refunds
  FOR ALL
  USING ((organization_id IS NULL) OR (organization_id = (SELECT current_org_id())) OR (SELECT is_platform_admin()))
  WITH CHECK ((organization_id IS NULL) OR (organization_id = (SELECT current_org_id())) OR (SELECT is_platform_admin()));

-- ============================================================
-- 2) Débito do caixa da etapa com recibo, numa instrução só
--    O recibo é inserido ANTES do débito e no MESMO comando: se a venda já
--    tinha sido estornada, o ON CONFLICT não insere nada, o UPDATE não roda e
--    a função devolve o saldo atual sem mexer em dinheiro.
--    Isso também cobre o caso em que a resposta HTTP se perde depois do commit:
--    a chamada seguinte encontra o recibo e não debita de novo.
--    SECURITY INVOKER: roda com o JWT do usuário, então o RLS por organização
--    continua valendo (ver saas_phase5_fix_definer_leak).
-- ============================================================
CREATE OR REPLACE FUNCTION public.debit_stage_cash_register_once(
  p_stage_id uuid, p_amount numeric, p_transaction_id uuid
)
RETURNS numeric
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_inseridos int;
  v_saldo     numeric;
  v_org       uuid;
BEGIN
  SELECT organization_id INTO v_org FROM public.transactions WHERE id = p_transaction_id;

  INSERT INTO public.stage_cash_refunds (transaction_id, stage_id, amount, organization_id)
  VALUES (p_transaction_id, p_stage_id, p_amount, v_org)
  ON CONFLICT (transaction_id) DO NOTHING;
  GET DIAGNOSTICS v_inseridos = ROW_COUNT;

  IF v_inseridos = 0 THEN
    -- Já estornado: devolve o saldo de hoje SEM debitar de novo. O backend
    -- ainda usa esse número para avisar que o caixa da etapa está negativo.
    SELECT current_balance INTO v_saldo
      FROM public.stage_cash_register WHERE stage_id = p_stage_id;
    RETURN v_saldo;
  END IF;

  UPDATE public.stage_cash_register
     SET current_balance = current_balance - p_amount,
         total_received  = total_received  - p_amount,
         updated_at      = now()
   WHERE stage_id = p_stage_id
  RETURNING current_balance INTO v_saldo;

  RETURN v_saldo;
END $$;

GRANT EXECUTE ON FUNCTION public.debit_stage_cash_register_once(uuid, numeric, uuid) TO authenticated;

COMMENT ON FUNCTION public.debit_stage_cash_register_once(uuid, numeric, uuid) IS
  'Devolve ao jogador o dinheiro de uma venda cancelada, UMA vez só por venda. '
  'Pode deixar o saldo NEGATIVO de propósito: se a venda já foi sangrada, o dinheiro realmente falta na gaveta '
  'e mascarar isso esconderia a diferença do fechamento.';

-- Recibos das vendas JÁ canceladas pelo backend anterior a esta migração: sem
-- eles, um "cancelar de novo" numa venda antiga presa em 'cancelling'
-- debitaria o caixa da etapa outra vez.
INSERT INTO public.stage_cash_refunds (transaction_id, stage_id, amount, organization_id)
SELECT tx.id, tr.stage_id, tx.amount, tx.organization_id
  FROM public.transactions tx
  JOIN public.tournaments tr ON tr.id = tx.tournament_id
 WHERE COALESCE(tx.status, 'active') <> 'active'
   AND 'caixa_etapa' = ANY(COALESCE(tx.cancel_steps, ARRAY[]::text[]))
   AND tr.stage_id IS NOT NULL
ON CONFLICT (transaction_id) DO NOTHING;

-- ============================================================
-- 3) O extrato de fidelidade passa a guardar o CASHBACK da venda
--    `delta` é PONTOS e continua sendo só pontos — mexer nele quebraria todo
--    leitor do saldo de pontos. O cashback ganha coluna própria.
-- ============================================================
ALTER TABLE public.loyalty_ledger
  ADD COLUMN IF NOT EXISTS cashback_delta numeric(12,2);

COMMENT ON COLUMN public.loyalty_ledger.cashback_delta IS
  'Cashback em DINHEIRO creditado (ou estornado) por esta linha. NULL = linha anterior a esta migração, '
  'quando o cashback não era registrado em lugar nenhum e o estorno precisava estimá-lo.';

-- ============================================================
-- 4) Gatilho de ganho: mesma regra, agora com recibo do cashback
--    Idêntico ao de database_migration_loyalty_phase2.sql, com UMA diferença:
--    a linha do extrato é gravada no fim, com os pontos E o cashback juntos, e
--    passa a existir também quando a venda gerou só cashback (pontos podem dar
--    zero em valores baixos, e nesse caso o cashback ficava invisível).
-- ============================================================
CREATE OR REPLACE FUNCTION public.loyalty_earn_on_transaction()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
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
END $$;
