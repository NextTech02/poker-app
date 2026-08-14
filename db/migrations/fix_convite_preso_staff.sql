-- ============================================================================
-- Conserto pontual: funcionário preso em "convite pendente"
-- ============================================================================
-- NÃO é migração de esquema — não cria nem altera nada. É um conserto de UMA
-- linha, para rodar à mão no SQL Editor. Depois do deploy do backend + frontend
-- deste conserto, o admin resolve esse estado sozinho pela tela (botões
-- "Efetivar" e "Cancelar convite" na aba Funcionários); este arquivo serve para
-- quem precisa destravar ANTES do deploy.
--
-- Caso: administrativo@nexthubco.com aparece `active = false` +
-- `invite_status = 'pending'` com `auth_user_id` preenchido. A conta já existia
-- (criada em 12/03, último login em 25/03) e o convite deste clube é de 10/08 —
-- ou seja, o vínculo nasceu pendente de propósito, esperando um aceite que
-- nunca teve como acontecer pela tela.
--
-- Escolha UMA das duas saídas. Rode antes o diagnóstico, e confira que a linha
-- devolvida é a que você espera (organização certa!).
-- ============================================================================

-- ── 0) Diagnóstico ──────────────────────────────────────────────────────────
SELECT s.id            AS staff_id,
       s.email,
       s.active,
       s.invite_status,
       s.organization_id,
       o.name          AS organizacao,
       s.created_at    AS convidado_em,
       u.last_sign_in_at
  FROM public.staff s
  JOIN public.organizations o ON o.id = s.organization_id
  LEFT JOIN auth.users u      ON u.id = s.auth_user_id
 WHERE lower(s.email) = lower('administrativo@nexthubco.com');


-- ── SAÍDA A) Efetivar: a pessoa passa a ser membro do clube ─────────────────
-- Equivale ao botão "Efetivar". A vaga do plano é cobrada AQUI, na virada
-- false -> true (é o gatilho `enforce_staff_limit` que decide): se o plano
-- estiver no limite, este UPDATE falha com PLANO_LIMITE_USUARIOS — e aí a
-- decisão é trocar o plano ou usar a saída B.
--
-- UPDATE public.staff
--    SET active = true,
--        invite_status = 'accepted',
--        updated_at = now()
--  WHERE id = '<staff_id do diagnóstico>'
--    AND invite_status = 'pending';   -- trava de segurança: não mexe em membro efetivo


-- ── SAÍDA B) Cancelar o convite: o vínculo some ─────────────────────────────
-- Equivale ao botão "Cancelar convite". Depois disso o mesmo e-mail pode ser
-- convidado de novo (é a chave única (auth_user_id, organization_id) que ficava
-- travada pela linha pendente).
--
-- Os caixas VAZIOS precisam sair ANTES: `cashboxes.staff_id` é ON DELETE
-- RESTRICT e todo convidado com permissão de caixa ganha um caixa por etapa já
-- no convite. Sem isso o DELETE é recusado pelo banco — foi um dos motivos de
-- "cancelar convite" não fazer nada.
--
-- A conta do auth NÃO é apagada: 'pending' é gente que já tem conta e trabalha
-- em outro clube; apagá-la derrubaria o acesso dela lá.
--
-- BEGIN;
--
--   -- Confirme que não há movimento: as três contagens têm de vir zeradas.
--   SELECT
--     (SELECT count(*) FROM public.cashbox_sessions
--       WHERE cashbox_id IN (SELECT id FROM public.cashboxes WHERE staff_id = '<staff_id>')) AS sessoes,
--     (SELECT count(*) FROM public.cashbox_transactions
--       WHERE cashbox_id IN (SELECT id FROM public.cashboxes WHERE staff_id = '<staff_id>')) AS movimentos,
--     (SELECT count(*) FROM public.staff_payments WHERE staff_id = '<staff_id>')             AS pagamentos;
--
--   DELETE FROM public.cashboxes WHERE staff_id = '<staff_id>';
--   DELETE FROM public.staff
--    WHERE id = '<staff_id>'
--      AND invite_status = 'pending';   -- trava de segurança
--
-- COMMIT;
