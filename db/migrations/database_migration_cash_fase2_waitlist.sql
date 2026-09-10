-- ============================================================================
-- CASH GAME — Fase 2: fila de espera e gestão de assentos
-- ----------------------------------------------------------------------------
-- ORDEM: aplicar DEPOIS de database_migration_cash_fase1_core.sql.
--
-- A FILA É O QUE FAZ A SALA GIRAR. Numa noite cheia há mais gente do que
-- cadeira, e quem decide a ordem é um papel na mão de alguém — que se perde,
-- some, e vira discussão na frente da mesa. O sistema existe para essa ordem
-- ser a mesma para todo mundo que olhar a tela.
--
-- POR QUE `guest_name`: o visitante que chega pela primeira vez entra na fila
-- ANTES de virar cadastro. Exigir o cadastro primeiro faria o operador digitar
-- documento e telefone com cinco pessoas esperando no balcão — e na prática ele
-- anotaria num papel, que é exatamente o que a fila veio substituir.
-- ============================================================================

DO $$ BEGIN
  IF to_regclass('public.cash_days') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_cash_fase1_core.sql';
  END IF;
END $$;


CREATE TABLE IF NOT EXISTS public.cash_waitlist (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id  UUID NOT NULL DEFAULT public.current_org_id()
                     REFERENCES public.organizations(id) ON DELETE CASCADE,
    cash_day_id      UUID NOT NULL REFERENCES public.cash_days(id) ON DELETE CASCADE,
    -- Fila por MODALIDADE (quero NLH 1/2, em qualquer mesa) ou por MESA
    -- específica (quero aquela mesa). Nenhum dos dois = fila geral.
    game_type_id     UUID REFERENCES public.cash_game_types(id) ON DELETE SET NULL,
    table_id         UUID REFERENCES public.cash_tables(id) ON DELETE SET NULL,
    player_id        UUID REFERENCES public.players(id) ON DELETE SET NULL,
    guest_name       VARCHAR(160),
    position         INT NOT NULL,
    status           VARCHAR(16) NOT NULL DEFAULT 'waiting'
                     CHECK (status IN ('waiting','called','seated','cancelled','no_show')),
    called_at        TIMESTAMPTZ,
    seated_at        TIMESTAMPTZ,
    seat_id          UUID REFERENCES public.cash_seats(id) ON DELETE SET NULL,
    notes            TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Uma linha da fila é uma PESSOA: ou um jogador cadastrado, ou um nome.
    CHECK (player_id IS NOT NULL OR guest_name IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_cash_waitlist_organization_id
    ON public.cash_waitlist(organization_id);
-- O índice segue a leitura da tela: a fila do dia, em ordem, por status.
CREATE INDEX IF NOT EXISTS idx_cash_waitlist_fila
    ON public.cash_waitlist(cash_day_id, status, position);

-- O mesmo jogador não entra duas vezes na fila do dia. Sem isto, quem pergunta
-- "já me anotou?" e é anotado de novo passa na frente de quem chegou antes.
CREATE UNIQUE INDEX IF NOT EXISTS uq_cash_waitlist_jogador_esperando
    ON public.cash_waitlist(cash_day_id, player_id)
    WHERE status IN ('waiting', 'called') AND player_id IS NOT NULL;

COMMENT ON COLUMN public.cash_waitlist.position IS
  'Ordem de chegada. Editável pelo operador (alguém cedeu a vez), mas nunca reciclada: a posição é histórico do que aconteceu.';
COMMENT ON COLUMN public.cash_waitlist.guest_name IS
  'Visitante ainda sem cadastro. Entrar na fila não pode depender de preencher documento com gente esperando no balcão.';


-- ── updated_at ──────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_cash_waitlist_updated_at ON public.cash_waitlist;
CREATE TRIGGER trg_cash_waitlist_updated_at
    BEFORE UPDATE ON public.cash_waitlist
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- ── RLS, padrão InitPlan ────────────────────────────────────────────────────
ALTER TABLE public.cash_waitlist ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cash_waitlist_org_isolation ON public.cash_waitlist;
CREATE POLICY cash_waitlist_org_isolation ON public.cash_waitlist
FOR ALL TO authenticated
USING (
  organization_id = (SELECT public.current_org_id())
  OR (SELECT public.is_platform_admin())
)
WITH CHECK (
  organization_id = (SELECT public.current_org_id())
  OR (SELECT public.is_platform_admin())
);


-- ── Correção: a troca de mesa move as vendas entre sessões ──────────────────
-- `cash_touch_player_session` recalculava só a sessão do NEW. Quando o jogador
-- troca de mesa, as vendas passam da sessão antiga para a nova — e a antiga
-- ficava com os totais congelados, fazendo a mesa de ORIGEM continuar somando
-- dinheiro que já está noutra mesa. O salão contaria o mesmo buy-in duas vezes.
--
-- Agora recalcula as DUAS pontas quando a sessão da venda muda.
CREATE OR REPLACE FUNCTION public.cash_touch_player_session()
RETURNS TRIGGER
LANGUAGE plpgsql AS $fn$
DECLARE
    v_ps UUID;
BEGIN
    FOREACH v_ps IN ARRAY ARRAY[
        CASE WHEN TG_OP <> 'DELETE' THEN NEW.player_session_id END,
        CASE WHEN TG_OP <> 'INSERT' THEN OLD.player_session_id END
    ] LOOP
        CONTINUE WHEN v_ps IS NULL;

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
    END LOOP;

    RETURN COALESCE(NEW, OLD);
END $fn$;


-- ── Conferência ─────────────────────────────────────────────────────────────
-- Deve retornar 0 linhas:
--   SELECT tablename FROM pg_tables
--    WHERE schemaname='public' AND tablename LIKE 'cash%' AND NOT rowsecurity;
