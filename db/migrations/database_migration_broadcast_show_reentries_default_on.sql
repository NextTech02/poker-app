-- ============================================================================
-- Telão: "Reentradas" passa a nascer LIGADA
-- ============================================================================
-- POR QUE: o layout do telão aprovado pelo cliente (2026-10) tem o tile
-- "Reentradas" fixo na coluna da esquerda, entre "Entradas" e "Intervalo em".
-- A coluna foi criada com DEFAULT false (migração
-- `database_migration_broadcast_show_reentries.sql`) para não mudar o telão de
-- ninguém sem pedido; agora o pedido veio, e o padrão passa a ser o mesmo dos
-- demais interruptores de exibição (ligado; quem não quiser, desliga).
--
-- Os dias existentes com `false` só têm o padrão da época gravado, não uma
-- escolha: o interruptor nunca esteve no ar em produção (o código do telão
-- novo ainda não tinha sido publicado). Por isso eles também viram `true`.
--
-- O frontend lê `!== false` (nulo = ligado), como os outros `broadcast_show_*`.
--
-- IDEMPOTENTE.
-- ============================================================================

ALTER TABLE public.tournament_days
  ALTER COLUMN broadcast_show_reentries SET DEFAULT true;

UPDATE public.tournament_days
   SET broadcast_show_reentries = true
 WHERE broadcast_show_reentries IS DISTINCT FROM true;

COMMENT ON COLUMN public.tournament_days.broadcast_show_reentries IS
  'Telão exibe a contagem de reentradas (recompras + add-ons). Padrão true '
  'desde 2026-10 (tile fixo no layout do cliente); nulo conta como ligado.';
