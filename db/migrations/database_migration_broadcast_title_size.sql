-- ============================================================================
-- Telão: tamanho do TÍTULO em separado
-- ============================================================================
-- POR QUE: o cliente quer aumentar só o título ("DÍA FINAL") sem mexer na
-- fonte geral do telão. Percentual sobre o tamanho base (58 px no palco),
-- multiplicado pela fonte geral.
--
-- Só na resposta/update do backend, nunca na criação do dia.
-- ADITIVA e IDEMPOTENTE.
-- ============================================================================

alter table public.tournament_days
  add column if not exists broadcast_title_size integer default 100;

alter table public.tournament_days
  drop constraint if exists tournament_days_broadcast_title_size_chk;
alter table public.tournament_days
  add constraint tournament_days_broadcast_title_size_chk
  check (broadcast_title_size is null or broadcast_title_size between 50 and 300);

comment on column public.tournament_days.broadcast_title_size is
  'Tamanho do título do telão em % (50–300, default 100), multiplicado pela fonte geral.';
