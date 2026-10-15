-- ============================================================================
-- Torneio por equipes (bases do NSOP: "Torneo de póker por equipos")
-- Date: 2026-10-15
-- ----------------------------------------------------------------------------
-- Equipe = capitão + 3. Fase 1 (o dia CLASSIFICATÓRIO, modo mesa): os 4 em
-- mesas diferentes, cada mesa joga até sobrar 1, pontos pela posição NA MESA
-- (o k-º a cair faz 5·k; o vencedor, 5·N). Pontuação da equipe = soma dos 4.
-- Fase 2 (o dia FINAL): as melhores equipes numa mesa, um stack por equipe,
-- revezando o jogador a cada nível de blinds.
--
-- Desenho:
--   * Na final cada equipe é UMA linha de tournament_players (a do capitão,
--     is_qualified_entry) — contadores, ✕ no assento, telão e premiação já
--     funcionam por "jogador" = equipe.
--   * `tournament_team_results` guarda só FATOS da Fase 1 (mesa no momento da
--     eliminação, hora, empate com o anterior, posição à mão). Pontos e
--     ranking são calculados na leitura; a linha só vale enquanto o jogador
--     está eliminado (desfazer, reentrada e estorno não precisam de gancho).
--     "Oficializar" congela a foto (position/points/table_size e
--     tournament_teams.stage1_points/stage1_rank).
--
-- SEM chave estrangeira para tournament_days, tournament_players, players e
-- tournament_tables, de propósito: FK nova entre tabelas que a aplicação
-- embute pode deixar o embed AMBÍGUO no PostgREST (PGRST201) — foi isso que
-- derrubou o sistema no evento de 13/10. FKs só para organizations,
-- tournaments e entre as tabelas deste módulo.
--
-- Compatível com o backend anterior: só colunas novas com padrão e tabelas
-- novas. organization_id tem default current_org_id(), mas o backend grava o
-- valor EXPLICITAMENTE (o replay offline roda com a service_role).
-- ============================================================================

-- ESTADO EM PRODUÇÃO: aplicada em 2026-10-15 (sem jogo rolando) em três
-- partes pelo conector do Supabase (torneio_equipes_parte1_colunas,
-- _parte2_tabelas, _parte3_rls). O conector recusa comando "destrutivo"
-- (DROP POLICY) com "Invalid or expired requestState": na parte 3 as
-- políticas foram criadas só se não existiam, sem o DROP.

SET lock_timeout = '5s';

DO $$
BEGIN
  IF to_regproc('public.current_org_id') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_saas_phase3a_rls_helpers.sql (current_org_id)';
  END IF;
  IF to_regproc('public.mfa_satisfeito') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_mfa_2fa.sql (mfa_satisfeito)';
  END IF;
END $$;

-- 1) Configuração no torneio ------------------------------------------------
ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS team_mode boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS team_finalists smallint,
  ADD COLUMN IF NOT EXISTS team_tiebreak varchar(20) NOT NULL DEFAULT 'best_individual',
  ADD COLUMN IF NOT EXISTS team_allow_reentry boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS team_results_official_at timestamptz,
  ADD COLUMN IF NOT EXISTS team_results_official_by uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_tournaments_team_finalists') THEN
    ALTER TABLE public.tournaments
      ADD CONSTRAINT chk_tournaments_team_finalists CHECK (team_finalists IS NULL OR team_finalists BETWEEN 1 AND 8);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_tournaments_team_tiebreak') THEN
    ALTER TABLE public.tournaments
      ADD CONSTRAINT chk_tournaments_team_tiebreak CHECK (team_tiebreak IN ('best_individual','manual'));
  END IF;
END $$;

COMMENT ON COLUMN public.tournaments.team_mode IS
  'Torneio por equipes: Fase 1 = dia classificatório (pontos por mesa), Fase 2 = dia final por revezamento';
COMMENT ON COLUMN public.tournaments.team_tiebreak IS
  '2º critério de desempate (depois do capitão): best_individual (melhores pontos individuais) | manual (a direção ordena)';
COMMENT ON COLUMN public.tournaments.team_allow_reentry IS
  'Fase 1: permite recompra/reentrada; vale a ÚLTIMA eliminação do jogador';

-- 2) Meio de entrada cobrado por equipe -------------------------------------
ALTER TABLE public.buy_types
  ADD COLUMN IF NOT EXISTS per_team boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.buy_types.per_team IS
  'Cobrança por equipe: amount = preço da EQUIPE (dividido entre os 4); chips = stack de CADA jogador';

-- 3) Equipes -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.tournament_teams (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL DEFAULT current_org_id() REFERENCES public.organizations(id) ON DELETE CASCADE,
  tournament_id         uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  name                  varchar(80) NOT NULL,
  captain_player_id     uuid NOT NULL,          -- sem FK (ver cabeçalho)
  final_tp_id           uuid,                   -- linha da equipe no dia final; sem FK
  tiebreak_rank         smallint,               -- desempate manual (menor = melhor)
  captain_verified_at   timestamptz,
  captain_verified_by   uuid,
  stage1_points         numeric(7,2),           -- foto do "oficializar"
  stage1_rank           smallint,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_tournament_teams_name
  ON public.tournament_teams(tournament_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_tournament_teams_org ON public.tournament_teams(organization_id);

-- 4) Integrantes (a ordem do revezamento é a da final) ----------------------
CREATE TABLE IF NOT EXISTS public.tournament_team_members (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL DEFAULT current_org_id() REFERENCES public.organizations(id) ON DELETE CASCADE,
  tournament_id         uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  team_id               uuid NOT NULL REFERENCES public.tournament_teams(id) ON DELETE CASCADE,
  player_id             uuid NOT NULL,          -- sem FK (ver cabeçalho)
  relay_order           smallint NOT NULL CHECK (relay_order BETWEEN 1 AND 4),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_team_members_player UNIQUE (tournament_id, player_id),
  -- Adiada: reordenar os 4 é UM update em lote sem colidir no meio do caminho.
  CONSTRAINT uq_team_members_order UNIQUE (team_id, relay_order) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS idx_team_members_team ON public.tournament_team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_org ON public.tournament_team_members(organization_id);

-- 5) Resultado da Fase 1 (um por participante, inclusive avulsos) ----------
CREATE TABLE IF NOT EXISTS public.tournament_team_results (
  -- id determinístico (uuid5 de dia:inscrição) gerado pelo backend: o upsert
  -- da eliminação é idempotente no replay offline.
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL DEFAULT current_org_id() REFERENCES public.organizations(id) ON DELETE CASCADE,
  tournament_id         uuid NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  tournament_day_id     uuid NOT NULL,          -- sem FK (ver cabeçalho)
  tournament_player_id  uuid NOT NULL,          -- sem FK
  player_id             uuid NOT NULL,          -- sem FK
  table_id              uuid,                   -- sem FK; nulo = eliminado sem assento
  table_number          integer,
  eliminated_at         timestamptz,
  tie_with_previous     boolean NOT NULL DEFAULT false,
  manual_position       smallint CHECK (manual_position IS NULL OR manual_position >= 1),
  -- Foto do "oficializar"
  position              smallint,
  points                numeric(6,2),
  table_size            smallint,
  source                varchar(10) NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','manual')),
  updated_by            uuid,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_team_results_day_tp UNIQUE (tournament_day_id, tournament_player_id)
);
CREATE INDEX IF NOT EXISTS idx_team_results_tournament ON public.tournament_team_results(tournament_id);
CREATE INDEX IF NOT EXISTS idx_team_results_org ON public.tournament_team_results(organization_id);

-- 6) RLS por organização + 2FA ----------------------------------------------
DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tournament_teams','tournament_team_members','tournament_team_results'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_org_isolation', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated '
      'USING ((organization_id = (select public.current_org_id())) or (select public.is_platform_admin())) '
      'WITH CHECK ((organization_id = (select public.current_org_id())) or (select public.is_platform_admin()))',
      t || '_org_isolation', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_exige_mfa', t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
      'USING ((select public.mfa_satisfeito()))',
      t || '_exige_mfa', t);
  END LOOP;
END $rls$;

-- 7) Realtime: a tela de equipes se atualiza sozinha ------------------------
DO $publica$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tournament_teams','tournament_team_results'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $publica$;

-- Excluir organização: as três tabelas caem em cascata (organizations e
-- tournaments são ON DELETE CASCADE); não precisam entrar em delete_organization.

-- Conferência ----------------------------------------------------------------
-- select policyname, permissive from pg_policies where tablename like 'tournament_team%';
--   -> *_org_isolation PERMISSIVE + *_exige_mfa RESTRICTIVE nas três tabelas
-- select conname, conrelid::regclass, confrelid::regclass from pg_constraint
--  where contype = 'f' and conrelid::regclass::text like 'tournament_team%';
--   -> só organizations, tournaments e tournament_teams
