-- ============================================================================
-- MÓDULO DE BAR — Fase 1: catálogo, estoque, turno, comandas, itens, pagamentos
-- e o caixa próprio do bar (terceira âncora de `cashboxes`)
-- ----------------------------------------------------------------------------
-- O DESENHO EM UMA FRASE: o barman abre o TURNO e a sua GAVETA; cada jogador
-- tem UMA comanda aberta por vez; os itens caem como pedidos pendentes e
-- baixam o estoque; a comanda é quitada em uma ou várias baixas (dinheiro em
-- qualquer meio, ou crédito do jogador) e fecha com saldo zero; o turno só
-- fecha sem comanda aberta.
--
-- DECISÕES QUE ESTE ARQUIVO MATERIALIZA (não "simplificar" depois):
--   * Caixa próprio do bar = `cashboxes` com a terceira âncora `bar_shift_id`.
--     Nada de tabela nova de caixa: abertura, fechamento, conferência e
--     demonstrativo do CashboxService valem para o bar sem mudança.
--   * Só dinheiro REAL espelha na gaveta (`payment_source = 'cash'`, seja o
--     meio dinheiro, PIX ou cartão). Perna de crédito do jogador não é dinheiro
--     na gaveta e por isso não gera `cashbox_transactions`.
--   * `bar_sale` é tipo PRÓPRIO no ledger da gaveta. get_summary, demonstrativo
--     e Financeiro agregam por literal de tipo — reusar `buy_in` misturaria a
--     receita do bar com a do torneio em toda tela, sem forma de separar.
--   * Comanda ÚNICA por jogador = índice parcial (organization_id, player_id)
--     WHERE status = 'open'. Dois operadores abrindo ao mesmo tempo: o banco
--     decide, o serviço relê.
--   * Itens são IMUTÁVEIS (fora status e cortesia), com SNAPSHOT de nome, preço
--     e custo: mudar o preço amanhã não reescreve a comanda de ontem. Errou,
--     cancela com motivo e relança.
--   * Totais da comanda são RECONTADOS do zero pelo trigger (nunca
--     incrementados) — o mesmo padrão de cash_touch_player_session.
--   * Estoque é um LEDGER (bar_stock_movements). Venda e cancelamento geram
--     movimento por trigger; `stock_qty` é mantido por trigger no movimento.
--     A venda NUNCA bloqueia por estoque: a cerveja já está na mão do cliente,
--     o errado é a contagem. Pode ficar negativo e o relatório avisa.
--   * Número da comanda sai de `bar_shifts.last_tab_number` com
--     UPDATE ... RETURNING (lock de linha): MAX+1 colide com dois caixas.
--
-- ORDEM: aplicar DEPOIS de database_migration_bar_fase0_modulo.sql e de
-- database_migration_cash_fase1_core.sql (o CHECK novo de `cashboxes`
-- referencia `cash_day_id`). Reaplicável.
-- ============================================================================

DO $guard$ BEGIN
  IF to_regclass('public.org_modules') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_cash_fase0_modulos.sql';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'org_modules_module_check'
       AND pg_get_constraintdef(oid) LIKE '%bar%'
  ) THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_bar_fase0_modulo.sql';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'cashboxes' AND column_name = 'cash_day_id'
  ) THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_cash_fase1_core.sql (cashboxes.cash_day_id)';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'cashbox_transactions_type_check'
       AND pg_get_constraintdef(oid) LIKE '%refund%'
  ) THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_cancel_sale.sql (tipo refund no ledger)';
  END IF;
END $guard$;


-- ── 1) Turno do bar ─────────────────────────────────────────────────────────
-- Espelho de cash_days, com uma diferença deliberada: SEM UNIQUE (org, data).
-- O bar pode ter o turno da tarde e o da noite no mesmo dia. O que continua
-- único é o turno ABERTO por organização.
CREATE TABLE IF NOT EXISTS public.bar_shifts (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id    UUID NOT NULL DEFAULT public.current_org_id()
                       REFERENCES public.organizations(id) ON DELETE RESTRICT,
    business_date      DATE NOT NULL,
    label              VARCHAR(160),
    status             VARCHAR(16) NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','closed')),
    opened_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    opened_by          UUID REFERENCES auth.users(id),
    closed_at          TIMESTAMPTZ,
    closed_by          UUID REFERENCES auth.users(id),
    -- Sequência das comandas DESTE turno (1, 2, 3...). Avança por
    -- UPDATE ... RETURNING no trigger de inserção da comanda.
    last_tab_number    INT NOT NULL DEFAULT 0,
    -- Congelados no fechamento. NULL enquanto aberto: a leitura ao vivo agrega
    -- as comandas, e gravar um total parcial só criaria dois números
    -- divergentes para a mesma pergunta.
    total_gross        DECIMAL(12,2),
    total_discounts    DECIMAL(12,2),
    total_courtesy     DECIMAL(12,2),
    total_net          DECIMAL(12,2),
    total_paid         DECIMAL(12,2),
    total_paid_cash    DECIMAL(12,2),
    total_paid_credit  DECIMAL(12,2),
    total_cogs         DECIMAL(12,2),
    tabs_count         INT,
    items_count        INT,
    totals_by_method   JSONB,
    notes              TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bar_shifts_organization_id ON public.bar_shifts(organization_id);
CREATE INDEX IF NOT EXISTS idx_bar_shifts_date ON public.bar_shifts(organization_id, business_date DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bar_shift_aberto_por_org
    ON public.bar_shifts(organization_id) WHERE status = 'open';

COMMENT ON COLUMN public.bar_shifts.business_date IS
  'Data OPERACIONAL, escolhida na abertura. Nunca now()::date: a noite que atravessa a meia-noite é um turno só.';
COMMENT ON COLUMN public.bar_shifts.total_cogs IS
  'Custo das mercadorias vendidas (Σ unit_cost × quantity dos itens ativos, cortesia inclusa). INFORMATIVO no DRE — a compra da mercadoria já entra como despesa; subtrair o CMV também contaria duas vezes.';


-- ── 2) Catálogo: categorias e produtos ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bar_product_categories (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID NOT NULL DEFAULT public.current_org_id()
                     REFERENCES public.organizations(id) ON DELETE CASCADE,
    name             VARCHAR(80) NOT NULL,
    sort_order       INT NOT NULL DEFAULT 0,
    active           BOOLEAN NOT NULL DEFAULT true,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bar_categories_organization_id ON public.bar_product_categories(organization_id);

CREATE TABLE IF NOT EXISTS public.bar_products (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID NOT NULL DEFAULT public.current_org_id()
                     REFERENCES public.organizations(id) ON DELETE CASCADE,
    category_id      UUID REFERENCES public.bar_product_categories(id) ON DELETE SET NULL,
    name             VARCHAR(120) NOT NULL,
    description      TEXT,
    price            DECIMAL(10,2) NOT NULL CHECK (price >= 0),
    -- Custo unitário ATUAL, copiado para o item na venda (snapshot). Serve à
    -- margem do relatório, nunca ao preço.
    cost_price       DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (cost_price >= 0),
    track_stock      BOOLEAN NOT NULL DEFAULT false,
    -- Mantido EXCLUSIVAMENTE pelo trigger de bar_stock_movements. Editar a
    -- coluna à mão desalinha o ledger; o backend recusa (estoque_so_por_movimento).
    stock_qty        INT NOT NULL DEFAULT 0,
    min_stock        INT NOT NULL DEFAULT 0 CHECK (min_stock >= 0),
    sku              VARCHAR(40),
    active           BOOLEAN NOT NULL DEFAULT true,
    sort_order       INT NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bar_products_organization_id ON public.bar_products(organization_id);
CREATE INDEX IF NOT EXISTS idx_bar_products_category ON public.bar_products(category_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bar_products_sku_org
    ON public.bar_products(organization_id, lower(sku)) WHERE sku IS NOT NULL;


-- ── 3) Ledger de estoque ────────────────────────────────────────────────────
-- Append-only. `quantity` leva o SINAL: entrada +, venda −, devolução por
-- cancelamento +, ajuste ±, perda −.
CREATE TABLE IF NOT EXISTS public.bar_stock_movements (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id    UUID NOT NULL DEFAULT public.current_org_id()
                       REFERENCES public.organizations(id) ON DELETE RESTRICT,
    product_id         UUID NOT NULL REFERENCES public.bar_products(id) ON DELETE RESTRICT,
    kind               VARCHAR(20) NOT NULL
                       CHECK (kind IN ('in','sale','adjustment','loss','cancel_restore')),
    quantity           INT NOT NULL CHECK (quantity <> 0),
    unit_cost          DECIMAL(10,2),
    -- Preenchido nos movimentos AUTOMÁTICOS (venda/devolução); é a chave de
    -- idempotência deles — ver uq_bar_stock_item_kind.
    tab_item_id        UUID,
    notes              TEXT,
    client_mutation_id TEXT,
    created_by         UUID REFERENCES auth.users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bar_stock_organization_id ON public.bar_stock_movements(organization_id);
CREATE INDEX IF NOT EXISTS idx_bar_stock_product ON public.bar_stock_movements(product_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bar_stock_item_kind
    ON public.bar_stock_movements(tab_item_id, kind) WHERE tab_item_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_bar_stock_client_mutation
    ON public.bar_stock_movements(organization_id, client_mutation_id)
    WHERE client_mutation_id IS NOT NULL;


-- ── 4) Comanda ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bar_tabs (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id    UUID NOT NULL DEFAULT public.current_org_id()
                       REFERENCES public.organizations(id) ON DELETE RESTRICT,
    bar_shift_id       UUID NOT NULL REFERENCES public.bar_shifts(id) ON DELETE RESTRICT,
    player_id          UUID NOT NULL REFERENCES public.players(id) ON DELETE RESTRICT,
    number             INT NOT NULL,
    status             VARCHAR(16) NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','closed','cancelled')),
    -- Recontados pelo trigger a cada item/pagamento (nunca incrementados).
    subtotal           DECIMAL(12,2) NOT NULL DEFAULT 0,
    courtesy_amount    DECIMAL(12,2) NOT NULL DEFAULT 0,
    discount_amount    DECIMAL(12,2) NOT NULL DEFAULT 0 CHECK (discount_amount >= 0),
    discount_reason    TEXT,
    total              DECIMAL(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
    paid_amount        DECIMAL(12,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
    opened_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    opened_by          UUID REFERENCES auth.users(id),
    closed_at          TIMESTAMPTZ,
    closed_by          UUID REFERENCES auth.users(id),
    cancelled_at       TIMESTAMPTZ,
    cancelled_by       UUID REFERENCES auth.users(id),
    cancel_reason      TEXT,
    notes              TEXT,
    client_mutation_id TEXT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bar_tabs_desconto_com_motivo
        CHECK (discount_amount = 0 OR discount_reason IS NOT NULL),
    UNIQUE (bar_shift_id, number)
);
CREATE INDEX IF NOT EXISTS idx_bar_tabs_organization_id ON public.bar_tabs(organization_id);
CREATE INDEX IF NOT EXISTS idx_bar_tabs_shift ON public.bar_tabs(bar_shift_id, status);
CREATE INDEX IF NOT EXISTS idx_bar_tabs_player ON public.bar_tabs(player_id, opened_at DESC);
-- COMANDA ÚNICA POR JOGADOR: a regra de negócio, no banco.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bar_tab_aberta_por_jogador
    ON public.bar_tabs(organization_id, player_id) WHERE status = 'open';
CREATE UNIQUE INDEX IF NOT EXISTS uq_bar_tabs_client_mutation
    ON public.bar_tabs(organization_id, client_mutation_id)
    WHERE client_mutation_id IS NOT NULL;

COMMENT ON COLUMN public.bar_tabs.total IS
  'subtotal − LEAST(discount_amount, subtotal). Cortesia NÃO entra no subtotal (courtesy_amount é informativo).';
COMMENT ON COLUMN public.bar_tabs.discount_amount IS
  '"Saiu sem pagar" é desconto de 100% com motivo: a comanda fecha com total 0, o estoque continua consumido e o CMV conta.';


-- ── 5) Itens da comanda ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.bar_tab_items (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id    UUID NOT NULL DEFAULT public.current_org_id()
                       REFERENCES public.organizations(id) ON DELETE RESTRICT,
    tab_id             UUID NOT NULL REFERENCES public.bar_tabs(id) ON DELETE RESTRICT,
    -- Desnormalizado pelo trigger: as telas de pedidos e o fechamento do turno
    -- filtram por turno sem passar pela comanda.
    bar_shift_id       UUID NOT NULL REFERENCES public.bar_shifts(id) ON DELETE RESTRICT,
    product_id         UUID NOT NULL REFERENCES public.bar_products(id) ON DELETE RESTRICT,
    -- SNAPSHOT (nome, preço, custo). Nunca ler pela FK: mudar o preço amanhã
    -- não pode reescrever a comanda de ontem.
    product_name       VARCHAR(120) NOT NULL,
    unit_price         DECIMAL(10,2) NOT NULL CHECK (unit_price >= 0),
    unit_cost          DECIMAL(10,2) NOT NULL DEFAULT 0,
    quantity           INT NOT NULL CHECK (quantity > 0),
    line_total         DECIMAL(10,2) NOT NULL DEFAULT 0,
    is_courtesy        BOOLEAN NOT NULL DEFAULT false,
    courtesy_reason    TEXT,
    status             VARCHAR(16) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','delivered','cancelled')),
    delivered_at       TIMESTAMPTZ,
    delivered_by       UUID REFERENCES auth.users(id),
    cancelled_at       TIMESTAMPTZ,
    cancelled_by       UUID REFERENCES auth.users(id),
    cancel_reason      TEXT,
    notes              TEXT,
    client_mutation_id TEXT,
    created_by         UUID REFERENCES auth.users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT bar_tab_items_cortesia_com_motivo
        CHECK (NOT is_courtesy OR courtesy_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_bar_tab_items_organization_id ON public.bar_tab_items(organization_id);
CREATE INDEX IF NOT EXISTS idx_bar_tab_items_tab ON public.bar_tab_items(tab_id);
CREATE INDEX IF NOT EXISTS idx_bar_tab_items_shift_status ON public.bar_tab_items(bar_shift_id, status);
CREATE INDEX IF NOT EXISTS idx_bar_tab_items_product ON public.bar_tab_items(product_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bar_tab_items_client_mutation
    ON public.bar_tab_items(organization_id, client_mutation_id)
    WHERE client_mutation_id IS NOT NULL;


-- ── 6) Pagamentos (uma linha por PERNA) ─────────────────────────────────────
-- Pagamento dividido = várias linhas com o mesmo prefixo de client_mutation_id
-- (`<cmid>:0`, `<cmid>:1`...). Parcial = várias baixas ao longo da noite.
CREATE TABLE IF NOT EXISTS public.bar_tab_payments (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id    UUID NOT NULL DEFAULT public.current_org_id()
                       REFERENCES public.organizations(id) ON DELETE RESTRICT,
    tab_id             UUID NOT NULL REFERENCES public.bar_tabs(id) ON DELETE RESTRICT,
    bar_shift_id       UUID NOT NULL REFERENCES public.bar_shifts(id) ON DELETE RESTRICT,
    -- SEMPRE positivo. O estorno é uma linha de `refund` no ledger da gaveta
    -- (cashbox_transactions.bar_payment_id) + status = 'cancelled' aqui.
    amount             DECIMAL(10,2) NOT NULL CHECK (amount > 0),
    -- Código de payment_methods (cash/pix/card/...), ou 'credit'.
    payment_method     VARCHAR(50) NOT NULL,
    -- 'cash' = dinheiro real (qualquer meio) → espelha na gaveta.
    -- 'credit' = crédito do jogador (player_credits) → NÃO toca a gaveta.
    payment_source     VARCHAR(16) NOT NULL DEFAULT 'cash'
                       CHECK (payment_source IN ('cash','credit')),
    cashbox_id         UUID REFERENCES public.cashboxes(id) ON DELETE SET NULL,
    status             VARCHAR(16) NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','cancelling','cancelled')),
    cancelled_at       TIMESTAMPTZ,
    cancelled_by       UUID REFERENCES auth.users(id),
    cancel_reason      TEXT,
    cancel_steps       TEXT[] NOT NULL DEFAULT '{}',
    notes              TEXT,
    client_mutation_id TEXT,
    created_by         UUID REFERENCES auth.users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_bar_payments_organization_id ON public.bar_tab_payments(organization_id);
CREATE INDEX IF NOT EXISTS idx_bar_payments_tab ON public.bar_tab_payments(tab_id);
CREATE INDEX IF NOT EXISTS idx_bar_payments_shift_status ON public.bar_tab_payments(bar_shift_id, status);
CREATE INDEX IF NOT EXISTS idx_bar_payments_cashbox ON public.bar_tab_payments(cashbox_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bar_payments_client_mutation
    ON public.bar_tab_payments(organization_id, client_mutation_id)
    WHERE client_mutation_id IS NOT NULL;

-- Agora que bar_tab_payments existe, o ledger de estoque pode apontar para o item.
ALTER TABLE public.bar_stock_movements
  DROP CONSTRAINT IF EXISTS bar_stock_movements_tab_item_id_fkey;
ALTER TABLE public.bar_stock_movements
  ADD CONSTRAINT bar_stock_movements_tab_item_id_fkey
  FOREIGN KEY (tab_item_id) REFERENCES public.bar_tab_items(id) ON DELETE SET NULL;


-- ── 7) A gaveta do bar: terceira âncora de `cashboxes` ──────────────────────
-- Espelho de cash_fase1_core.sql §9. Sequência segura numa tabela em produção
-- com dinheiro dentro: ADD COLUMN (não destrutivo) antes; o CHECK trocado numa
-- instrução; a conferência do fim do arquivo confirma que nenhuma gaveta
-- ficou sem âncora ou com duas.
ALTER TABLE public.cashboxes
  ADD COLUMN IF NOT EXISTS bar_shift_id UUID REFERENCES public.bar_shifts(id) ON DELETE CASCADE;

ALTER TABLE public.cashboxes DROP CONSTRAINT IF EXISTS cashboxes_ancora_unica;
ALTER TABLE public.cashboxes ADD CONSTRAINT cashboxes_ancora_unica
  CHECK (num_nonnulls(stage_id, cash_day_id, bar_shift_id) = 1);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cashbox_staff_bar_shift
  ON public.cashboxes(staff_id, bar_shift_id) WHERE bar_shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cashboxes_bar_shift_id ON public.cashboxes(bar_shift_id);


-- ── 8) Ledger da gaveta: tipo `bar_sale` + referência ao pagamento ──────────
-- O precedente exato deste DROP+ADD está em cancel_sale.sql (foi assim que
-- `refund` entrou) e em cash_fase1_core.sql (`cash_buy_in`/`cash_out`).
ALTER TABLE public.cashbox_transactions
  ADD COLUMN IF NOT EXISTS bar_payment_id UUID
      REFERENCES public.bar_tab_payments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_cashbox_tx_bar_payment
  ON public.cashbox_transactions(bar_payment_id);

ALTER TABLE public.cashbox_transactions DROP CONSTRAINT IF EXISTS cashbox_transactions_type_check;
ALTER TABLE public.cashbox_transactions ADD CONSTRAINT cashbox_transactions_type_check
  CHECK (type IN ('buy_in','rebuy','addon','prize','supply','sangria','refund','adjustment',
                  'cash_buy_in','cash_out','bar_sale'));


-- ── 9) Crédito do jogador pago no bar ───────────────────────────────────────
-- `credit_transactions.tournament_id` já é anulável; só o CHECK de tipo era
-- fechado. `bar_payment_id` é o que permitirá estornar a perna de crédito num
-- passo futuro (hoje o backend recusa, como o torneio recusa estornar venda
-- paga com crédito).
ALTER TABLE public.credit_transactions
  ADD COLUMN IF NOT EXISTS bar_payment_id UUID
      REFERENCES public.bar_tab_payments(id) ON DELETE SET NULL;
ALTER TABLE public.credit_transactions DROP CONSTRAINT IF EXISTS credit_transactions_type_check;
ALTER TABLE public.credit_transactions ADD CONSTRAINT credit_transactions_type_check
  CHECK (type IN ('credit_granted','credit_used_buyin','credit_used_rebuy','credit_used_addon',
                  'credit_used_bar','prize_deduction','sponsor_payment','credit_cancelled',
                  'credit_refund'));


-- ── 10) Triggers ────────────────────────────────────────────────────────────
-- Em TODOS os inserts feitos por trigger, `organization_id` vai EXPLÍCITO:
-- quando o backend roda sem JWT (service_role, rotina), current_org_id() é
-- NULL e o DEFAULT violaria o NOT NULL (database_migration_saas_triggers_inherit_org.sql).

-- 10.1) Recontagem da comanda. Nunca incrementar: todas as linhas vivem aqui,
--       então recontar é o que se autocura.
CREATE OR REPLACE FUNCTION public.bar_recalc_tab(p_tab uuid)
RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
BEGIN
    UPDATE public.bar_tabs t
       SET subtotal        = i.sub,
           courtesy_amount = i.cort,
           paid_amount     = p.pago,
           total           = GREATEST(i.sub - LEAST(t.discount_amount, i.sub), 0),
           updated_at      = now()
      FROM (
        SELECT COALESCE(SUM(CASE WHEN NOT is_courtesy THEN line_total ELSE 0 END), 0) AS sub,
               COALESCE(SUM(CASE WHEN is_courtesy THEN line_total ELSE 0 END), 0)     AS cort
          FROM public.bar_tab_items
         WHERE tab_id = p_tab AND status <> 'cancelled'
      ) i,
      (
        SELECT COALESCE(SUM(amount), 0) AS pago
          FROM public.bar_tab_payments
         WHERE tab_id = p_tab AND status = 'active'
      ) p
     WHERE t.id = p_tab;
END $fn$;

CREATE OR REPLACE FUNCTION public.bar_touch_tab()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
BEGIN
    PERFORM public.bar_recalc_tab(COALESCE(NEW.tab_id, OLD.tab_id));
    RETURN COALESCE(NEW, OLD);
END $fn$;

DROP TRIGGER IF EXISTS trg_bar_touch_tab_items ON public.bar_tab_items;
CREATE TRIGGER trg_bar_touch_tab_items
    AFTER INSERT OR UPDATE OF status, is_courtesy, quantity, line_total OR DELETE ON public.bar_tab_items
    FOR EACH ROW EXECUTE FUNCTION public.bar_touch_tab();

DROP TRIGGER IF EXISTS trg_bar_touch_tab_payments ON public.bar_tab_payments;
CREATE TRIGGER trg_bar_touch_tab_payments
    AFTER INSERT OR UPDATE OF status, amount OR DELETE ON public.bar_tab_payments
    FOR EACH ROW EXECUTE FUNCTION public.bar_touch_tab();

-- Desconto alterado direto na comanda: refaz o total na mesma instrução.
CREATE OR REPLACE FUNCTION public.bar_tab_discount_total()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
BEGIN
    NEW.total := GREATEST(NEW.subtotal - LEAST(NEW.discount_amount, NEW.subtotal), 0);
    RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_bar_tab_discount_total ON public.bar_tabs;
CREATE TRIGGER trg_bar_tab_discount_total
    BEFORE UPDATE OF discount_amount ON public.bar_tabs
    FOR EACH ROW EXECUTE FUNCTION public.bar_tab_discount_total();


-- 10.2) Número da comanda + herança de org + turno aberto.
CREATE OR REPLACE FUNCTION public.bar_tab_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE v_org uuid;
BEGIN
    -- O UPDATE trava a linha do turno: dois caixas abrindo comanda ao mesmo
    -- tempo recebem números diferentes. Turno fechado não avança (WHERE) e a
    -- comanda não nasce.
    UPDATE public.bar_shifts
       SET last_tab_number = last_tab_number + 1, updated_at = now()
     WHERE id = NEW.bar_shift_id AND status = 'open'
    RETURNING last_tab_number, organization_id INTO NEW.number, v_org;

    IF NEW.number IS NULL THEN
        RAISE EXCEPTION 'REGRA_BAR:turno_nao_aberto';
    END IF;
    IF NEW.organization_id IS NULL THEN
        NEW.organization_id := v_org;
    END IF;
    RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_bar_tab_before_insert ON public.bar_tabs;
CREATE TRIGGER trg_bar_tab_before_insert
    BEFORE INSERT ON public.bar_tabs
    FOR EACH ROW EXECUTE FUNCTION public.bar_tab_before_insert();


-- 10.3) Item: comanda aberta, snapshot do produto, turno e org herdados.
CREATE OR REPLACE FUNCTION public.bar_item_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE
    v_tab public.bar_tabs%ROWTYPE;
    v_prod public.bar_products%ROWTYPE;
BEGIN
    SELECT * INTO v_tab FROM public.bar_tabs WHERE id = NEW.tab_id;
    IF v_tab.id IS NULL THEN
        RAISE EXCEPTION 'REGRA_BAR:comanda_nao_encontrada';
    END IF;
    IF v_tab.status <> 'open' THEN
        RAISE EXCEPTION 'REGRA_BAR:comanda_nao_aberta';
    END IF;

    NEW.bar_shift_id := v_tab.bar_shift_id;
    IF NEW.organization_id IS NULL THEN
        NEW.organization_id := v_tab.organization_id;
    END IF;

    -- Snapshot: o serviço normalmente já manda; o trigger cobre quem não mandou.
    IF NEW.product_name IS NULL OR NEW.unit_price IS NULL THEN
        SELECT * INTO v_prod FROM public.bar_products WHERE id = NEW.product_id;
        IF v_prod.id IS NULL THEN
            RAISE EXCEPTION 'REGRA_BAR:produto_nao_encontrado';
        END IF;
        NEW.product_name := COALESCE(NEW.product_name, v_prod.name);
        NEW.unit_price   := COALESCE(NEW.unit_price, v_prod.price);
        NEW.unit_cost    := COALESCE(NEW.unit_cost, v_prod.cost_price, 0);
    END IF;

    NEW.line_total := round(NEW.unit_price * NEW.quantity, 2);
    RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_bar_item_before_insert ON public.bar_tab_items;
CREATE TRIGGER trg_bar_item_before_insert
    BEFORE INSERT ON public.bar_tab_items
    FOR EACH ROW EXECUTE FUNCTION public.bar_item_before_insert();


-- 10.4) Estoque: a venda baixa, o cancelamento devolve — por trigger, para
--       que o serviço nunca precise "lembrar" do estoque. ON CONFLICT no par
--       (item, kind) torna o re-disparo inofensivo.
CREATE OR REPLACE FUNCTION public.bar_stock_on_item()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE v_track boolean;
BEGIN
    SELECT track_stock INTO v_track FROM public.bar_products WHERE id = NEW.product_id;
    IF NOT COALESCE(v_track, false) THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.status <> 'cancelled' THEN
            INSERT INTO public.bar_stock_movements
                (organization_id, product_id, kind, quantity, unit_cost, tab_item_id, created_by)
            VALUES
                (NEW.organization_id, NEW.product_id, 'sale', -NEW.quantity, NEW.unit_cost, NEW.id, NEW.created_by)
            ON CONFLICT (tab_item_id, kind) WHERE tab_item_id IS NOT NULL DO NOTHING;
        END IF;
    ELSIF TG_OP = 'UPDATE' AND OLD.status <> 'cancelled' AND NEW.status = 'cancelled' THEN
        INSERT INTO public.bar_stock_movements
            (organization_id, product_id, kind, quantity, unit_cost, tab_item_id, created_by)
        VALUES
            (NEW.organization_id, NEW.product_id, 'cancel_restore', NEW.quantity, NEW.unit_cost, NEW.id, NEW.cancelled_by)
        ON CONFLICT (tab_item_id, kind) WHERE tab_item_id IS NOT NULL DO NOTHING;
    END IF;
    RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_bar_stock_on_item ON public.bar_tab_items;
CREATE TRIGGER trg_bar_stock_on_item
    AFTER INSERT OR UPDATE OF status ON public.bar_tab_items
    FOR EACH ROW EXECUTE FUNCTION public.bar_stock_on_item();

CREATE OR REPLACE FUNCTION public.bar_apply_stock_movement()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
BEGIN
    IF NEW.organization_id IS NULL THEN
        SELECT organization_id INTO NEW.organization_id FROM public.bar_products WHERE id = NEW.product_id;
    END IF;
    RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_bar_stock_movement_org ON public.bar_stock_movements;
CREATE TRIGGER trg_bar_stock_movement_org
    BEFORE INSERT ON public.bar_stock_movements
    FOR EACH ROW EXECUTE FUNCTION public.bar_apply_stock_movement();

CREATE OR REPLACE FUNCTION public.bar_apply_stock_qty()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
BEGIN
    -- Atômico no banco (coluna += delta). O padrão "lê saldo → soma → grava"
    -- do supabase-py perde unidades em concorrência.
    UPDATE public.bar_products
       SET stock_qty = stock_qty + NEW.quantity, updated_at = now()
     WHERE id = NEW.product_id;
    RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_bar_apply_stock_qty ON public.bar_stock_movements;
CREATE TRIGGER trg_bar_apply_stock_qty
    AFTER INSERT ON public.bar_stock_movements
    FOR EACH ROW EXECUTE FUNCTION public.bar_apply_stock_qty();


-- 10.5) Pagamento: comanda aberta, saldo, herança, e a gaveta do operador.
--       Uma função só (e não duas) para não depender da ordem alfabética dos
--       triggers BEFORE.
CREATE OR REPLACE FUNCTION public.bar_payment_before_insert()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE
    v_tab  public.bar_tabs%ROWTYPE;
    v_pago numeric;
    v_cashbox_id uuid;
BEGIN
    -- FOR UPDATE serializa dois operadores quitando o mesmo saldo: o segundo
    -- só entra depois que o primeiro gravou, e aí a soma recusa.
    SELECT * INTO v_tab FROM public.bar_tabs WHERE id = NEW.tab_id FOR UPDATE;
    IF v_tab.id IS NULL THEN
        RAISE EXCEPTION 'REGRA_BAR:comanda_nao_encontrada';
    END IF;
    IF v_tab.status <> 'open' THEN
        RAISE EXCEPTION 'REGRA_BAR:comanda_nao_aberta';
    END IF;

    -- Soma direto das linhas (não do campo recontado): dentro de um INSERT de
    -- várias pernas, o AFTER da perna anterior ainda não rodou, mas a linha
    -- dela já é visível aqui.
    SELECT COALESCE(SUM(amount), 0) INTO v_pago
      FROM public.bar_tab_payments
     WHERE tab_id = NEW.tab_id AND status = 'active';
    IF v_pago + NEW.amount > v_tab.total + 0.005 THEN
        RAISE EXCEPTION 'REGRA_BAR:pagamento_acima_do_saldo';
    END IF;

    NEW.bar_shift_id := v_tab.bar_shift_id;
    IF NEW.organization_id IS NULL THEN
        NEW.organization_id := v_tab.organization_id;
    END IF;

    -- A gaveta: só para dinheiro real, e só se o serviço não a informou.
    IF NEW.payment_source = 'cash' AND NEW.cashbox_id IS NULL AND NEW.created_by IS NOT NULL THEN
        SELECT c.id INTO v_cashbox_id
          FROM public.cashboxes c
          JOIN public.staff s ON s.id = c.staff_id
         WHERE s.auth_user_id = NEW.created_by
           AND c.bar_shift_id = v_tab.bar_shift_id
           AND c.status = 'open';
        IF v_cashbox_id IS NOT NULL THEN
            NEW.cashbox_id := v_cashbox_id;
        END IF;
    END IF;
    RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_bar_payment_before_insert ON public.bar_tab_payments;
CREATE TRIGGER trg_bar_payment_before_insert
    BEFORE INSERT ON public.bar_tab_payments
    FOR EACH ROW EXECUTE FUNCTION public.bar_payment_before_insert();


-- 10.6) Espelhar na gaveta (clone de mirror_cash_transaction_to_cashbox).
--       `update_cashbox_balance_on_transaction` soma o signed_amount de
--       qualquer tipo — reaproveitado sem uma linha de mudança.
CREATE OR REPLACE FUNCTION public.mirror_bar_payment_to_cashbox()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE v_session_id uuid;
BEGIN
    IF NEW.cashbox_id IS NULL OR NEW.payment_source <> 'cash' OR NEW.status <> 'active' THEN
        RETURN NEW;
    END IF;

    SELECT current_session_id INTO v_session_id
      FROM public.cashboxes WHERE id = NEW.cashbox_id;

    INSERT INTO public.cashbox_transactions
        (cashbox_id, session_id, type, amount, signed_amount,
         bar_payment_id, performed_by, notes, organization_id)
    VALUES
        (NEW.cashbox_id, v_session_id, 'bar_sale', NEW.amount, NEW.amount,
         NEW.id, NEW.created_by, NEW.notes, NEW.organization_id);
    RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_mirror_bar_payment ON public.bar_tab_payments;
CREATE TRIGGER trg_mirror_bar_payment
    AFTER INSERT ON public.bar_tab_payments
    FOR EACH ROW EXECUTE FUNCTION public.mirror_bar_payment_to_cashbox();


-- 10.7) Entitlement nas tabelas-raiz (função criada na fase 0).
DROP TRIGGER IF EXISTS trg_enforce_bar_module_shifts ON public.bar_shifts;
CREATE TRIGGER trg_enforce_bar_module_shifts
    BEFORE INSERT ON public.bar_shifts
    FOR EACH ROW EXECUTE FUNCTION public.enforce_bar_module();

DROP TRIGGER IF EXISTS trg_enforce_bar_module_products ON public.bar_products;
CREATE TRIGGER trg_enforce_bar_module_products
    BEFORE INSERT ON public.bar_products
    FOR EACH ROW EXECUTE FUNCTION public.enforce_bar_module();


-- 10.8) Turno com movimento não some (espelho do dia de cash).
CREATE OR REPLACE FUNCTION public.impedir_exclusao_de_turno_com_movimento()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_temp AS $fn$
DECLARE v_qtd int;
BEGIN
    SELECT count(*) INTO v_qtd FROM public.bar_tabs WHERE bar_shift_id = OLD.id;
    IF v_qtd > 0 THEN
        RAISE EXCEPTION
          'MOVIMENTO_FINANCEIRO_IMPEDE_EXCLUSAO: O turno tem % comanda(s).', v_qtd;
    END IF;
    RETURN OLD;
END $fn$;

DROP TRIGGER IF EXISTS trg_impedir_exclusao_turno_bar ON public.bar_shifts;
CREATE TRIGGER trg_impedir_exclusao_turno_bar
    BEFORE DELETE ON public.bar_shifts
    FOR EACH ROW EXECUTE FUNCTION public.impedir_exclusao_de_turno_com_movimento();


-- 10.9) Categorias padrão no idioma da org, ao LIGAR o módulo. Vive em
--       org_modules (não em organizations) porque o bar é contratado depois —
--       e o idioma da org já existe nesse momento (app_settings).
CREATE OR REPLACE FUNCTION public.bar_categorias_padrao(p_language text DEFAULT 'pt-BR')
RETURNS TABLE(nome text, ordem int)
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $fn$
  WITH escolhido AS (
    SELECT CASE WHEN COALESCE(NULLIF(p_language, ''), 'pt-BR') IN ('pt-BR','en-US','es-ES')
                THEN COALESCE(NULLIF(p_language, ''), 'pt-BR')
                ELSE 'pt-BR' END AS idioma
  )
  SELECT t.nome, t.ordem
    FROM (VALUES
      ('es-ES', 'Bebidas',   1), ('es-ES', 'Cervezas', 2), ('es-ES', 'Tragos',  3),
      ('es-ES', 'Comidas',   4), ('es-ES', 'Picadas',  5),
      ('en-US', 'Drinks',    1), ('en-US', 'Beers',    2), ('en-US', 'Cocktails', 3),
      ('en-US', 'Food',      4), ('en-US', 'Snacks',   5),
      ('pt-BR', 'Bebidas',   1), ('pt-BR', 'Cervejas', 2), ('pt-BR', 'Drinks',  3),
      ('pt-BR', 'Comidas',   4), ('pt-BR', 'Petiscos', 5)
    ) AS t(idioma, nome, ordem), escolhido e
   WHERE t.idioma = e.idioma;
$fn$;

CREATE OR REPLACE FUNCTION public.bar_seed_on_module()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_idioma text;
BEGIN
    IF NEW.module <> 'bar' OR NOT NEW.enabled THEN
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM public.bar_product_categories WHERE organization_id = NEW.organization_id) THEN
        RETURN NEW;
    END IF;
    SELECT language INTO v_idioma FROM public.app_settings
     WHERE organization_id = NEW.organization_id LIMIT 1;

    INSERT INTO public.bar_product_categories (organization_id, name, sort_order)
    SELECT NEW.organization_id, c.nome, c.ordem
      FROM public.bar_categorias_padrao(COALESCE(v_idioma, 'pt-BR')) c;
    RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_bar_seed_on_module ON public.org_modules;
CREATE TRIGGER trg_bar_seed_on_module
    AFTER INSERT OR UPDATE OF enabled ON public.org_modules
    FOR EACH ROW EXECUTE FUNCTION public.bar_seed_on_module();

-- Backfill para quem já tiver o módulo ligado quando este arquivo rodar.
INSERT INTO public.bar_product_categories (organization_id, name, sort_order)
SELECT m.organization_id, c.nome, c.ordem
  FROM public.org_modules m
  LEFT JOIN public.app_settings s ON s.organization_id = m.organization_id
  CROSS JOIN LATERAL public.bar_categorias_padrao(COALESCE(s.language, 'pt-BR')) c
 WHERE m.module = 'bar' AND m.enabled
   AND NOT EXISTS (SELECT 1 FROM public.bar_product_categories b WHERE b.organization_id = m.organization_id);


-- 10.10) updated_at
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['bar_shifts','bar_product_categories','bar_products',
                           'bar_tabs','bar_tab_items','bar_tab_payments'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_updated_at ON public.%I', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column()', t, t);
  END LOOP;
END $$;


-- ── 11) RLS, padrão InitPlan ────────────────────────────────────────────────
-- A subquery é obrigatória: vira InitPlan, avaliado 1x por statement. A forma
-- `can_access_org(organization_id)` foi medida em 340x o baseline
-- (database_migration_saas_rls_performance.sql).
DO $$
DECLARE t text;
  tabelas text[] := ARRAY[
    'bar_shifts','bar_product_categories','bar_products','bar_stock_movements',
    'bar_tabs','bar_tab_items','bar_tab_payments'
  ];
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


-- ── 12) Realtime: só o que uma tela ao vivo observa ─────────────────────────
-- Mesmo bloco de database_migration_realtime_operacao.sql. Produtos e
-- categorias ficam de fora (cadastro; muda raramente).
DO $publica$
DECLARE
  t text;
  tabelas text[] := ARRAY['bar_shifts','bar_tabs','bar_tab_items','bar_tab_payments'];
BEGIN
  FOREACH t IN ARRAY tabelas LOOP
    IF EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      RAISE NOTICE 'ja publicada: %', t;
      CONTINUE;
    END IF;
    EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    RAISE NOTICE 'publicada: %', t;
  END LOOP;
END $publica$;


-- ── 13) Conferência ─────────────────────────────────────────────────────────
-- Nenhuma gaveta sem âncora ou com duas (deve ser 0):
--   SELECT count(*) FROM public.cashboxes WHERE num_nonnulls(stage_id, cash_day_id, bar_shift_id) <> 1;
--
-- Toda tabela bar_% tem RLS (deve ser 0):
--   SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public' AND relname LIKE 'bar\_%' AND relkind = 'r' AND NOT relrowsecurity;
--
-- O ledger aceita bar_sale:
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'cashbox_transactions_type_check';
--
-- InitPlan na policy (como `authenticated`):
--   EXPLAIN SELECT * FROM public.bar_tabs;   -- Filter: (organization_id = (InitPlan 1).col1 OR ...)
