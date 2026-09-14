-- ============================================================================
-- AUTENTICAÇÃO EM DOIS FATORES (2FA)
-- ----------------------------------------------------------------------------
-- DESENHO: usa o MFA NATIVO do Supabase (TOTP, app autenticador). Nada de
-- criptografia própria — o `auth.mfa_factors` e as APIs de enroll/challenge/
-- verify já existem no projeto.
--
-- TOTP e não SMS: o SMS do Supabase custa US$ 75/mês por projeto e é vulnerável
-- a SIM swap (o atacante liga para a operadora e porta o número). O TOTP é
-- gratuito, funciona sem sinal e é o padrão dos aplicativos autenticadores.
--
-- REGRA ESCOLHIDA: opt-in. Quem liga passa a ser obrigado; quem não ligou segue
-- entrando só com senha. Isso torna esta migração INERTE no dia em que ela sobe
-- — hoje não há um único fator cadastrado, então a política abaixo não recusa
-- ninguém. É o que permite subir sem parar a operação de 15 funcionários.
--
-- ONDE A REGRA VALE, E POR QUÊ AQUI
--
-- A documentação do Supabase é explícita: "adicionar MFA à interface não
-- oferece, por si só, nenhuma segurança a mais". Uma tela que pede o código não
-- protege nada se a API aceita o token de senha.
--
-- Este backend executa as consultas COMO O USUÁRIO (`SUPABASE_RLS_AS_USER`),
-- então uma política `RESTRICTIVE` no banco cobre as ~385 consultas do sistema
-- de uma vez — inclusive as que ninguém lembrou de proteger. É a única camada
-- que não depende de alguém não esquecer.
--
-- `RESTRICTIVE` é obrigatório e não é detalhe: política PERMISSIVE se soma às
-- outras com OU, então ela seria contornada pela política de organização que já
-- existe. A restritiva se combina com E — ela corta, nunca libera.
--
-- ORDEM: pode ser aplicada a qualquer momento. Reaplicável.
-- ============================================================================


-- ── 1) Códigos de recuperação ───────────────────────────────────────────────
-- POR QUE EXISTEM: quem perde o celular perde a conta. O Supabase não oferece
-- códigos de recuperação prontos — isto é nosso.
--
-- O QUE ELES FAZEM, E O QUE NÃO FAZEM: um código de recuperação NÃO vira
-- `aal2`. Só o `mfa.verify` do Supabase promove a sessão, e ele exige o
-- aparelho. O que o código faz é REMOVER o fator, devolvendo a conta ao estado
-- de senha para a pessoa cadastrar um aparelho novo. É o mesmo poder de quem
-- tem o celular na mão — por isso guardamos só o HASH, um código só serve uma
-- vez, e a remoção fica registrada.
CREATE TABLE IF NOT EXISTS public.mfa_recovery_codes (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    -- SHA-256 do código. O texto puro é mostrado UMA vez, na geração, e nunca
    -- mais existe em lugar nenhum — nem no banco, nem no log.
    code_hash   TEXT NOT NULL,
    used_at     TIMESTAMPTZ,
    used_ip     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mfa_recovery_user
    ON public.mfa_recovery_codes(user_id) WHERE used_at IS NULL;

-- O mesmo código não pode existir duas vezes para a mesma pessoa.
CREATE UNIQUE INDEX IF NOT EXISTS uq_mfa_recovery_hash
    ON public.mfa_recovery_codes(user_id, code_hash);

ALTER TABLE public.mfa_recovery_codes ENABLE ROW LEVEL SECURITY;

-- SEM POLÍTICA PARA `authenticated`, de propósito: RLS ligado e nenhuma
-- política significa que ninguém logado lê ou escreve aqui. Quem confere o
-- código é o BACKEND, com a service_role.
--
-- Não é excesso de zelo: se o usuário pudesse ler a própria linha, um código
-- roubado do navegador teria o mesmo valor do aparelho. E se ele pudesse ler
-- ESTANDO EM aal1 (que é o estado de quem perdeu o celular), a política
-- restritiva do passo 2 o barraria — e o fluxo de recuperação travaria
-- justamente na hora em que ele é necessário.


-- ── 2) A regra: quem tem fator verificado precisa estar em aal2 ────────────
CREATE OR REPLACE FUNCTION public.mfa_satisfeito()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER              -- precisa LER auth.mfa_factors, fora do alcance do usuário
SET search_path = public, auth, pg_temp
AS $$
  -- Opt-in: só exige o segundo fator de quem cadastrou um.
  --
  -- `count(*) = 0` responde "esta pessoa não usa 2FA" e libera; havendo fator
  -- verificado, só passa com `aal2` no token.
  --
  -- O `aal` é claim obrigatório em todo JWT do Supabase, mas o COALESCE fica:
  -- token sem o claim é tratado como aal1, que é o lado seguro.
  SELECT NOT EXISTS (
           SELECT 1 FROM auth.mfa_factors f
            WHERE f.user_id = auth.uid() AND f.status = 'verified'
         )
         OR COALESCE(auth.jwt() ->> 'aal', 'aal1') = 'aal2';
$$;

COMMENT ON FUNCTION public.mfa_satisfeito() IS
  'True quando o usuário não usa 2FA, ou usa e já passou pelo segundo fator. '
  'Usada nas políticas RESTRICTIVE de todas as tabelas.';


-- ── 3) Aplica em todas as tabelas com RLS ──────────────────────────────────
DO $aplica$
DECLARE
  t text;
BEGIN
  FOR t IN
    SELECT c.relname
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relrowsecurity
       -- A tabela dos próprios códigos fica FORA: quem a consulta é o backend
       -- com service_role, e incluí-la criaria o impasse descrito acima.
       AND c.relname <> 'mfa_recovery_codes'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_exige_mfa', t);
    -- `TO authenticated`: o `anon` não é tocado, então a tela pública de TV
    -- (que roda sem sessão) continua funcionando.
    EXECUTE format(
      'CREATE POLICY %I ON public.%I AS RESTRICTIVE TO authenticated '
      'USING ((SELECT public.mfa_satisfeito()))',
      t || '_exige_mfa', t
    );
  END LOOP;
END $aplica$;

-- O `(SELECT ...)` em volta da função não é estilo: é o padrão InitPlan que o
-- resto do projeto usa. Sem ele o Postgres avaliaria a função POR LINHA; com
-- ele, uma vez por statement. A medição do próprio repositório mostrou 340× de
-- diferença na política de organização.


-- ── Conferência ─────────────────────────────────────────────────────────────
-- Toda tabela com RLS tem a política restritiva (deve voltar 0):
--   SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
--    WHERE n.nspname='public' AND c.relkind='r' AND c.relrowsecurity
--      AND c.relname <> 'mfa_recovery_codes'
--      AND NOT EXISTS (SELECT 1 FROM pg_policies p
--                       WHERE p.schemaname='public' AND p.tablename=c.relname
--                         AND p.policyname = c.relname || '_exige_mfa');
--
-- E ela é RESTRICTIVE, não permissiva (deve voltar 0):
--   SELECT policyname FROM pg_policies
--    WHERE schemaname='public' AND policyname LIKE '%_exige_mfa'
--      AND permissive <> 'RESTRICTIVE';
--
-- Hoje ninguém tem fator, então a política não recusa ninguém:
--   SELECT count(*) FROM auth.mfa_factors WHERE status='verified';   -- 0
