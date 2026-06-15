-- Fix: atomic oversell guard for chip consignment sales.
--
-- The application-layer check in ChipConsignmentService.register_sale reads
-- total_sold, compares against released_amount, then inserts the sale. Under
-- concurrency this is a TOCTOU race: many concurrent sales read the same stale
-- total_sold, all pass the check, and the consignment is oversold beyond what
-- was released to the sangi (observed: released 100, 24 concurrent sales of 10
-- all committed -> total_sold 240).
--
-- The existing AFTER INSERT trigger already does
--   UPDATE chip_consignments SET total_sold = total_sold + NEW.amount ...
-- which takes a row lock and therefore serializes concurrent sales. We enforce
-- the released_amount cap inside that same locked UPDATE so the check is atomic:
-- the sale that would breach the cap raises and its INSERT is rolled back.

CREATE OR REPLACE FUNCTION public.chip_consignment_apply_sale()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
    v_status   VARCHAR(12);
    v_total    NUMERIC;
    v_released NUMERIC;
BEGIN
    IF TG_OP = 'INSERT' THEN
        SELECT status INTO v_status FROM chip_consignments WHERE id = NEW.consignment_id;
        IF v_status IS NULL THEN
            RAISE EXCEPTION 'Consignação não encontrada';
        END IF;
        IF v_status <> 'open' THEN
            RAISE EXCEPTION 'Consignação já reconciliada; não aceita novas vendas';
        END IF;

        -- Locks the consignment row -> concurrent sales serialize here, so the
        -- running total is always consistent when we test it against the cap.
        UPDATE chip_consignments
            SET total_sold = total_sold + NEW.amount,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = NEW.consignment_id
            RETURNING total_sold, released_amount INTO v_total, v_released;

        IF v_total > v_released + 0.001 THEN
            RAISE EXCEPTION 'Venda excede o valor liberado (liberado %, total ficaria %)',
                v_released, v_total
                USING ERRCODE = 'check_violation';
        END IF;

        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        UPDATE chip_consignments
            SET total_sold = GREATEST(total_sold - OLD.amount, 0),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = OLD.consignment_id;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$function$;
