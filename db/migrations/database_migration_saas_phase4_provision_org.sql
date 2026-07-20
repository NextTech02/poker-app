-- SaaS Fase 4 — provisionamento de uma nova organização (cliente).
--
-- Cria, numa única transação, tudo que uma organização precisa para operar:
--   organização + grupos de permissão + o staff Admin do dono + os "singletons"
--   por org (moeda, caixa geral, rake) + formas de pagamento padrão.
--
-- É uma FUNÇÃO no banco (e não código no backend) por dois motivos:
--   1) Atomicidade: ou a organização nasce completa, ou não nasce. Um cliente
--      provisionado pela metade (sem grupo Admin, sem caixa) fica inoperante.
--   2) `organizations` é deny-all no RLS; SECURITY DEFINER permite criar sem
--      abrir a tabela para ninguém.
--
-- O usuário PRECISA existir em auth.users antes (cadastro é feito pelo Supabase
-- Auth). Esta função apenas o vincula como Admin da nova organização.

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
        'cashier_tickets','prizes','prizes_release','financial','reports',
        'general_cash','rankings','blinds','tables','broadcast','employees',
        'cashbox.operate','cashbox.admin','sangi'
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
