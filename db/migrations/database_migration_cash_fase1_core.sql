-- ============================================================================
-- CASH GAME — Fase 1: operação de mesa
-- ----------------------------------------------------------------------------
-- ORDEM: aplicar DEPOIS de database_migration_cash_fase0_modulos.sql.
--
-- A UNIDADE DE OPERAÇÃO É O DIA, não a etapa. Torneio se organiza em etapas
-- (circuitos com começo e fim); cash game abre, roda a noite, conta e fecha —
-- todo dia. É o recorte que o clube usa para saber quanto faturou ontem, qual
-- dia da semana rende mais e se vale abrir na terça.
--
-- `cash_days.business_date` é a data ESCOLHIDA na abertura, nunca now()::date.
-- Uma noite que começa 21h e termina 05h é UM dia. Com a data do relógio, o
-- faturamento da madrugada cairia no dia seguinte e o relatório de melhores
-- dias ficaria torto justamente na parte que interessa.
--
-- COMO O DINHEIRO ANDA (a decisão que evita dupla contagem):
--   O jogador troca dinheiro por fichas ao sentar (ENTRA na gaveta) e fichas
--   por dinheiro ao levantar (SAI da gaveta). O rake sai do POTE, em fichas —
--   ele já está na gaveta, como a diferença entre buy-ins e cash-outs.
--   Portanto rake e jackpot NÃO são movimento de caixa: `cash_rake_entries`
--   alimenta o faturamento, nunca o saldo. Lançá-los na gaveta contaria o
--   mesmo dinheiro duas vezes.
--
-- POR QUE TABELA PRÓPRIA E NÃO `transactions`:
--   `transactions.tournament_id` é NOT NULL, e os quatro triggers de dinheiro
--   (update_stage_cash_on_transaction, resolve_transaction_cashbox,
--   mirror_transaction_to_cashbox, loyalty_earn_on_transaction) derivam a etapa
--   dele. Uma linha de cash ali entraria no prize pool, na fidelidade, no DRE
--   de torneio e na view player_statistics — em silêncio. Com tabela separada,
--   nenhum desses triggers dispara: o torneio fica intacto por construção.
-- ============================================================================

DO $$ BEGIN
  IF to_regclass('public.org_modules') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_cash_fase0_modulos.sql';
  END IF;
END $$;


-- ── 1) Dia de operação ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cash_days (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID NOT NULL DEFAULT public.current_org_id()
                     REFERENCES public.organizations(id) ON DELETE RESTRICT,
    business_date    DATE NOT NULL,
    label            VARCHAR(160),
    status           VARCHAR(16) NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','closed')),
    opened_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    opened_by        UUID REFERENCES auth.users(id),
    closed_at        TIMESTAMPTZ,
    closed_by        UUID REFERENCES auth.users(id),
    -- Congelados no fechamento. NULL enquanto aberto: a leitura ao vivo agrega
    -- as transações, e gravar um total parcial só criaria dois números
    -- divergentes para a mesma pergunta.
    total_buy_ins    DECIMAL(12,2),
    total_cash_outs  DECIMAL(12,2),
    total_rake       DECIMAL(12,2),
    total_jackpot    DECIMAL(12,2),
    variance         DECIMAL(12,2),
    tables_count     INT,
    players_count    INT,
    notes            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (organization_id, business_date)
);

CREATE INDEX IF NOT EXISTS idx_cash_days_organization_id ON public.cash_days(organization_id);
CREATE INDEX IF NOT EXISTS idx_cash_days_date ON public.cash_days(organization_id, business_date DESC);

-- UM dia aberto por vez. É a trava que impede dois operadores abrirem a mesma
-- noite duas vezes e o dinheiro terminar partido em dois fechamentos que não
-- fecham nenhum dos dois.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_day_aberto_por_org
    ON public.cash_days(organization_id) WHERE status = 'open';

COMMENT ON COLUMN public.cash_days.business_date IS
  'Data OPERACIONAL, escolhida na abertura. Nunca now()::date: a noite que atravessa a meia-noite é um dia só.';
COMMENT ON COLUMN public.cash_days.variance IS
  '(buy_ins - cash_outs) - (rake + jackpot). Diferente de zero é normal enquanto o jackpot está retido em fichas; muito diferente é erro de contagem.';


-- ── 2) Modalidades (stakes) — catálogo reutilizável da organização ──────────
CREATE TABLE IF NOT EXISTS public.cash_game_types (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID NOT NULL DEFAULT public.current_org_id()
                     REFERENCES public.organizations(id) ON DELETE CASCADE,
    name             VARCHAR(120) NOT NULL,
    game_variant     VARCHAR(20) NOT NULL DEFAULT 'nlh'
                     CHECK (game_variant IN ('nlh','plo','plo5','loh','mixed','other')),
    small_blind      DECIMAL(10,2) NOT NULL CHECK (small_blind > 0),
    big_blind        DECIMAL(10,2) NOT NULL CHECK (big_blind >= small_blind),
    ante             DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (ante >= 0),
    straddle_allowed BOOLEAN NOT NULL DEFAULT false,
    min_buy_in       DECIMAL(10,2) NOT NULL CHECK (min_buy_in > 0),
    max_buy_in       DECIMAL(10,2),
    default_seats    SMALLINT NOT NULL DEFAULT 9 CHECK (default_seats BETWEEN 2 AND 10),
    rake_percent     DECIMAL(5,2) NOT NULL DEFAULT 5.00 CHECK (rake_percent BETWEEN 0 AND 100),
    rake_cap         DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (rake_cap >= 0),
    jackpot_per_pot  DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (jackpot_per_pot >= 0),
    active           BOOLEAN NOT NULL DEFAULT true,
    sort_order       INT NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (max_buy_in IS NULL OR max_buy_in >= min_buy_in)
);

CREATE INDEX IF NOT EXISTS idx_cash_game_types_organization_id
    ON public.cash_game_types(organization_id);

COMMENT ON COLUMN public.cash_game_types.max_buy_in IS 'NULL = sem teto.';
COMMENT ON COLUMN public.cash_game_types.rake_cap IS
  'Teto de rake por pote. 0 = sem teto. Informativo para a mesa: o rake real é o CONTADO no fechamento.';


-- ── 3) Mesa aberta no dia ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cash_tables (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID NOT NULL DEFAULT public.current_org_id()
                     REFERENCES public.organizations(id) ON DELETE RESTRICT,
    cash_day_id      UUID NOT NULL REFERENCES public.cash_days(id) ON DELETE RESTRICT,
    game_type_id     UUID REFERENCES public.cash_game_types(id) ON DELETE SET NULL,
    table_number     SMALLINT NOT NULL CHECK (table_number > 0),
    seats            SMALLINT NOT NULL CHECK (seats BETWEEN 2 AND 10),
    -- SNAPSHOT da configuração no momento da abertura. Não trocar por leitura
    -- pela FK: mudar o rake da modalidade amanhã reescreveria a apuração das
    -- mesas de ontem, e o fechamento assinado deixaria de bater.
    game_variant     VARCHAR(20)   NOT NULL,
    small_blind      DECIMAL(10,2) NOT NULL,
    big_blind        DECIMAL(10,2) NOT NULL,
    ante             DECIMAL(10,2) NOT NULL DEFAULT 0,
    min_buy_in       DECIMAL(10,2) NOT NULL,
    max_buy_in       DECIMAL(10,2),
    rake_percent     DECIMAL(5,2)  NOT NULL DEFAULT 0,
    rake_cap         DECIMAL(10,2) NOT NULL DEFAULT 0,
    jackpot_per_pot  DECIMAL(10,2) NOT NULL DEFAULT 0,
    status           VARCHAR(16) NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','paused','closed')),
    opened_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    opened_by        UUID REFERENCES auth.users(id),
    closed_at        TIMESTAMPTZ,
    closed_by        UUID REFERENCES auth.users(id),
    rake_counted     DECIMAL(12,2),
    jackpot_counted  DECIMAL(12,2),
    notes            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cash_tables_organization_id ON public.cash_tables(organization_id);
CREATE INDEX IF NOT EXISTS idx_cash_tables_day    ON public.cash_tables(cash_day_id);
CREATE INDEX IF NOT EXISTS idx_cash_tables_status ON public.cash_tables(status);

-- O número identifica a mesa NO SALÃO. Duas mesas 3 abertas ao mesmo tempo
-- fariam o operador levar fichas para a errada. Fechada libera o número.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_table_numero_aberta
    ON public.cash_tables(cash_day_id, table_number) WHERE status <> 'closed';


-- ── 4) Assentos ─────────────────────────────────────────────────────────────
-- Tabela PRÓPRIA, e não derivada de cash_player_sessions, porque a fila precisa
-- RESERVAR a cadeira no momento da chamada — antes de o jogador chegar ao caixa
-- e pagar o buy-in. Sem uma linha para reservar, dois operadores chamam gente
-- diferente para o mesmo lugar e alguém é levantado na frente da mesa.
CREATE TABLE IF NOT EXISTS public.cash_seats (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id    UUID NOT NULL DEFAULT public.current_org_id()
                       REFERENCES public.organizations(id) ON DELETE CASCADE,
    table_id           UUID NOT NULL REFERENCES public.cash_tables(id) ON DELETE CASCADE,
    seat_number        SMALLINT NOT NULL CHECK (seat_number > 0),
    status             VARCHAR(16) NOT NULL DEFAULT 'free'
                       CHECK (status IN ('free','reserved','occupied','blocked')),
    player_session_id  UUID,
    reserved_for       UUID REFERENCES public.players(id) ON DELETE SET NULL,
    reserved_until     TIMESTAMPTZ,
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- ESTA é a trava anti-colisão. Dois caixas atendendo com polling de 5s têm
    -- janela de sobra para sentar duas pessoas no mesmo lugar; o banco recusa e
    -- o service traduz em `assento_ocupado`.
    UNIQUE (table_id, seat_number)
);

CREATE INDEX IF NOT EXISTS idx_cash_seats_organization_id ON public.cash_seats(organization_id);
CREATE INDEX IF NOT EXISTS idx_cash_seats_table ON public.cash_seats(table_id);


-- ── 5) Sessão do jogador na mesa ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cash_player_sessions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID NOT NULL DEFAULT public.current_org_id()
                     REFERENCES public.organizations(id) ON DELETE RESTRICT,
    cash_day_id      UUID NOT NULL REFERENCES public.cash_days(id) ON DELETE RESTRICT,
    table_id         UUID NOT NULL REFERENCES public.cash_tables(id) ON DELETE RESTRICT,
    player_id        UUID NOT NULL REFERENCES public.players(id) ON DELETE RESTRICT,
    seat_number      SMALLINT NOT NULL CHECK (seat_number > 0),
    status           VARCHAR(16) NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','left','moved')),
    started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at         TIMESTAMPTZ,
    total_buy_in     DECIMAL(12,2) NOT NULL DEFAULT 0,
    total_cash_out   DECIMAL(12,2) NOT NULL DEFAULT 0,
    result           DECIMAL(12,2) NOT NULL DEFAULT 0,
    -- Encadeia a troca de mesa: a sessão antiga aponta para a nova, e o
    -- resultado da noite do jogador soma a corrente inteira.
    moved_to_id      UUID REFERENCES public.cash_player_sessions(id) ON DELETE SET NULL,
    notes            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cash_ps_organization_id ON public.cash_player_sessions(organization_id);
CREATE INDEX IF NOT EXISTS idx_cash_ps_day    ON public.cash_player_sessions(cash_day_id);
CREATE INDEX IF NOT EXISTS idx_cash_ps_table  ON public.cash_player_sessions(table_id);
CREATE INDEX IF NOT EXISTS idx_cash_ps_player ON public.cash_player_sessions(player_id);

-- O mesmo jogador não pode estar sentado em duas mesas ao mesmo tempo: as duas
-- sessões acumulariam buy-in em paralelo e o resultado da noite dele viraria
-- ficção.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_ps_jogador_ativo
    ON public.cash_player_sessions(cash_day_id, player_id) WHERE status = 'active';

-- FK do assento só agora, quando a tabela de sessões existe.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cash_seats_player_session_fk'
  ) THEN
    ALTER TABLE public.cash_seats
      ADD CONSTRAINT cash_seats_player_session_fk
      FOREIGN KEY (player_session_id)
      REFERENCES public.cash_player_sessions(id) ON DELETE SET NULL;
  END IF;
END $$;


-- ── 6) Dinheiro do cash ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.cash_transactions (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id    UUID NOT NULL DEFAULT public.current_org_id()
                       REFERENCES public.organizations(id) ON DELETE RESTRICT,
    cash_day_id        UUID NOT NULL REFERENCES public.cash_days(id) ON DELETE RESTRICT,
    table_id           UUID REFERENCES public.cash_tables(id) ON DELETE SET NULL,
    player_session_id  UUID REFERENCES public.cash_player_sessions(id) ON DELETE SET NULL,
    player_id          UUID REFERENCES public.players(id) ON DELETE RESTRICT,
    type               VARCHAR(20) NOT NULL
                       CHECK (type IN ('buy_in','rebuy','cash_out','jackpot_payout')),
    -- SEMPRE positivo: a direção vem do `type`, igual ao ledger do caixa.
    -- Valor com sinal é a origem clássica de somar quando era para subtrair.
    amount             DECIMAL(10,2) NOT NULL CHECK (amount > 0),
    payment_method     VARCHAR(50),
    payment_source     VARCHAR(50),
    cashbox_id         UUID REFERENCES public.cashboxes(id) ON DELETE SET NULL,
    -- Idempotência desde a Fase 1, mesmo sendo tudo online: duplo clique e
    -- retry acontecem com rede boa. E é o que deixa ligar a fila offline
    -- depois sem migração nova.
    client_mutation_id TEXT,
    status             VARCHAR(16) NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active','cancelling','cancelled')),
    cancelled_at       TIMESTAMPTZ,
    cancelled_by       UUID REFERENCES auth.users(id),
    cancel_reason      TEXT,
    cancel_steps       TEXT[] NOT NULL DEFAULT '{}',
    notes              TEXT,
    created_by         UUID REFERENCES auth.users(id),
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cash_tx_organization_id ON public.cash_transactions(organization_id);
CREATE INDEX IF NOT EXISTS idx_cash_tx_day     ON public.cash_transactions(cash_day_id);
CREATE INDEX IF NOT EXISTS idx_cash_tx_table   ON public.cash_transactions(table_id);
CREATE INDEX IF NOT EXISTS idx_cash_tx_ps      ON public.cash_transactions(player_session_id);
CREATE INDEX IF NOT EXISTS idx_cash_tx_created ON public.cash_transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cash_tx_cancelled
    ON public.cash_transactions(id) WHERE status <> 'active';
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_tx_client_mutation
    ON public.cash_transactions(organization_id, client_mutation_id)
    WHERE client_mutation_id IS NOT NULL;


-- ── 7) Apuração de rake pela caixa da mesa ──────────────────────────────────
-- É A FONTE do faturamento de cash. O sistema não vê mão a mão: o sangeur corta
-- o rake do pote em fichas e o dinheiro é CONTADO — parcial ao longo da noite,
-- e uma vez no fechamento da mesa.
CREATE TABLE IF NOT EXISTS public.cash_rake_entries (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID NOT NULL DEFAULT public.current_org_id()
                     REFERENCES public.organizations(id) ON DELETE RESTRICT,
    cash_day_id      UUID NOT NULL REFERENCES public.cash_days(id) ON DELETE RESTRICT,
    table_id         UUID NOT NULL REFERENCES public.cash_tables(id) ON DELETE RESTRICT,
    kind             VARCHAR(12) NOT NULL DEFAULT 'partial'
                     CHECK (kind IN ('partial','closing','adjustment')),
    rake_amount      DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (rake_amount >= 0),
    jackpot_amount   DECIMAL(10,2) NOT NULL DEFAULT 0 CHECK (jackpot_amount >= 0),
    counted_by       UUID REFERENCES auth.users(id),
    counted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    notes            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cash_rake_organization_id ON public.cash_rake_entries(organization_id);
CREATE INDEX IF NOT EXISTS idx_cash_rake_day   ON public.cash_rake_entries(cash_day_id);
CREATE INDEX IF NOT EXISTS idx_cash_rake_table ON public.cash_rake_entries(table_id);

-- Uma única apuração de FECHAMENTO por mesa: ela é o documento que encerra a
-- contagem daquela mesa.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_rake_fechamento
    ON public.cash_rake_entries(table_id) WHERE kind = 'closing';


-- ── 8) O caixa do operador passa a servir aos dois módulos ──────────────────
-- `cashboxes` era ancorado só na etapa. No cash não há etapa: a âncora é o DIA.
-- Em vez de duplicar as ~930 linhas de cashbox_service.py, a âncora vira
-- polimórfica — exatamente UMA das duas.
--
-- Isso é um ganho, não um remendo: no cash o caixa do operador passa a ser POR
-- DIA, então abertura, fechamento e conferência (cashbox_sessions, com
-- esperado × contado × diferença) já saem no recorte diário que o cliente
-- pediu, sem nenhum código novo.
ALTER TABLE public.cashboxes ALTER COLUMN stage_id DROP NOT NULL;
ALTER TABLE public.cashboxes
  ADD COLUMN IF NOT EXISTS cash_day_id UUID REFERENCES public.cash_days(id) ON DELETE CASCADE;

ALTER TABLE public.cashboxes DROP CONSTRAINT IF EXISTS cashboxes_staff_id_stage_id_key;
ALTER TABLE public.cashboxes DROP CONSTRAINT IF EXISTS cashboxes_ancora_unica;
ALTER TABLE public.cashboxes ADD CONSTRAINT cashboxes_ancora_unica
  CHECK (num_nonnulls(stage_id, cash_day_id) = 1);

CREATE UNIQUE INDEX IF NOT EXISTS uq_cashbox_staff_stage
  ON public.cashboxes(staff_id, stage_id)    WHERE stage_id    IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_cashbox_staff_cash_day
  ON public.cashboxes(staff_id, cash_day_id) WHERE cash_day_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cashboxes_cash_day_id ON public.cashboxes(cash_day_id);

COMMENT ON CONSTRAINT cashboxes_ancora_unica ON public.cashboxes IS
  'O caixa pertence a UMA etapa (torneio) ou a UM dia (cash game), nunca aos dois nem a nenhum.';


-- ── 9) O ledger do caixa aprende dois movimentos novos ──────────────────────
-- Nome PRÓPRIO, e não reuso de 'buy_in'/'prize': get_summary,
-- _compute_session_report, o Financeiro e o RelatorioTorneio agregam por
-- LITERAL de tipo. Reusar misturaria receita de torneio e de cash em toda tela
-- existente, sem forma de separar depois.
-- (O DROP+ADD do CHECK segue o precedente de database_migration_cancel_sale.sql.)
ALTER TABLE public.cashbox_transactions
  ADD COLUMN IF NOT EXISTS cash_transaction_id UUID
      REFERENCES public.cash_transactions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_cashbox_tx_cash_tx
  ON public.cashbox_transactions(cash_transaction_id);

ALTER TABLE public.cashbox_transactions DROP CONSTRAINT IF EXISTS cashbox_transactions_type_check;
ALTER TABLE public.cashbox_transactions ADD CONSTRAINT cashbox_transactions_type_check
  CHECK (type IN ('buy_in','rebuy','addon','prize','supply','sangria','refund','adjustment',
                  'cash_buy_in','cash_out'));

COMMENT ON COLUMN public.cashbox_transactions.type IS
  'buy_in/rebuy/addon/supply/cash_buy_in = entrada; prize/sangria/refund/cash_out = saída; adjustment = diferença de contagem do fechamento. '
  'cash_buy_in/cash_out = cash game (a compra e a devolução de fichas). Rake e jackpot de cash NÃO aparecem aqui: saem do pote, em fichas, e já estão na gaveta como a diferença entre os dois.';


-- ── 10) Triggers ────────────────────────────────────────────────────────────

-- 10.1) Abrir a mesa já cria os assentos. Sem isso a tela teria que criá-los
--       numa segunda chamada, e uma falha no meio deixaria mesa sem cadeira.
CREATE OR REPLACE FUNCTION public.cash_seed_seats()
RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
BEGIN
    INSERT INTO public.cash_seats (organization_id, table_id, seat_number, status)
    SELECT NEW.organization_id, NEW.id, n, 'free'
      FROM generate_series(1, NEW.seats) AS n
    ON CONFLICT (table_id, seat_number) DO NOTHING;
    RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_cash_seed_seats ON public.cash_tables;
CREATE TRIGGER trg_cash_seed_seats
    AFTER INSERT ON public.cash_tables
    FOR EACH ROW EXECUTE FUNCTION public.cash_seed_seats();


-- 10.2) A sessão do jogador acompanha o dinheiro dele.
--       Canceladas ficam de fora: o dinheiro voltou para a mão do jogador.
CREATE OR REPLACE FUNCTION public.cash_touch_player_session()
RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
DECLARE
    v_ps UUID := COALESCE(NEW.player_session_id, OLD.player_session_id);
BEGIN
    IF v_ps IS NULL THEN
        RETURN COALESCE(NEW, OLD);
    END IF;

    UPDATE public.cash_player_sessions ps
       SET total_buy_in = COALESCE(t.entradas, 0),
           total_cash_out = COALESCE(t.saidas, 0),
           result = COALESCE(t.saidas, 0) - COALESCE(t.entradas, 0),
           updated_at = now()
      FROM (
        SELECT
          SUM(CASE WHEN type IN ('buy_in','rebuy') THEN amount ELSE 0 END) AS entradas,
          SUM(CASE WHEN type = 'cash_out'          THEN amount ELSE 0 END) AS saidas
          FROM public.cash_transactions
         WHERE player_session_id = v_ps AND COALESCE(status,'active') = 'active'
      ) t
     WHERE ps.id = v_ps;

    RETURN COALESCE(NEW, OLD);
END $fn$;

DROP TRIGGER IF EXISTS trg_cash_touch_player_session ON public.cash_transactions;
CREATE TRIGGER trg_cash_touch_player_session
    AFTER INSERT OR UPDATE OR DELETE ON public.cash_transactions
    FOR EACH ROW EXECUTE FUNCTION public.cash_touch_player_session();


-- 10.3) Descobrir o caixa do operador (espelho de resolve_transaction_cashbox,
--       trocando "etapa do torneio" por "dia de cash").
CREATE OR REPLACE FUNCTION public.resolve_cash_transaction_cashbox()
RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
DECLARE
    v_cashbox_id UUID;
BEGIN
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
END $fn$;

DROP TRIGGER IF EXISTS trg_resolve_cash_tx_cashbox ON public.cash_transactions;
CREATE TRIGGER trg_resolve_cash_tx_cashbox
    BEFORE INSERT ON public.cash_transactions
    FOR EACH ROW EXECUTE FUNCTION public.resolve_cash_transaction_cashbox();


-- 10.4) Espelhar na gaveta. `organization_id` vai EXPLÍCITO: quando o backend
--       roda sem JWT (service_role, /sync/batch, rotina), current_org_id() é
--       NULL e o DEFAULT violaria o NOT NULL — a lição de
--       database_migration_saas_triggers_inherit_org.sql.
CREATE OR REPLACE FUNCTION public.mirror_cash_transaction_to_cashbox()
RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
DECLARE
    v_session_id UUID;
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

    SELECT current_session_id INTO v_session_id
      FROM public.cashboxes WHERE id = NEW.cashbox_id;

    INSERT INTO public.cashbox_transactions
        (cashbox_id, session_id, type, amount, signed_amount,
         cash_transaction_id, performed_by, notes, organization_id)
    VALUES
        (NEW.cashbox_id, v_session_id, v_type, NEW.amount, v_signed,
         NEW.id, NEW.created_by, NEW.notes, NEW.organization_id);

    RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_mirror_cash_tx ON public.cash_transactions;
CREATE TRIGGER trg_mirror_cash_tx
    AFTER INSERT ON public.cash_transactions
    FOR EACH ROW EXECUTE FUNCTION public.mirror_cash_transaction_to_cashbox();


-- 10.5) Limites de plano. O prefixo PLANO_LIMITE_ faz o _plan_limit_detail() do
--       main.py devolver 409 com frase amigável, sem tocar em nenhum service.
CREATE OR REPLACE FUNCTION public.enforce_cash_module()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_org uuid;
BEGIN
    v_org := COALESCE(NEW.organization_id, current_org_id());
    IF v_org IS NULL THEN RETURN NEW; END IF;
    IF NOT public.org_has_module(v_org, 'cash') THEN
        RAISE EXCEPTION 'PLANO_LIMITE_MODULO_CASH: O módulo de cash game não está contratado.';
    END IF;
    RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_enforce_cash_module ON public.cash_days;
CREATE TRIGGER trg_enforce_cash_module
    BEFORE INSERT ON public.cash_days
    FOR EACH ROW EXECUTE FUNCTION public.enforce_cash_module();


CREATE OR REPLACE FUNCTION public.enforce_cash_table_limit()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_org uuid; v_lim int; v_cnt int;
BEGIN
    v_org := COALESCE(NEW.organization_id, current_org_id());
    IF v_org IS NULL THEN RETURN NEW; END IF;

    v_lim := public.org_limit(v_org, 'cash_tables');
    IF v_lim IS NULL THEN RETURN NEW; END IF;   -- NULL = ilimitado

    -- Conta MESAS ABERTAS AO MESMO TEMPO: é a métrica do tamanho da operação.
    -- Mesas por mês penalizaria o clube que abre e fecha a mesma mesa toda
    -- noite, que é o comportamento normal.
    SELECT count(*) INTO v_cnt
      FROM public.cash_tables
     WHERE organization_id = v_org AND status <> 'closed';

    IF v_cnt >= v_lim THEN
        RAISE EXCEPTION
          'PLANO_LIMITE_MESAS_CASH: O plano atual permite % mesa(s) de cash abertas ao mesmo tempo.', v_lim;
    END IF;
    RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_enforce_cash_table_limit ON public.cash_tables;
CREATE TRIGGER trg_enforce_cash_table_limit
    BEFORE INSERT ON public.cash_tables
    FOR EACH ROW EXECUTE FUNCTION public.enforce_cash_table_limit();


-- 10.6) Dia com movimento não some. Espelho de
--       impedir_exclusao_de_etapa_com_movimento: apagar um dia levaria junto o
--       faturamento já conferido e assinado.
CREATE OR REPLACE FUNCTION public.impedir_exclusao_de_dia_de_cash_com_movimento()
RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
DECLARE v_qtd int;
BEGIN
    SELECT count(*) INTO v_qtd FROM public.cash_transactions WHERE cash_day_id = OLD.id;
    IF v_qtd > 0 THEN
        RAISE EXCEPTION
          'MOVIMENTO_FINANCEIRO_IMPEDE_EXCLUSAO: O dia tem % movimento(s) de caixa.', v_qtd;
    END IF;
    RETURN OLD;
END $fn$;

DROP TRIGGER IF EXISTS trg_impedir_exclusao_dia_cash ON public.cash_days;
CREATE TRIGGER trg_impedir_exclusao_dia_cash
    BEFORE DELETE ON public.cash_days
    FOR EACH ROW EXECUTE FUNCTION public.impedir_exclusao_de_dia_de_cash_com_movimento();


-- 10.7) updated_at
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cash_days','cash_game_types','cash_tables',
                           'cash_player_sessions'] LOOP
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
    'cash_days','cash_game_types','cash_tables','cash_seats',
    'cash_player_sessions','cash_transactions','cash_rake_entries'
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


-- ── 12) Conferência ─────────────────────────────────────────────────────────
-- Nenhuma tabela de cash pode ficar sem RLS. Deve retornar 0 linhas:
--   SELECT tablename FROM pg_tables
--    WHERE schemaname='public' AND tablename LIKE 'cash%' AND NOT rowsecurity;
--
-- Toda gaveta continua com exatamente uma âncora. Deve retornar 0:
--   SELECT count(*) FROM public.cashboxes
--    WHERE num_nonnulls(stage_id, cash_day_id) <> 1;
