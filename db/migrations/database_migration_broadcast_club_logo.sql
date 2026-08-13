-- Migration: espaço para a LOGO DO CLUBE no canto direito do cabeçalho do telão.
--
-- Segue o padrão de todas as outras configurações de transmissão: por DIA
-- (tournament_days), porque cada dia já tem seu próprio visual configurável em
-- /torneios/:tournamentId/dia/:dayId/broadcast.
--
-- broadcast_club_logo_url é TEXT (não VARCHAR) pelo mesmo motivo de
-- broadcast_bg_image_url: pode guardar uma data: URL base64 do upload, além de
-- uma URL externa colada.
--
-- Aditiva e idempotente. Reversível com DROP COLUMN das 3 colunas.

ALTER TABLE public.tournament_days
  ADD COLUMN IF NOT EXISTS broadcast_club_logo_url  TEXT    DEFAULT NULL;

ALTER TABLE public.tournament_days
  ADD COLUMN IF NOT EXISTS broadcast_show_club_logo BOOLEAN DEFAULT TRUE;

ALTER TABLE public.tournament_days
  ADD COLUMN IF NOT EXISTS broadcast_club_logo_size INTEGER DEFAULT 100;

-- Guarda-corpo: o slider da UI vai de 50% a 300%; o mesmo intervalo é validado
-- no Pydantic (TournamentDayUpdate). A CHECK evita um PATCH fora da faixa
-- deixar a logo com 5000px de altura no telão do salão.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tournament_days_broadcast_club_logo_size_check'
  ) THEN
    ALTER TABLE public.tournament_days
      ADD CONSTRAINT tournament_days_broadcast_club_logo_size_check
      CHECK (broadcast_club_logo_size IS NULL
             OR broadcast_club_logo_size BETWEEN 50 AND 300);
  END IF;
END $$;

COMMENT ON COLUMN public.tournament_days.broadcast_club_logo_url IS
  'Logo DO CLUBE exibida no canto direito do cabecalho do telao (data: URL ou URL externa). A logo do AceBlind, a esquerda, continua sendo broadcast_show_logo.';
COMMENT ON COLUMN public.tournament_days.broadcast_show_club_logo IS
  'Liga/desliga a logo do clube no telao sem apagar a imagem salva.';
COMMENT ON COLUMN public.tournament_days.broadcast_club_logo_size IS
  'Tamanho da logo do clube em %, base 48px (mesma base da logo do AceBlind).';
