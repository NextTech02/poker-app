-- SaaS — triggers passam a HERDAR organization_id da linha de origem.
--
-- Bug latente encontrado ao testar a exclusão de organização: estes triggers
-- inserem em tabelas filhas sem informar organization_id, contando com o DEFAULT
-- `current_org_id()`. Isso só funciona quando a sessão tem o claim do JWT —
-- qualquer caminho sem claim (service_role, rotina administrativa, migração de
-- dados, o próprio /sync/batch) quebra com "null value in column
-- organization_id violates not-null constraint".
--
-- Correção: derivar a organização da linha que disparou o trigger (NEW). Além
-- de não depender da sessão, é semanticamente mais correto — o caixa da etapa
-- pertence, por definição, à mesma organização da etapa.

CREATE OR REPLACE FUNCTION public.create_stage_cash_register()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
    INSERT INTO stage_cash_register (stage_id, current_balance, total_received, total_sangrias, organization_id)
    VALUES (NEW.id, 0.00, 0.00, 0.00, NEW.organization_id)
    ON CONFLICT (stage_id) DO NOTHING;
    RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.mirror_transaction_to_cashbox()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_session_id UUID;
    v_signed DECIMAL(10, 2);
BEGIN
    -- Only mirror if cashbox_id was resolved by the BEFORE trigger
    IF NEW.cashbox_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT current_session_id INTO v_session_id
    FROM cashboxes
    WHERE id = NEW.cashbox_id;

    IF NEW.type = 'prize' THEN
        v_signed := -1 * NEW.amount;
    ELSE
        v_signed := NEW.amount;
    END IF;

    INSERT INTO cashbox_transactions
        (cashbox_id, session_id, type, amount, signed_amount, transaction_id, performed_by, notes, organization_id)
    VALUES
        (NEW.cashbox_id, v_session_id, NEW.type, NEW.amount, v_signed, NEW.id, NEW.created_by, NEW.notes, NEW.organization_id);

    RETURN NEW;
END;
$function$;
