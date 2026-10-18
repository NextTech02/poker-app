-- ============================================================================
-- Cadastro de jogador: obrigatórios só NOME e DOCUMENTO (pedido do NSOP, 18/10)
-- ----------------------------------------------------------------------------
-- E-mail, telefone e nacionalidade passam a ser opcionais. Ausente = NULO
-- (nunca ""): o índice único (email, organization_id) aceita vários nulos, e
-- "" colidiria entre dois jogadores sem e-mail. O backend converte "" em nulo.
-- Jogador sem e-mail só não recebe o pedido de autorização de contatos (LGPD).
--
-- Compatível com o backend anterior (ele sempre manda os três preenchidos).
-- ============================================================================

-- ESTADO EM PRODUÇÃO: aplicada em 2026-10-18 ~21:41 UTC (autorizada pelo
-- usuário com jogo rolando; só DROP NOT NULL, instantânea).

SET lock_timeout = '5s';

ALTER TABLE public.players
  ALTER COLUMN email DROP NOT NULL,
  ALTER COLUMN phone DROP NOT NULL,
  ALTER COLUMN nationality DROP NOT NULL;
