-- Migration: prêmio pago NÃO entra no caixa do operador
-- Date: 2026-10-14
--
-- O pagamento de prêmio (PrizeAllocationService.pay_prize) desconta do CAIXA
-- GERAL — é de lá (dinheiro da sangria) que o prêmio sai. Mas o gatilho
-- `resolve_transaction_cashbox` ligava TODA transação ao caixa aberto de quem a
-- criou, e `mirror_transaction_to_cashbox` espelhava o prêmio como saída nesse
-- caixa. Resultado: o mesmo prêmio saía duas vezes — do caixa geral e da gaveta
-- do operador. Visto ao vivo em 2026-10-14: o operador abriu o caixa só para
-- pagar S/ 3.280 e ficou com saldo S/ -3.280 (corrigido à mão no mesmo dia).
--
-- Agora transação do tipo 'prize' não é ligada ao caixa do operador. Vendas
-- (buy-in, rebuy, add-on) continuam exatamente como antes.

CREATE OR REPLACE FUNCTION public.resolve_transaction_cashbox()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    v_stage_id UUID;
    v_cashbox_id UUID;
BEGIN
    IF NEW.cashbox_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    -- Prêmio sai do CAIXA GERAL (pay_prize já desconta lá): ligá-lo ao caixa
    -- do operador duplicaria a saída na gaveta dele.
    IF NEW.type = 'prize' THEN
        RETURN NEW;
    END IF;

    IF NEW.created_by IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT stage_id INTO v_stage_id
    FROM tournaments
    WHERE id = NEW.tournament_id;

    IF v_stage_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT c.id INTO v_cashbox_id
    FROM cashboxes c
    JOIN staff s ON s.id = c.staff_id
    WHERE s.auth_user_id = NEW.created_by
      AND c.stage_id = v_stage_id
      AND c.status = 'open';

    IF v_cashbox_id IS NOT NULL THEN
        NEW.cashbox_id := v_cashbox_id;
    END IF;
    RETURN NEW;
END;
$function$;
