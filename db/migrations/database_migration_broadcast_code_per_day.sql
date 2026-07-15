-- Código público de TV POR DIA (antes era por torneio).
-- Um torneio pode ter vários dias (Dia 1, Dia 2, Final...), e cada dia tem sua
-- própria tela de blinds — logo, cada dia precisa do seu próprio código único.
--
-- Aditiva e segura: adiciona a coluna em tournament_days. A antiga
-- tournaments.broadcast_code fica inerte (não é mais usada pelo código);
-- pode ser removida numa limpeza futura se desejado.

ALTER TABLE tournament_days
    ADD COLUMN IF NOT EXISTS broadcast_code TEXT;

-- Unicidade do código entre TODOS os dias (case handled in app: sempre upper).
CREATE UNIQUE INDEX IF NOT EXISTS tournament_days_broadcast_code_key
    ON tournament_days (broadcast_code)
    WHERE broadcast_code IS NOT NULL;
