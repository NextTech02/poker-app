-- Relógio de mesa e time bank por jogador (docs/RELOGIO_DE_MESA_2026-11.md).
--
-- Só tabelas NOVAS, de propósito: nada lido pelas telas que já existem muda. Se
-- o deploy chegar antes desta migração, só a tela do relógio fica fora.

-- 1) Configuração por dia ----------------------------------------------------
CREATE TABLE IF NOT EXISTS public.table_clock_settings (
  tournament_day_id       uuid PRIMARY KEY REFERENCES public.tournament_days(id) ON DELETE CASCADE,
  organization_id         uuid NOT NULL DEFAULT current_org_id() REFERENCES public.organizations(id) ON DELETE CASCADE,
  enabled                 boolean NOT NULL DEFAULT false,
  preflop_seconds         smallint NOT NULL DEFAULT 20 CHECK (preflop_seconds BETWEEN 5 AND 300),
  postflop_seconds        smallint NOT NULL DEFAULT 30 CHECK (postflop_seconds BETWEEN 5 AND 300),
  called_clock_seconds    smallint NOT NULL DEFAULT 30 CHECK (called_clock_seconds BETWEEN 5 AND 300),
  -- Número que a TV mostra, sem contar os intervalos.
  start_level             smallint NOT NULL DEFAULT 1 CHECK (start_level BETWEEN 1 AND 200),
  time_bank_enabled       boolean NOT NULL DEFAULT true,
  card_seconds            smallint NOT NULL DEFAULT 30 CHECK (card_seconds BETWEEN 5 AND 300),
  initial_cards           smallint NOT NULL DEFAULT 2 CHECK (initial_cards BETWEEN 0 AND 50),
  cards_per_break         smallint NOT NULL DEFAULT 1 CHECK (cards_per_break BETWEEN 0 AND 20),
  max_cards_per_decision  smallint NOT NULL DEFAULT 6 CHECK (max_cards_per_decision BETWEEN 1 AND 50),
  updated_by              uuid DEFAULT auth.uid(),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_table_clock_settings_org ON public.table_clock_settings(organization_id);

-- 2) Histórico dos cartões ---------------------------------------------------
-- O saldo não fica gravado: é o direito (configuração + intervalos passados)
-- mais estes eventos. `entry_marker` é o rebuy_count de quando o evento
-- aconteceu, e o saldo só soma os da entrada atual: reentrada recomeça os
-- cartões, e estornar a reentrada traz o saldo anterior de volta.
CREATE TABLE IF NOT EXISTS public.time_bank_events (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid NOT NULL DEFAULT current_org_id() REFERENCES public.organizations(id) ON DELETE CASCADE,
  tournament_day_id     uuid NOT NULL REFERENCES public.tournament_days(id) ON DELETE CASCADE,
  tournament_player_id  uuid NOT NULL REFERENCES public.tournament_players(id) ON DELETE CASCADE,
  table_id              uuid REFERENCES public.tournament_tables(id) ON DELETE SET NULL,
  seat_number           smallint,
  -- use: gastou | undo: toque errado desfeito | adjust: o floor mexeu
  kind                  varchar(8) NOT NULL CHECK (kind IN ('use','undo','adjust')),
  cards                 smallint NOT NULL CHECK (cards <> 0),
  entry_marker          integer NOT NULL DEFAULT 0,
  level                 integer,
  reason                text,
  -- UNIQUE: desfazer duas vezes não dá cartão extra.
  undoes_event_id       uuid UNIQUE REFERENCES public.time_bank_events(id) ON DELETE CASCADE,
  -- UNIQUE: o tablet reenvia quando a rede volta, e o reenvio não desconta de novo.
  client_event_id       text UNIQUE,
  created_by            uuid DEFAULT auth.uid(),
  created_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_time_bank_events_day
  ON public.time_bank_events(tournament_day_id, tournament_player_id);
CREATE INDEX IF NOT EXISTS idx_time_bank_events_org ON public.time_bank_events(organization_id);

-- 3) RLS por organização + 2FA ----------------------------------------------
DO $rls$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['table_clock_settings','time_bank_events'] LOOP
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

-- 4) Realtime: o tablet e o painel do floor se atualizam sozinhos ------------
-- `seat_allocations` entra porque a lista da mesa depende dela. DELETE não passa
-- em filtro de coluna: quem cobre a saída do jogador é `tournament_players`.
DO $publica$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['table_clock_settings','time_bank_events','seat_allocations'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $publica$;

-- 5) Permissão nova: table_clock ---------------------------------------------
-- As rotas aceitam também `tables`, `tournaments` e `employees`, então ninguém
-- perde acesso sem isto. É para o grupo do dono continuar marcado como "todas
-- as permissões" na tela de Funcionários.
UPDATE public.permission_groups
   SET permissions = permissions || ARRAY['table_clock']::text[],
       updated_at  = now()
 WHERE 'employees' = ANY(permissions)
   AND NOT ('table_clock' = ANY(permissions));

-- Clube novo: a chave entra na lista de provision_organization. Parte do corpo
-- vigente em vez de copiá-lo aqui, para não congelar uma versão que pode ter
-- mudado. Se a lista não terminar como esperado, para em vez de adivinhar.
DO $provisao$
DECLARE
  definicao text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO STRICT definicao
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'provision_organization';

  IF position('table_clock' IN definicao) > 0 THEN
    RETURN;
  END IF;
  IF position('''fiado.manage''];' IN definicao) = 0 THEN
    RAISE EXCEPTION 'provision_organization mudou: a lista de permissões não termina em fiado.manage';
  END IF;
  EXECUTE replace(definicao, '''fiado.manage''];', '''fiado.manage'',''table_clock''];');
END $provisao$;
