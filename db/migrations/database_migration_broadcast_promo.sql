-- ============================================================================
-- Telão: divulgação (imagem ou vídeo) na coluna da direita
-- ============================================================================
-- POR QUE: o layout novo do telão deixou a coluna da direita vazia (ela só
-- existe para o relógio ficar no centro da tela). O cliente pediu para o
-- diretor poder usar esse espaço com uma peça de divulgação do clube:
-- imagem da biblioteca (Storage), vídeo direto (.mp4/.webm) ou YouTube.
--
--   broadcast_promo_url   texto: URL pública da biblioteca, URL externa de
--                         imagem/vídeo, ou link do YouTube. Vazio/NULL = sem
--                         divulgação (a coluna fica como está).
--   broadcast_show_promo  interruptor (default true: quem preencheu a URL
--                         quer ver; desliga sem apagar a peça).
--   broadcast_promo_fit   'contain' (inteira, sem cortar) | 'cover'
--                         (preenche a coluna, pode cortar as bordas).
--
-- Só na resposta/update do backend, nunca na criação do dia (a criação
-- grava o modelo inteiro e não pode depender da coluna existir).
--
-- ADITIVA e IDEMPOTENTE.
-- ============================================================================

alter table public.tournament_days
  add column if not exists broadcast_promo_url text;

alter table public.tournament_days
  add column if not exists broadcast_show_promo boolean default true;

alter table public.tournament_days
  add column if not exists broadcast_promo_fit text default 'contain';

alter table public.tournament_days
  drop constraint if exists tournament_days_broadcast_promo_fit_chk;
alter table public.tournament_days
  add constraint tournament_days_broadcast_promo_fit_chk
  check (broadcast_promo_fit is null or broadcast_promo_fit in ('contain', 'cover'));

comment on column public.tournament_days.broadcast_promo_url is
  'Divulgação na coluna da direita do telão: URL de imagem (biblioteca ou externa), de vídeo (.mp4/.webm) ou do YouTube. NULL = sem divulgação.';
comment on column public.tournament_days.broadcast_show_promo is
  'Mostra a divulgação no telão (NULL = ligado). Desligar não apaga a URL.';
comment on column public.tournament_days.broadcast_promo_fit is
  'Como a peça preenche a coluna: contain (inteira) ou cover (preenche, pode cortar).';
