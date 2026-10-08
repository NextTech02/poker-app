-- ============================================================================
-- Telão: meios de entrada (valores) abaixo dos blinds + tile "Entradas" com
-- interruptor próprio
-- ============================================================================
-- POR QUE: o cliente quer que o diretor escolha mostrar no telão os meios de
-- entrada do torneio com seus valores ("BUY-IN: 50 · REBUY: 20 · DOBLE: 30 ·
-- ADDON: 50 · TASA: 50"), numa linha entre o relógio e a barra de prêmios.
-- A lista vem dos `buy_types` ATIVOS do torneio, pela rota pública de extras
-- (a TV do salão não tem login).
--
--   broadcast_show_buy_types  default FALSE: é um elemento novo, o diretor
--                             liga se quiser.
--   broadcast_show_entries    default TRUE: o tile "Entradas" (contagem)
--                             sempre acompanhou o de "Jogadores"; agora tem
--                             interruptor próprio, para quem mostra os meios
--                             de entrada poder esconder a contagem.
--
-- Só na resposta/update do backend, nunca na criação do dia.
-- ADITIVA e IDEMPOTENTE.
-- ============================================================================

alter table public.tournament_days
  add column if not exists broadcast_show_buy_types boolean default false;

alter table public.tournament_days
  add column if not exists broadcast_show_entries boolean default true;

comment on column public.tournament_days.broadcast_show_buy_types is
  'Telão mostra os meios de entrada ativos do torneio (nome e valor) abaixo dos blinds. Padrão false.';
comment on column public.tournament_days.broadcast_show_entries is
  'Telão mostra o tile "Entradas" (contagem). NULL = ligado.';
