-- ============================================================================
-- Premiação por eliminação: prêmio Mystery registrado À MÃO (kind 'manual')
-- ============================================================================
-- No MISTERY do NSOP (2026-10-14) os envelopes foram abertos na mesa sem a
-- fase Mystery iniciada no sistema: não havia como o caixa pagá-los. O prêmio
-- manual registra quem recebeu e quanto; o pagamento segue o caminho de
-- sempre (caixa geral, transação de prêmio KO).
--
-- Só libera o valor novo na restrição. Compatível com o código atual. Sem FK.
-- ============================================================================
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.tournament_knockouts DROP CONSTRAINT IF EXISTS tournament_knockouts_kind_check;
ALTER TABLE public.tournament_knockouts
  ADD CONSTRAINT tournament_knockouts_kind_check
  CHECK (kind IN ('elimination', 'closing', 'unclaimed', 'manual'));
