-- ============================================================================
-- Ranking de pontos (Manual de Ranking NSOP, "Versión Nueva")
-- Date: 2026-11-16
-- ----------------------------------------------------------------------------
-- Por torneio, cada posição PREMIADA (ITM) vale
--     PONTOS = ARREDONDAR[(100 ÷ √posição) × FJ × FB]
--     FJ = máx(0,75; mín(1,50; (N ÷ 50)^0,17))   N = jogadores únicos
--     FB = máx(0,75; mín(1,40; (B ÷ 350)^0,16))  B = buy-in oficial sem taxa
-- e 0 fora do ITM ou com menos de 12 jogadores únicos. O ranking da etapa soma
-- os torneios dela; o da temporada (grupo de etapas) soma os N melhores.
-- A conta mora no backend (app/services/ranking_pontos_regras.py).
--
-- Desenho:
--   * ranking_rules: os parâmetros do clube (padrão = o manual). Uma linha por
--     organização, criada na primeira gravação.
--   * tournaments.ranking_*: o torneio é "pontuável" (o manual pede que esteja
--     no calendário anunciado), o B oficial e o carimbo de oficialização.
--   * tournament_ranking_results: a FOTO congelada ao oficializar — posição,
--     pontos e os N/B/T usados. "Uma vez fechado, não se recalcula": mudar a
--     premiação depois não mexe no ranking; corrigir exige reabrir COM MOTIVO
--     (fica no log de atividade).
--   * ranking_seasons + ranking_season_stages: a temporada e as etapas dela.
--
-- SEM chave estrangeira para tournament_players, players e stages, de
-- propósito (ver torneio_equipes: FK nova entre tabelas embutidas pode deixar
-- o embed ambíguo no PostgREST, PGRST201). FKs só para organizations,
-- tournaments e entre as tabelas deste módulo.
--
-- Compatível com o backend anterior: só colunas novas com padrão e tabelas
-- novas. O backend novo diz "migração pendente" enquanto ela não roda.
-- ============================================================================

SET lock_timeout = '5s';

DO $$
BEGIN
  IF to_regproc('public.current_org_id') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_saas_phase3a_rls_helpers.sql (current_org_id)';
  END IF;
  IF to_regproc('public.mfa_satisfeito') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_mfa_2fa.sql (mfa_satisfeito)';
  END IF;
  IF to_regproc('public.log_activity') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_activity_logs.sql (log_activity)';
  END IF;
END $$;

-- 1) Parâmetros do clube ------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ranking_rules (
  organization_id     uuid PRIMARY KEY DEFAULT public.current_org_id()
                        REFERENCES public.organizations(id) ON DELETE CASCADE,
  base_points         numeric(8,2)  NOT NULL DEFAULT 100,
  players_reference   numeric(10,2) NOT NULL DEFAULT 50,
  players_exponent    numeric(6,4)  NOT NULL DEFAULT 0.17,
  players_factor_min  numeric(6,4)  NOT NULL DEFAULT 0.75,
  players_factor_max  numeric(6,4)  NOT NULL DEFAULT 1.50,
  buy_in_reference    numeric(14,2) NOT NULL DEFAULT 350,
  buy_in_exponent     numeric(6,4)  NOT NULL DEFAULT 0.16,
  buy_in_factor_min   numeric(6,4)  NOT NULL DEFAULT 0.75,
  buy_in_factor_max   numeric(6,4)  NOT NULL DEFAULT 1.40,
  min_unique_players  integer       NOT NULL DEFAULT 12,
  updated_by          uuid,
  created_at          timestamptz   NOT NULL DEFAULT now(),
  updated_at          timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT chk_ranking_rules_positivos CHECK (
    base_points > 0 AND players_reference > 0 AND buy_in_reference > 0
    AND players_factor_min > 0 AND buy_in_factor_min > 0 AND min_unique_players >= 1),
  CONSTRAINT chk_ranking_rules_faixas CHECK (
    players_factor_min <= players_factor_max AND buy_in_factor_min <= buy_in_factor_max)
);
COMMENT ON TABLE public.ranking_rules IS
  'Parâmetros do ranking de pontos do clube (padrão = Manual de Ranking NSOP)';

-- 2) O torneio no ranking -------------------------------------------------------
ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS ranking_scoring       boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ranking_buy_in        numeric(14,2),
  ADD COLUMN IF NOT EXISTS ranking_official_at   timestamptz,
  ADD COLUMN IF NOT EXISTS ranking_official_by   uuid,
  ADD COLUMN IF NOT EXISTS ranking_reopen_reason text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_tournaments_ranking_buy_in') THEN
    ALTER TABLE public.tournaments
      ADD CONSTRAINT chk_tournaments_ranking_buy_in CHECK (ranking_buy_in IS NULL OR ranking_buy_in > 0);
  END IF;
END $$;

COMMENT ON COLUMN public.tournaments.ranking_scoring IS
  'Torneio pontuável no ranking (anunciado no calendário). Padrão: não';
COMMENT ON COLUMN public.tournaments.ranking_buy_in IS
  'B do ranking: buy-in oficial anunciado, sem a taxa. Vazio = o do meio de entrada principal';
COMMENT ON COLUMN public.tournaments.ranking_reopen_reason IS
  'Motivo da última reabertura dos resultados oficiais (o histórico fica no log de atividade)';

-- 3) Resultados oficiais (a foto congelada) ---------------------------------
CREATE TABLE IF NOT EXISTS public.tournament_ranking_results (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL DEFAULT public.current_org_id()
                     REFERENCES public.organizations(id) ON DELETE CASCADE,
  tournament_id    uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  player_id        uuid NOT NULL,
  player_name      text NOT NULL,
  position         integer NOT NULL CHECK (position >= 1),
  points           integer NOT NULL DEFAULT 0 CHECK (points >= 0),
  raw_points       numeric(12,4) NOT NULL DEFAULT 0,
  unique_players   integer NOT NULL CHECK (unique_players >= 0),
  buy_in           numeric(14,2) NOT NULL CHECK (buy_in > 0),
  paid_places      integer NOT NULL CHECK (paid_places >= 1),
  players_factor   numeric(8,5) NOT NULL,
  buy_in_factor    numeric(8,5) NOT NULL,
  official_by      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ranking_results_posicao UNIQUE (tournament_id, position),
  CONSTRAINT uq_ranking_results_jogador UNIQUE (tournament_id, player_id)
);
CREATE INDEX IF NOT EXISTS idx_ranking_results_org ON public.tournament_ranking_results(organization_id);
CREATE INDEX IF NOT EXISTS idx_ranking_results_jogador ON public.tournament_ranking_results(player_id);
COMMENT ON TABLE public.tournament_ranking_results IS
  'Resultado oficial congelado de um torneio pontuável: posição premiada, pontos e os N/B/T usados';

-- 4) Temporadas -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ranking_seasons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL DEFAULT public.current_org_id()
                     REFERENCES public.organizations(id) ON DELETE CASCADE,
  name             varchar(120) NOT NULL,
  best_results     smallint DEFAULT 8 CHECK (best_results IS NULL OR best_results BETWEEN 1 AND 100),
  status           varchar(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  created_by       uuid,
  updated_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ranking_seasons_org ON public.ranking_seasons(organization_id);
COMMENT ON COLUMN public.ranking_seasons.best_results IS
  'Quantos melhores resultados de cada jogador somam (manual: 8). Vazio = todos';

CREATE TABLE IF NOT EXISTS public.ranking_season_stages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id  uuid NOT NULL DEFAULT public.current_org_id()
                     REFERENCES public.organizations(id) ON DELETE CASCADE,
  season_id        uuid NOT NULL REFERENCES public.ranking_seasons(id) ON DELETE CASCADE,
  stage_id         uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ranking_season_stage UNIQUE (season_id, stage_id)
);
CREATE INDEX IF NOT EXISTS idx_ranking_season_stages_org ON public.ranking_season_stages(organization_id);

-- 5) updated_at -------------------------------------------------------------------
CREATE OR REPLACE TRIGGER trg_ranking_rules_updated_at
  BEFORE UPDATE ON public.ranking_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE OR REPLACE TRIGGER trg_ranking_seasons_updated_at
  BEFORE UPDATE ON public.ranking_seasons
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 6) RLS por organização + 2FA ----------------------------------------------------
DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ranking_rules','tournament_ranking_results','ranking_seasons','ranking_season_stages'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t
                     AND policyname = t || '_org_isolation') THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I FOR ALL TO authenticated '
        'USING ((organization_id = (select public.current_org_id())) or (select public.is_platform_admin())) '
        'WITH CHECK ((organization_id = (select public.current_org_id())) or (select public.is_platform_admin()))',
        t || '_org_isolation', t);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = t
                     AND policyname = t || '_exige_mfa') THEN
      EXECUTE format(
        'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
        'USING ((select public.mfa_satisfeito()))',
        t || '_exige_mfa', t);
    END IF;
  END LOOP;
END $rls$;

-- 7) Log de atividade -----------------------------------------------------------
-- Rastro que o manual exige nas correções: quem, quando, valor antigo e novo
-- e o motivo (ranking_reopen_reason, gravado na reabertura).
CREATE OR REPLACE TRIGGER trg_log_ranking_rules_ins
  AFTER INSERT ON public.ranking_rules
  FOR EACH ROW EXECUTE FUNCTION public.log_activity();
CREATE OR REPLACE TRIGGER trg_log_ranking_rules_upd
  AFTER UPDATE OF base_points, players_reference, players_exponent, players_factor_min, players_factor_max,
                  buy_in_reference, buy_in_exponent, buy_in_factor_min, buy_in_factor_max, min_unique_players
  ON public.ranking_rules
  FOR EACH ROW EXECUTE FUNCTION public.log_activity();
CREATE OR REPLACE TRIGGER trg_log_tournament_ranking_results_ins
  AFTER INSERT ON public.tournament_ranking_results
  FOR EACH ROW EXECUTE FUNCTION public.log_activity();
CREATE OR REPLACE TRIGGER trg_log_tournament_ranking_results_del
  AFTER DELETE ON public.tournament_ranking_results
  FOR EACH ROW EXECUTE FUNCTION public.log_activity();
CREATE OR REPLACE TRIGGER trg_log_ranking_seasons_ins
  AFTER INSERT ON public.ranking_seasons
  FOR EACH ROW EXECUTE FUNCTION public.log_activity();
CREATE OR REPLACE TRIGGER trg_log_ranking_seasons_upd
  AFTER UPDATE OF name, best_results, status ON public.ranking_seasons
  FOR EACH ROW EXECUTE FUNCTION public.log_activity();
CREATE OR REPLACE TRIGGER trg_log_ranking_seasons_del
  AFTER DELETE ON public.ranking_seasons
  FOR EACH ROW EXECUTE FUNCTION public.log_activity();
CREATE OR REPLACE TRIGGER trg_log_ranking_season_stages_ins
  AFTER INSERT ON public.ranking_season_stages
  FOR EACH ROW EXECUTE FUNCTION public.log_activity();
CREATE OR REPLACE TRIGGER trg_log_ranking_season_stages_del
  AFTER DELETE ON public.ranking_season_stages
  FOR EACH ROW EXECUTE FUNCTION public.log_activity();

-- O log de tournaments já existia só para algumas colunas: a lista é a de
-- antes (conferida em produção em 2026-11-16) mais as do ranking.
CREATE OR REPLACE TRIGGER trg_log_tournaments_upd
  AFTER UPDATE OF name, status, stage_id, guaranteed_prize, has_qualifying, is_satellite, sponsor_id,
                  reserved_prize_percentage, reserved_purpose,
                  ranking_scoring, ranking_buy_in, ranking_official_at, ranking_reopen_reason
  ON public.tournaments
  FOR EACH ROW EXECUTE FUNCTION public.log_activity();

-- 8) Permissão nova: points_ranking ---------------------------------------------
-- O grupo do dono (o que tem `employees`) continua com "todas as permissões".
UPDATE public.permission_groups
   SET permissions = permissions || ARRAY['points_ranking']::text[],
       updated_at  = now()
 WHERE 'employees' = ANY(permissions)
   AND NOT ('points_ranking' = ANY(permissions));

-- Clube novo: a chave entra na lista de provision_organization. Parte do corpo
-- vigente; se a lista não terminar como esperado, para em vez de adivinhar.
DO $provisao$
DECLARE
  definicao text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO STRICT definicao
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'provision_organization';

  IF position('points_ranking' IN definicao) > 0 THEN
    RETURN;
  END IF;
  IF position('''table_clock''];' IN definicao) = 0 THEN
    RAISE EXCEPTION 'provision_organization mudou: a lista de permissões não termina em table_clock';
  END IF;
  EXECUTE replace(definicao, '''table_clock''];', '''table_clock'',''points_ranking''];');
END $provisao$;

RESET lock_timeout;

-- Excluir organização: as tabelas novas caem em cascata (organizations e
-- tournaments são ON DELETE CASCADE); não precisam entrar em delete_organization.

-- Conferência ----------------------------------------------------------------------
-- select policyname, permissive, tablename from pg_policies
--  where tablename in ('ranking_rules','tournament_ranking_results','ranking_seasons','ranking_season_stages');
--   -> *_org_isolation PERMISSIVE + *_exige_mfa RESTRICTIVE nas quatro
-- select pg_get_triggerdef(oid) from pg_trigger where tgname = 'trg_log_tournaments_upd';
--   -> inclui ranking_scoring ... ranking_reopen_reason
-- select position('points_ranking' in pg_get_functiondef('public.provision_organization'::regproc)) > 0;
--   -> true
