-- ============================================================
-- Bar: custo MÉDIO PONDERADO nas entradas de estoque.
--
-- Antes: cada entrada com custo SOBRESCREVIA bar_products.cost_price. Com
-- compras a preços diferentes (24 un a 4,50 e depois 24 a 5,00), o estoque
-- antigo passava a ser custeado pelo último preço e o CMV do relatório saía
-- errado.
--
-- Agora: a entrada ('in') com custo recalcula
--     custo = (saldo × custo_atual + qtd × custo_da_entrada) / (saldo + qtd)
-- onde saldo = estoque ANTES da entrada (nunca negativo). Sem saldo, ou sem
-- custo anterior, vale o custo da entrada. Ex.: 24×4,50 + 24×5,00 → 4,75.
--
-- Roda num trigger BEFORE INSERT com FOR UPDATE no produto: duas entradas
-- simultâneas não leem o mesmo saldo. Como o trigger é BEFORE e o
-- `bar_apply_stock_qty` (que soma a quantidade) é AFTER, o stock_qty lido
-- aqui é o de antes desta entrada.
--
-- Precisão: custo em 4 casas. Uma caixa de 12 por R$ 50,00 dá 4,1667 — com
-- 2 casas virava 4,17 e o total da nota fechava em 50,04. `total_cost`
-- guarda o valor da nota como foi informado; quando vem sem `unit_cost`, o
-- trigger deriva o unitário dele.
--
-- DEPLOY: aplicar ANTES do backend novo — o backend deixou de gravar
-- cost_price na entrada (o trigger faz isso).
-- ============================================================

-- 1) Precisão do custo (não há views dependentes dessas colunas).
ALTER TABLE public.bar_products        ALTER COLUMN cost_price TYPE NUMERIC(12,4);
ALTER TABLE public.bar_stock_movements ALTER COLUMN unit_cost  TYPE NUMERIC(12,4);
ALTER TABLE public.bar_tab_items       ALTER COLUMN unit_cost  TYPE NUMERIC(12,4);

-- 2) Total da nota, como o operador digitou.
ALTER TABLE public.bar_stock_movements
    ADD COLUMN IF NOT EXISTS total_cost NUMERIC(12,2) CHECK (total_cost IS NULL OR total_cost >= 0);

COMMENT ON COLUMN public.bar_products.cost_price IS
  'Custo MÉDIO PONDERADO do estoque, recalculado a cada entrada com custo (trigger bar_stock_weighted_cost). Copiado para o item na venda (snapshot).';
COMMENT ON COLUMN public.bar_stock_movements.total_cost IS
  'Total da nota informado na entrada. unit_cost = total_cost / quantity quando o unitário não veio.';

-- 3) Média ponderada.
CREATE OR REPLACE FUNCTION public.bar_stock_weighted_cost()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE
    v_saldo INT;
    v_custo NUMERIC(12,4);
BEGIN
    IF NEW.kind <> 'in' OR NEW.quantity <= 0 THEN
        RETURN NEW;
    END IF;

    IF NEW.unit_cost IS NULL AND NEW.total_cost IS NOT NULL THEN
        NEW.unit_cost := round(NEW.total_cost / NEW.quantity, 4);
    END IF;
    IF NEW.unit_cost IS NULL THEN
        RETURN NEW;          -- entrada sem custo: não mexe na média
    END IF;

    SELECT GREATEST(stock_qty, 0), cost_price
      INTO v_saldo, v_custo
      FROM public.bar_products
     WHERE id = NEW.product_id
       FOR UPDATE;

    IF v_saldo IS NULL THEN
        RETURN NEW;          -- produto inexistente: a FK recusa em seguida
    END IF;

    IF v_saldo = 0 OR v_custo IS NULL OR v_custo = 0 THEN
        v_custo := NEW.unit_cost;
    ELSE
        v_custo := round((v_saldo * v_custo + NEW.quantity * NEW.unit_cost)
                         / (v_saldo + NEW.quantity), 4);
    END IF;

    UPDATE public.bar_products
       SET cost_price = v_custo, updated_at = now()
     WHERE id = NEW.product_id;

    RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_bar_stock_weighted_cost ON public.bar_stock_movements;
CREATE TRIGGER trg_bar_stock_weighted_cost
    BEFORE INSERT ON public.bar_stock_movements
    FOR EACH ROW EXECUTE FUNCTION public.bar_stock_weighted_cost();

-- Verificação (num produto de teste com track_stock e estoque 0):
--   INSERT INTO bar_stock_movements (product_id, kind, quantity, unit_cost) VALUES (:p, 'in', 24, 4.50);
--   INSERT INTO bar_stock_movements (product_id, kind, quantity, unit_cost) VALUES (:p, 'in', 24, 5.00);
--   SELECT cost_price, stock_qty FROM bar_products WHERE id = :p;   -- 4.7500 | 48
