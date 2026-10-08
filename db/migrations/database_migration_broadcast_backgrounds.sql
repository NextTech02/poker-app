-- ============================================================================
-- Fundos do telão (biblioteca de imagens do clube) + escurecimento da imagem
-- ----------------------------------------------------------------------------
-- Até aqui a imagem de fundo da TV viajava em BASE64 dentro da linha do dia
-- (`tournament_days.broadcast_bg_image_url`): até 2 MB por dia, reenviados a
-- cada poll de 30 s do telão e em toda listagem de dias. Agora o clube sobe as
-- imagens UMA vez para o Storage e escolhe uma por dia; a coluna passa a
-- guardar só a URL pública. Valores antigos (data:) continuam funcionando.
--
-- BUCKET PÚBLICO de propósito: a TV do salão não faz login, então a imagem
-- precisa abrir por link. O caminho começa pelo id da organização e segue com
-- um uuid (`{org}/{uuid}.webp`): não é adivinhável, e só fundo de telão mora
-- aqui — nada sensível. A ESCRITA continua isolada por clube (1ª pasta =
-- `current_org_id()`), no mesmo molde do bucket `comprovantes`.
--
-- Pré-requisitos: database_migration_saas_phase3a_rls_helpers.sql
-- (current_org_id / is_platform_admin) e database_migration_mfa_2fa.sql
-- (mfa_satisfeito). O bloco `_exige_mfa` vai aqui porque o loop da migração
-- de 2FA NÃO é retroativo: tabela criada depois dele precisa do seu próprio.
-- ============================================================================

DO $$
BEGIN
  IF to_regproc('public.current_org_id') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_saas_phase3a_rls_helpers.sql (current_org_id)';
  END IF;
  IF to_regproc('public.mfa_satisfeito') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_mfa_2fa.sql (mfa_satisfeito)';
  END IF;
END $$;

-- 1) Bucket PÚBLICO ----------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'broadcast-backgrounds', 'broadcast-backgrounds', true,
  5242880,  -- 5 MB: o app reduz a imagem para 1920 px antes de subir; isto é só o teto
  array['image/jpeg','image/png','image/webp']
)
on conflict (id) do update set
  public = true,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- 2) Policies do Storage — a org do usuário precisa bater com a 1ª pasta ------
-- (a leitura anônima NÃO passa por aqui: bucket público serve
--  /storage/v1/object/public/... sem consultar RLS; o SELECT abaixo só vale
--  para listar/baixar pela API autenticada)
drop policy if exists broadcast_backgrounds_select on storage.objects;
create policy broadcast_backgrounds_select on storage.objects for select
  to authenticated
  using (
    bucket_id = 'broadcast-backgrounds'
    and (storage.foldername(name))[1] = (select current_org_id())::text
  );

drop policy if exists broadcast_backgrounds_insert on storage.objects;
create policy broadcast_backgrounds_insert on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'broadcast-backgrounds'
    and (storage.foldername(name))[1] = (select current_org_id())::text
  );

drop policy if exists broadcast_backgrounds_delete on storage.objects;
create policy broadcast_backgrounds_delete on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'broadcast-backgrounds'
    and (storage.foldername(name))[1] = (select current_org_id())::text
  );

-- 3) Biblioteca (metadados) -------------------------------------------------
-- A tela lista daqui, não da API de Storage: nome original, tamanho e ordem
-- de envio sem uma chamada extra por render. Apagar a organização leva as
-- linhas junto (cascade); os ARQUIVOS o app remove antes (o Storage não
-- participa do cascade do SQL).
create table if not exists public.broadcast_backgrounds (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null default current_org_id() references public.organizations(id) on delete cascade,
  path            text not null unique,  -- caminho dentro do bucket: {org}/{uuid}.{ext}
  name            text not null,         -- nome original, para a legenda da miniatura
  content_type    text,
  size_bytes      bigint,
  uploaded_by     uuid default auth.uid(),
  created_at      timestamptz not null default now()
);
create index if not exists idx_broadcast_backgrounds_org
  on public.broadcast_backgrounds(organization_id, created_at desc);

alter table public.broadcast_backgrounds enable row level security;

drop policy if exists broadcast_backgrounds_org_isolation on public.broadcast_backgrounds;
create policy broadcast_backgrounds_org_isolation on public.broadcast_backgrounds
  for all to authenticated
  using      ((organization_id = (select public.current_org_id())) or (select public.is_platform_admin()))
  with check ((organization_id = (select public.current_org_id())) or (select public.is_platform_admin()));

drop policy if exists broadcast_backgrounds_exige_mfa on public.broadcast_backgrounds;
create policy broadcast_backgrounds_exige_mfa on public.broadcast_backgrounds
  as restrictive for all to authenticated
  using ((select public.mfa_satisfeito()));

-- 4) Escurecimento sobre a imagem de fundo ----------------------------------
-- Foto clara por trás de um relógio branco fica ilegível. É uma camada escura
-- em %, só aplicada quando há imagem/preset (sobre cor sólida não faz nada).
alter table public.tournament_days
  add column if not exists broadcast_bg_overlay integer default 45;
alter table public.tournament_days
  drop constraint if exists tournament_days_broadcast_bg_overlay_chk;
alter table public.tournament_days
  add constraint tournament_days_broadcast_bg_overlay_chk
  check (broadcast_bg_overlay is null or broadcast_bg_overlay between 0 and 90);
comment on column public.tournament_days.broadcast_bg_overlay is
  'Opacidade (%) da camada escura sobre a imagem/preset de fundo do telão. 0 = sem escurecer.';

-- Conferência ----------------------------------------------------------------
-- select id, public, file_size_limit from storage.buckets where id = 'broadcast-backgrounds';
-- select policyname, permissive from pg_policies where tablename = 'broadcast_backgrounds';
--   -> org_isolation PERMISSIVE + exige_mfa RESTRICTIVE
-- select column_default from information_schema.columns
--   where table_name = 'tournament_days' and column_name = 'broadcast_bg_overlay';  -- 45
