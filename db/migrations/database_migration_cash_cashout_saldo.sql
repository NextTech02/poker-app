-- ============================================================
-- Cash game: o cash-out ("levantar") não pode tirar da gaveta mais do que
-- ela tem.
--
-- A trava mora no espelho `mirror_cash_transaction_to_cashbox`, que já roda
-- DENTRO do INSERT em cash_transactions: se a gaveta não cobre o valor, o
-- RAISE derruba o lançamento pai junto — não sobra cash-out sem espelho.
-- O `FOR UPDATE` na gaveta serializa dois levantes simultâneos no mesmo
-- caixa: o segundo lê o saldo já descontado pelo primeiro.
--
-- Só `cash_out` é travado. Pagamento de jackpot sai do fundo do jackpot (que
-- tem a própria checagem) e estornos precisam poder deixar o caixa negativo.
--
-- O backend traduz o marcador REGRA_CAIXA:<code> para ErroDeNegocio
-- (cash_transaction_service._traduzir_erro_do_banco).
--
-- Mesma assinatura da função original (sem argumentos) → CREATE OR REPLACE
-- basta; nenhum DROP necessário.
-- ============================================================

CREATE OR REPLACE FUNCTION public.mirror_cash_transaction_to_cashbox()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp AS $fn$
DECLARE
    v_session_id UUID;
    v_saldo  DECIMAL(12,2);
    v_type   TEXT;
    v_signed DECIMAL(10,2);
BEGIN
    IF NEW.cashbox_id IS NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.type IN ('buy_in','rebuy') THEN
        v_type := 'cash_buy_in'; v_signed :=  NEW.amount;
    ELSIF NEW.type IN ('cash_out','jackpot_payout') THEN
        v_type := 'cash_out';    v_signed := -NEW.amount;
    ELSE
        RETURN NEW;
    END IF;

    SELECT current_session_id, current_balance
      INTO v_session_id, v_saldo
      FROM public.cashboxes WHERE id = NEW.cashbox_id
       FOR UPDATE;

    IF NEW.type = 'cash_out' AND COALESCE(v_saldo, 0) < NEW.amount THEN
        RAISE EXCEPTION
          'REGRA_CAIXA:saldo_insuficiente_no_caixa disponivel=% solicitado=%',
          COALESCE(v_saldo, 0), NEW.amount;
    END IF;

    INSERT INTO public.cashbox_transactions
        (cashbox_id, session_id, type, amount, signed_amount,
         cash_transaction_id, performed_by, notes, organization_id)
    VALUES
        (NEW.cashbox_id, v_session_id, v_type, NEW.amount, v_signed,
         NEW.id, NEW.created_by, NEW.notes, NEW.organization_id);

    RETURN NEW;
END $fn$;

-- Verificação:
--   SELECT prosrc LIKE '%REGRA_CAIXA%' FROM pg_proc
--    WHERE proname = 'mirror_cash_transaction_to_cashbox';
