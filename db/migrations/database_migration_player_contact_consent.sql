-- ============================================================================
-- Consentimento do jogador para contatos futuros (LGPD)
-- ----------------------------------------------------------------------------
-- Ao ser cadastrado, o jogador recebe um e-mail do clube pedindo autorização
-- para contatos promocionais. Ele responde numa página pública
-- (/consentimento/<token>) — AUTORIZO ou NÃO AUTORIZO.
--
-- players.contact_consent:
--   NULL      nunca pedido (a base anterior a esta migração)
--   'pending' pedido enviado, sem resposta
--   'granted' autorizou     'denied' recusou
-- Só 'granted' permite contato promocional. Quem grava a resposta é o backend
-- (service_role) a partir do token — o operador não edita.
--
-- player_consent_tokens guarda só o HASH (sha256) do token do link: vazou o
-- banco, os links continuam inúteis. RLS ligado e NENHUMA policy permissiva:
-- ninguém além do service_role lê ou grava. O `_exige_mfa` entra mesmo assim,
-- para a conferência "toda tabela com RLS tem a política restritiva" seguir
-- valendo (ver database_migration_bar_fase1b_mfa.sql).
--
-- ORDEM: depois de database_migration_mfa_2fa.sql. Reaplicável.
-- DEPLOY: aplicar ANTES do backend novo. Sem ela o cadastro continua
-- funcionando (o pedido roda em segundo plano e só registra o erro no log),
-- mas nenhum e-mail sai.
-- ============================================================================

DO $guard$ BEGIN
  IF to_regproc('public.mfa_satisfeito') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_mfa_2fa.sql';
  END IF;
END $guard$;

-- ── 1) Estado no jogador ────────────────────────────────────────────────────
ALTER TABLE public.players
  ADD COLUMN IF NOT EXISTS contact_consent              TEXT,
  ADD COLUMN IF NOT EXISTS contact_consent_at           TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contact_consent_requested_at TIMESTAMPTZ;

ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_contact_consent_check;
ALTER TABLE public.players
  ADD CONSTRAINT players_contact_consent_check
  CHECK (contact_consent IS NULL OR contact_consent IN ('pending', 'granted', 'denied'));

COMMENT ON COLUMN public.players.contact_consent IS
  'Autorização para contatos promocionais (LGPD): NULL nunca pedido, pending sem resposta, granted autorizou, denied recusou. Só granted permite contato.';
COMMENT ON COLUMN public.players.contact_consent_at IS
  'Quando o jogador respondeu ao pedido (página pública).';
COMMENT ON COLUMN public.players.contact_consent_requested_at IS
  'Último envio do pedido por e-mail (limita o reenvio).';

-- ── 2) Tokens do link ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.player_consent_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL
                    REFERENCES public.organizations(id) ON DELETE CASCADE,
    player_id       UUID NOT NULL REFERENCES public.players(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL UNIQUE,
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_player_consent_tokens_org    ON public.player_consent_tokens(organization_id);
CREATE INDEX IF NOT EXISTS idx_player_consent_tokens_player ON public.player_consent_tokens(player_id);

ALTER TABLE public.player_consent_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS player_consent_tokens_exige_mfa ON public.player_consent_tokens;
CREATE POLICY player_consent_tokens_exige_mfa ON public.player_consent_tokens
  AS RESTRICTIVE TO authenticated
  USING ((SELECT public.mfa_satisfeito()));

-- ── Conferência ─────────────────────────────────────────────────────────────
--   SELECT column_name FROM information_schema.columns
--    WHERE table_name = 'players' AND column_name LIKE 'contact_consent%';   -- 3 linhas
--   SELECT policyname FROM pg_policies WHERE tablename = 'player_consent_tokens';  -- só _exige_mfa
