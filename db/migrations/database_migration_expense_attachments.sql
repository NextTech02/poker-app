-- ============================================================================
-- Comprovantes de despesa (Supabase Storage)
-- ----------------------------------------------------------------------------
-- Primeiro uso de Storage no projeto. Bucket PRIVADO: comprovante tem nota
-- fiscal, valor e fornecedor — nao pode ficar acessivel por link publico.
-- O download usa URL assinada, com validade curta.
--
-- ISOLAMENTO ENTRE CLUBES: o caminho do arquivo comeca pelo id da organizacao
-- (`{org}/{despesa}/{arquivo}`) e a policy compara essa primeira pasta com
-- `current_org_id()`. Sem isso, qualquer cliente autenticado leria o
-- comprovante de outro clube só adivinhando o caminho.
--
-- A tabela guarda os metadados (nome original, tamanho, quem subiu) para a
-- listagem nao depender da API de Storage a cada render.
-- ============================================================================

-- 1) Bucket privado ----------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'comprovantes', 'comprovantes', false,
  10485760,  -- 10 MB: foto de nota ou PDF cabe com folga
  array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- 2) Policies do Storage — a org do usuário precisa bater com a 1ª pasta ------
drop policy if exists comprovantes_select on storage.objects;
create policy comprovantes_select on storage.objects for select
  using (
    bucket_id = 'comprovantes'
    and (storage.foldername(name))[1] = (select current_org_id())::text
  );

drop policy if exists comprovantes_insert on storage.objects;
create policy comprovantes_insert on storage.objects for insert
  with check (
    bucket_id = 'comprovantes'
    and (storage.foldername(name))[1] = (select current_org_id())::text
  );

drop policy if exists comprovantes_delete on storage.objects;
create policy comprovantes_delete on storage.objects for delete
  using (
    bucket_id = 'comprovantes'
    and (storage.foldername(name))[1] = (select current_org_id())::text
  );

-- 3) Metadados ---------------------------------------------------------------
create table if not exists public.expense_attachments (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null default current_org_id() references public.organizations(id) on delete cascade,
  -- Apagar a despesa leva os metadados junto; o arquivo em si é removido pelo
  -- app antes de excluir a despesa (o Storage não participa do cascade do SQL).
  expense_id      uuid not null references public.expenses(id) on delete cascade,
  path            text not null,        -- caminho dentro do bucket
  file_name       text not null,        -- nome original, para exibir/baixar
  content_type    text,
  size_bytes      bigint,
  uploaded_by     uuid,
  created_at      timestamptz not null default now()
);
create index if not exists idx_expense_attachments_expense on public.expense_attachments(expense_id);

alter table public.expense_attachments enable row level security;
drop policy if exists expense_attachments_org_isolation on public.expense_attachments;
create policy expense_attachments_org_isolation on public.expense_attachments for all
  using ((organization_id = (select current_org_id())) or (select is_platform_admin()))
  with check ((organization_id = (select current_org_id())) or (select is_platform_admin()));
