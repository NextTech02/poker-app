-- ============================================================================
-- Telão: garantido do torneio junto do prizepool
-- ============================================================================
-- POR QUE: o clube quer mostrar no telão quanto o torneio garante, separado do
-- prizepool que já entrou. O valor continua sendo `tournaments.guaranteed_prize`,
-- definido na Premiação, e chega à TV pela rota pública de extras.
--
--   broadcast_show_guaranteed  default FALSE: é um elemento novo, o diretor liga
--                              se quiser.
--
-- Rodar ANTES do deploy: a tela de configuração da TV manda este campo em todo
-- salvamento, e sem a coluna o salvamento falha.
-- ADITIVA e IDEMPOTENTE.
-- ============================================================================

alter table public.tournament_days
  add column if not exists broadcast_show_guaranteed boolean default false;

comment on column public.tournament_days.broadcast_show_guaranteed is
  'Telão mostra o garantido do torneio junto do prizepool. Padrão false.';
