-- ============================================================================
-- Mystery Bounty conforme o guia do NSOP (Guia_Torneo_Mystery_Bounty)
-- ============================================================================
-- 1. Sorteio FÍSICO: o jogador troca um comprovante por um envelope de verdade
--    no ponto de troca; o staff registra o valor que saiu.
--      tournaments.mystery_draw_mode  'system' (o sistema sorteia) | 'physical'
--      tournament_knockouts.envelope_pending  comprovante ainda não trocado
-- 2. Garantido do fundo Mystery: o fundo é o MAIOR entre o que as entradas
--    juntaram e o garantido (a diferença sai da casa; o pool das posições não
--    muda).                            tournaments.mystery_guarantee
-- 3. A fase Mystery começa no nível X (o sistema avisa o floor).
--                                      tournaments.mystery_start_level
--
-- Compatível com o código atual (colunas com padrão). Sem FK nova.
-- ============================================================================
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS mystery_draw_mode varchar(10) NOT NULL DEFAULT 'system',
  ADD COLUMN IF NOT EXISTS mystery_guarantee numeric(12,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mystery_start_level integer;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_tournaments_mystery_draw_mode') THEN
    ALTER TABLE public.tournaments
      ADD CONSTRAINT chk_tournaments_mystery_draw_mode CHECK (mystery_draw_mode IN ('system', 'physical'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_tournaments_mystery_guarantee') THEN
    ALTER TABLE public.tournaments
      ADD CONSTRAINT chk_tournaments_mystery_guarantee CHECK (mystery_guarantee >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_tournaments_mystery_start_level') THEN
    ALTER TABLE public.tournaments
      ADD CONSTRAINT chk_tournaments_mystery_start_level CHECK (mystery_start_level IS NULL OR mystery_start_level >= 1);
  END IF;
END $$;

ALTER TABLE public.tournament_knockouts
  ADD COLUMN IF NOT EXISTS envelope_pending boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.tournament_knockouts.envelope_pending IS
  'Sorteio físico: o comprovante ainda não foi trocado por um envelope (valor ainda desconhecido).';
