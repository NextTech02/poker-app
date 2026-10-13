-- Migration: assentos desativados por mesa
-- Date: 2026-10-13
--
-- O floor precisa tirar um assento de circulação sem mexer no tamanho da
-- mesa: cadeira quebrada, mesa encostada na parede, lugar reservado para o
-- dealer de reforço. Diminuir `seats` não serve — tira sempre o ÚLTIMO
-- assento, e o problema costuma ser o 4 ou o 7.
--
-- A lista fica na própria mesa. Quem escolhe cadeira (alocação automática,
-- em massa, manual e mudança de lugar) pula os números desta lista; o
-- serviço recusa desativar um assento com alguém sentado.
--
-- Compatível com o backend anterior: coluna nova com valor padrão, que o
-- código antigo simplesmente ignora.

ALTER TABLE tournament_tables
  ADD COLUMN IF NOT EXISTS blocked_seats integer[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN tournament_tables.blocked_seats IS
  'Assentos desativados pelo floor; não recebem jogador (números de 1..seats)';
