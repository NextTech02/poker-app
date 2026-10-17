-- ============================================================================
-- Bilhete de inscrição personalizado (pedido do NSOP, 2026-10-17)
-- ----------------------------------------------------------------------------
-- O bilhete impresso no Caixa ganha o layout do clube: imagem no topo (logo),
-- cidade, sede e, se o clube quiser, os enfeites geométricos nos cantos.
--
--   app_settings  padrão do CLUBE (uma linha por organização)
--   tournaments   troca por TORNEIO (nulo = usa o do clube)
--
-- A imagem fica no bucket público `broadcast-backgrounds`, na pasta
-- `<org>/bilhete/` — as políticas do bucket já isolam o clube pela 1ª pasta.
-- Aqui só o CAMINHO do arquivo.
--
-- Compatível com o backend anterior: só colunas novas, com padrão.
-- ============================================================================

SET lock_timeout = '5s';

ALTER TABLE public.app_settings
  ADD COLUMN IF NOT EXISTS ticket_logo_path text,
  ADD COLUMN IF NOT EXISTS ticket_city varchar(80),
  ADD COLUMN IF NOT EXISTS ticket_venue varchar(120),
  ADD COLUMN IF NOT EXISTS ticket_ornaments boolean NOT NULL DEFAULT false;

ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS ticket_logo_path text,
  ADD COLUMN IF NOT EXISTS ticket_city varchar(80),
  ADD COLUMN IF NOT EXISTS ticket_venue varchar(120);

COMMENT ON COLUMN public.app_settings.ticket_logo_path IS
  'Bilhete: imagem do topo (caminho no bucket broadcast-backgrounds, pasta <org>/bilhete/)';
COMMENT ON COLUMN public.app_settings.ticket_ornaments IS
  'Bilhete: enfeites geométricos nos cantos';
COMMENT ON COLUMN public.tournaments.ticket_logo_path IS
  'Bilhete deste torneio: imagem própria (nulo = a do clube)';
