-- ============================================================================
-- Log de acessos e atividade por organização (activity_logs)
-- ============================================================================
-- Até aqui o sistema não registrava quem entrou nem quem fez o quê: a única
-- pista era o `[perf]` no stdout do backend, que ninguém guarda. Esta migração
-- cria UMA tabela que serve às duas perguntas do cliente ("quem acessou?" e
-- "quem mexeu nisso?"), num único timeline por organização.
--
-- Três fontes de linha:
--   1. login / logout / org.switch — gravados pelo BACKEND (service_role). O
--      login é detectado no servidor na primeira requisição de cada sessão
--      (claim `session_id` do JWT), sem confiar no frontend.
--   2. <tabela>.insert|update|delete — gravados pela trigger genérica
--      `log_activity()` nas tabelas de negócio listadas abaixo.
--
-- Segurança: RLS ligado SEM política (mesmo desenho de mfa_recovery_codes).
-- Só a service_role e a trigger (SECURITY DEFINER) escrevem e leem; o backend
-- filtra pela org do claim e exige admin. Nada aqui é lido pelo navegador
-- direto — auditoria não pode ser apagada nem editada por quem é auditado.
--
-- Cascatas: `pg_trigger_depth() > 1` faz a trigger IGNORAR escritas disparadas
-- por OUTRAS triggers (espelho transactions -> cashbox_transactions, prize_pool
-- do dia, saldo do caixa geral). São consequência, não ação — a ação já ficou
-- registrada na tabela de origem. Efeito colateral aceito: se um dia uma
-- trigger de negócio criar de propósito uma linha auditada, ela não aparece.
--
-- Retenção: 180 dias, limpeza diária via pg_cron.
-- ============================================================================

-- ── 1. Tabela ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.activity_logs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- NULL = login de quem ainda não tem org ativa (convidado, platform admin).
    organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
    -- Sem FK em auth.users: apagar a conta não pode apagar o histórico dela.
    auth_user_id    UUID,
    user_email      TEXT,
    -- 'login' | 'logout' | 'org.switch' | '<tabela>.insert|update|delete'
    event_type      TEXT NOT NULL,
    entity_table    TEXT,
    entity_id       UUID,
    entity_label    TEXT,
    -- UPDATE: {campo: {old, new}} só do que mudou; INSERT/DELETE: a linha enxuta.
    changes         JSONB,
    -- TEXT e não INET: atrás do Cloudflare o X-Forwarded-For pode vir em lista,
    -- e um cast que falha derrubaria a linha de login em silêncio.
    ip              TEXT,
    user_agent      TEXT,
    session_id      UUID,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_logs_org_created
    ON public.activity_logs (organization_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_logs_user_created
    ON public.activity_logs (auth_user_id, created_at DESC);
-- Uma linha de login por sessão: é isto (e não o cache em memória do backend,
-- que é por worker e some no restart) que garante a deduplicação.
CREATE UNIQUE INDEX IF NOT EXISTS uq_activity_logs_login_session
    ON public.activity_logs (session_id) WHERE event_type = 'login';

ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.activity_logs FROM anon, authenticated;

COMMENT ON TABLE public.activity_logs IS
  'Acessos (login/logout/troca de org) e auditoria de ações por organização. Sem política de RLS de propósito: só service_role e a trigger log_activity() escrevem/leem.';

-- ── 2. Trigger genérica ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.log_activity() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
    v_new     jsonb;
    v_old     jsonb;
    v_row     jsonb;
    v_changes jsonb;
    v_org     uuid;
    v_id      uuid;
    v_label   text;
BEGIN
    -- Escrita em cascata (ver cabeçalho): consequência, não ação.
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;

    v_new := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
    v_old := CASE WHEN TG_OP IN ('UPDATE', 'DELETE') THEN to_jsonb(OLD) END;
    v_row := COALESCE(v_new, v_old);

    IF TG_OP = 'UPDATE' THEN
        SELECT jsonb_object_agg(n.key, jsonb_build_object('old', o.value, 'new', n.value))
          INTO v_changes
          FROM jsonb_each(v_new) n
          JOIN jsonb_each(v_old) o USING (key)
         WHERE n.value IS DISTINCT FROM o.value
           AND n.key <> 'updated_at';
        -- `UPDATE OF coluna` dispara mesmo quando o serviço reenvia o valor
        -- igual (payload completo). Sem diferença real, sem linha.
        IF v_changes IS NULL OR v_changes = '{}'::jsonb THEN
            RETURN NULL;
        END IF;
    ELSE
        -- Linha enxuta: sem nulos, sem broadcast_* (tournament_days tem ~90) e
        -- sem o que já está em coluna própria.
        SELECT jsonb_object_agg(key, value)
          INTO v_changes
          FROM jsonb_each(jsonb_strip_nulls(v_row))
         WHERE key NOT LIKE 'broadcast\_%'
           AND key NOT IN ('id', 'organization_id', 'created_at', 'updated_at');
    END IF;

    v_org   := COALESCE((v_row ->> 'organization_id')::uuid, public.current_org_id());
    v_id    := (v_row ->> 'id')::uuid;
    -- Rótulo humano da entidade, na ordem em que as tabelas auditadas o têm:
    -- name (torneio, etapa, grupo, funcionário, tipo de entrada), day_name (dia),
    -- label (meio de pagamento, dia de cash), description (despesa, receita),
    -- email (funcionário sem nome), stage_name (sangria), business_date (dia
    -- de cash sem rótulo), "tipo nome valor" (vendas), currency (app_settings),
    -- opened_at (sessão de caixa).
    v_label := left(COALESCE(
        v_row ->> 'name',
        v_row ->> 'day_name',
        v_row ->> 'label',
        v_row ->> 'description',
        v_row ->> 'email',
        v_row ->> 'stage_name',
        v_row ->> 'business_date',
        NULLIF(concat_ws(' ', v_row ->> 'type', v_row ->> 'buy_type_name', v_row ->> 'amount'), ''),
        v_row ->> 'currency',
        v_row ->> 'opened_at'
    ), 120);

    -- auth.uid()/auth.jwt() leem request.jwt.claims da transação: valem dentro
    -- de SECURITY DEFINER. Na service_role vêm NULL — a tela mostra "Sistema".
    INSERT INTO public.activity_logs
        (organization_id, auth_user_id, user_email, event_type,
         entity_table, entity_id, entity_label, changes)
    VALUES
        (v_org, auth.uid(), auth.jwt() ->> 'email', TG_TABLE_NAME || '.' || lower(TG_OP),
         TG_TABLE_NAME, v_id, v_label, v_changes);
    RETURN NULL;
EXCEPTION WHEN OTHERS THEN
    -- Auditoria nunca derruba a operação de negócio.
    RAISE WARNING 'log_activity falhou em %.%: %', TG_TABLE_NAME, TG_OP, SQLERRM;
    RETURN NULL;
END
$$;

-- ── 3. Triggers por tabela ──────────────────────────────────────────────────
-- UPDATE é sempre `OF colunas`: nas tabelas quentes (tournament_days recebe o
-- timer a cada segundo; transactions mexe no prize_pool) auditar tudo seria
-- ruído e custo. Só o que um humano muda de propósito entra.
DO $$
DECLARE
    t record;
BEGIN
    FOR t IN
        SELECT * FROM (VALUES
            ('tournaments',          true,  true,  'name, status, stage_id, guaranteed_prize, has_qualifying, is_satellite, sponsor_id, reserved_prize_percentage, reserved_purpose'),
            ('tournament_days',      true,  true,  'day_name, day_number, day_type, status, buy_in, rebuy_amount, addon_amount, rake_percentage, max_players, starting_chips, rebuy_chips, addon_chips, blind_duration, rebuy_level_limit, break_interval, break_duration, allocation_type, allocation_mode, tables_locked, guaranteed_prize, start_time, tournament_date, qualifies_to_day_id, currency, sales_blocked'),
            ('stages',               true,  true,  'name, location, start_date, end_date, description, status, sales_blocked'),
            ('transactions',         true,  true,  'status, amount, payment_method, payment_source, cancel_reason'),
            ('sangria_transactions', true,  true,  'amount, notes'),
            ('cashbox_sessions',     true,  true,  'closed_at, actual_final_balance, initial_balance, notes'),
            ('cashbox_transactions', true,  true,  'amount, notes'),
            ('staff',                true,  true,  'name, email, permission_group_id, active, invite_status'),
            ('permission_groups',    true,  true,  'name, description, permissions'),
            ('staff_payments',       true,  true,  'amount, status, paid_at'),
            ('expenses',             true,  true,  'description, supplier, amount, status, due_date, paid_at, payment_method, paid_from_cash, category_id'),
            ('other_revenues',       true,  true,  'description, source, amount, status, received_at, payment_method, to_cash'),
            ('buy_types',            true,  true,  'name, category, amount, rake_percentage, active, chips'),
            ('payment_methods',      true,  true,  'code, label, active'),
            -- app_settings nasce no provisionamento (service_role): só a edição interessa.
            ('app_settings',         false, false, 'currency, language'),
            ('cash_days',            true,  true,  'status, closed_at, label, notes'),
            ('cash_transactions',    true,  true,  'status, amount, cancel_reason')
        ) AS v(tabela, com_insert, com_delete, colunas_update)
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_log_%1$s_ins ON public.%1$I', t.tabela);
        EXECUTE format('DROP TRIGGER IF EXISTS trg_log_%1$s_upd ON public.%1$I', t.tabela);
        EXECUTE format('DROP TRIGGER IF EXISTS trg_log_%1$s_del ON public.%1$I', t.tabela);

        IF t.com_insert THEN
            EXECUTE format(
                'CREATE TRIGGER trg_log_%1$s_ins AFTER INSERT ON public.%1$I '
                'FOR EACH ROW EXECUTE FUNCTION public.log_activity()', t.tabela);
        END IF;
        EXECUTE format(
            'CREATE TRIGGER trg_log_%1$s_upd AFTER UPDATE OF %2$s ON public.%1$I '
            'FOR EACH ROW EXECUTE FUNCTION public.log_activity()', t.tabela, t.colunas_update);
        IF t.com_delete THEN
            EXECUTE format(
                'CREATE TRIGGER trg_log_%1$s_del AFTER DELETE ON public.%1$I '
                'FOR EACH ROW EXECUTE FUNCTION public.log_activity()', t.tabela);
        END IF;
    END LOOP;
END $$;

-- ── 4. Retenção (180 dias) ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.activity_logs_purge() RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
    DELETE FROM public.activity_logs WHERE created_at < now() - interval '180 days';
$$;

CREATE EXTENSION IF NOT EXISTS pg_cron;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'activity-logs-purge') THEN
        PERFORM cron.schedule('activity-logs-purge', '30 3 * * *', $c$select public.activity_logs_purge();$c$);
    END IF;
END $$;

-- ── Verificação (rodar à mão) ───────────────────────────────────────────────
-- SELECT count(*) FROM pg_trigger WHERE tgfoid = 'public.log_activity'::regproc;  -- 49
-- SELECT * FROM pg_policies WHERE tablename = 'activity_logs';                     -- 0 linhas
-- SELECT jobname, schedule FROM cron.job WHERE jobname = 'activity-logs-purge';
