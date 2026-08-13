-- ============================================================================
-- "Master" de tickets: quem pode emitir vaga em LOTE
-- ----------------------------------------------------------------------------
-- Emitir 40 tickets num clique é uma operação de dono, não de caixa: cada
-- ticket é uma entrada JÁ PAGA que entra no pool do torneio-destino. Um erro
-- no lote multiplica o prejuízo por 40, e quem opera o caixa não tem como
-- desfazer sozinho.
--
-- Não existe nada chamado "master" no sistema. O que separa o dono do clube do
-- operador de caixa hoje é a permissão `employees` (grupo 'Admin' criado pelo
-- provision_organization; os grupos 'Caixa' e 'Sanger' não a têm). Em vez de
-- amarrar "emitir em lote" a "gerenciar equipe" — que são coisas diferentes e
-- um dia o cliente vai querer separar — criamos a chave própria
-- `cashier_tickets.master` e a concedemos a quem já é admin do clube.
--
-- ATENÇÃO: `is_admin` do backend NÃO serve para isso. Ele só é verdadeiro para
-- o super-admin da PLATAFORMA (conta sem linha em `staff` + allowlist), nunca
-- para o dono do clube, que tem linha em `staff`.
-- ============================================================================

-- 1) Backfill: todo grupo que já administra a equipe passa a poder emitir em
--    lote. Sem isso, o dono do clube perderia acesso a um recurso novo no
--    momento do deploy.
UPDATE public.permission_groups
   SET permissions = array_append(permissions, 'cashier_tickets.master'),
       updated_at  = now()
 WHERE 'employees' = ANY(permissions)
   AND NOT ('cashier_tickets.master' = ANY(permissions));

-- 2) Organizações NOVAS já nascem com a chave. É um CREATE OR REPLACE do corpo
--    inteiro (não dá para alterar só o array), copiado de
--    database_migration_saas_phase4_provision_org.sql com a chave nova em
--    v_all_perms.
CREATE OR REPLACE FUNCTION public.provision_organization(
    p_org_name    text,
    p_org_slug    text,
    p_auth_user   uuid,
    p_admin_name  text,
    p_admin_email text,
    p_currency    text DEFAULT 'BRL'
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_org      uuid;
    v_group    uuid;
    -- Mesma lista de ALL_PERMISSIONS do backend (staff_service.py).
    v_all_perms text[] := ARRAY[
        'dashboard','stages','tournaments','players','cashier','cashier_players',
        'cashier_tickets','cashier_tickets.master','prizes','prizes_release',
        'financial','reports','general_cash','rankings','blinds','tables',
        'broadcast','employees','cashbox.operate','cashbox.admin','sangi'
    ];
BEGIN
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_auth_user) THEN
        RAISE EXCEPTION 'Usuário % não existe em auth.users — crie o login antes.', p_auth_user;
    END IF;
    IF EXISTS (SELECT 1 FROM public.staff WHERE auth_user_id = p_auth_user) THEN
        RAISE EXCEPTION 'Usuário % já pertence a uma organização.', p_auth_user;
    END IF;

    INSERT INTO public.organizations (name, slug) VALUES (p_org_name, p_org_slug)
    RETURNING id INTO v_org;

    -- Grupos de permissão padrão
    INSERT INTO public.permission_groups (name, description, permissions, organization_id)
    VALUES ('Admin', 'Acesso total', v_all_perms, v_org)
    RETURNING id INTO v_group;

    INSERT INTO public.permission_groups (name, description, permissions, organization_id) VALUES
      ('Caixa',  'Operação de caixa',        ARRAY['cashier','cashier_tickets','cashier_players','prizes'], v_org),
      ('Sanger', 'Venda de fichas (sanger)', ARRAY['sangi'], v_org);

    -- Dono vira Admin da organização
    INSERT INTO public.staff (auth_user_id, name, email, permission_group_id, active, organization_id)
    VALUES (p_auth_user, p_admin_name, p_admin_email, v_group, true, v_org);

    -- Singletons por organização
    INSERT INTO public.app_settings (currency, organization_id)            VALUES (p_currency, v_org);
    INSERT INTO public.general_cash_register (current_balance, total_received, organization_id) VALUES (0, 0, v_org);
    INSERT INTO public.rake_register (total_rake, organization_id)          VALUES (0, v_org);

    -- Formas de pagamento padrão
    INSERT INTO public.payment_methods (code, label, active, sort_order, organization_id) VALUES
      ('cash',     'Dinheiro',      true, 1, v_org),
      ('card',     'Cartão',        true, 2, v_org),
      ('pix',      'PIX',           true, 3, v_org),
      ('transfer', 'Transferência', true, 4, v_org);

    RETURN v_org;
END $$;

-- Só o backend (service_role) provisiona. Nunca exposto a anon/authenticated.
REVOKE EXECUTE ON FUNCTION public.provision_organization(text,text,uuid,text,text,text) FROM public, anon, authenticated;

-- ----------------------------------------------------------------------------
-- NÃO aplicado de propósito: unicidade (player_id, target_tournament_day_id).
-- Um jogador PODE legitimamente ter duas vagas para o mesmo dia (ganhou em dois
-- satélites e vende uma — ver database_migration_ticket_transfer.sql). Bloquear
-- no banco impediria esse caso real. O lote apenas ignora o MESMO jogador
-- repetido dentro do próprio payload, que é erro de digitação, não operação.
-- ----------------------------------------------------------------------------
