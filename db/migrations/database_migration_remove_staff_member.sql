-- ============================================================================
-- Excluir funcionário de uma organização
-- ============================================================================
-- Pedido: tirar a poluição visual de funcionários que se acumulam na lista, e
-- apagar a conta de acesso quando a pessoa não participa de mais nenhum clube.
--
-- O que o levantamento das chaves estrangeiras mostrou, e que molda a regra:
--
--   staff_payments.staff_id      -> CASCADE   (!) apagar o funcionário apagaria
--                                              os pagamentos dele, que entram
--                                              no DRE. Fecharia etapas com
--                                              resultado diferente do real.
--   cashboxes.staff_id           -> RESTRICT  o banco recusa a exclusão
--   chip_consignments.staff_id   -> RESTRICT  idem
--
-- Por isso a exclusão é CONDICIONAL, decidida pelos dados e não pela tela:
--
--   sem histórico  -> remove de vez (some da lista)
--   com histórico  -> apenas desativa, preservando os livros
--
-- "Sem histórico" ignora os caixas VAZIOS: eles são criados automaticamente,
-- um por etapa, para todo funcionário. Considerá-los histórico impediria
-- excluir qualquer pessoa — inclusive quem nunca chegou a operar.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.remove_staff_member(p_org uuid, p_staff uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_auth   uuid;
    v_nome   text;
    v_mov    int;
    v_pag    int;
    v_cons   int;
    v_outras int;
BEGIN
    SELECT s.auth_user_id, s.name INTO v_auth, v_nome
      FROM public.staff s
     WHERE s.id = p_staff AND s.organization_id = p_org;

    -- `NOT FOUND` sozinho: comparar com NULL aqui daria uma condição NULL, que
    -- não dispara o IF, e a função seguiria com o funcionário inexistente.
    IF NOT FOUND THEN
        RAISE EXCEPTION 'FUNCIONARIO_NAO_ENCONTRADO';
    END IF;

    -- Movimento real: transações lançadas nos caixas dele, ou qualquer sessão
    -- de caixa aberta/fechada. Saldo sozinho não conta como movimento.
    SELECT
      (SELECT count(*) FROM public.transactions t
         WHERE t.cashbox_id IN (SELECT id FROM public.cashboxes WHERE staff_id = p_staff))
      +
      (SELECT count(*) FROM public.cashbox_sessions ss
         WHERE ss.cashbox_id IN (SELECT id FROM public.cashboxes WHERE staff_id = p_staff))
      +
      (SELECT count(*) FROM public.cashbox_transactions ct
         WHERE ct.cashbox_id IN (SELECT id FROM public.cashboxes WHERE staff_id = p_staff))
      INTO v_mov;

    SELECT count(*) INTO v_pag  FROM public.staff_payments   WHERE staff_id      = p_staff;
    SELECT count(*) INTO v_cons FROM public.chip_consignments WHERE sangi_staff_id = p_staff;

    IF (v_mov + v_pag + v_cons) > 0 THEN
        -- Tem histórico: desativa e mantém tudo. Apagar aqui reescreveria
        -- resultados financeiros já apurados.
        UPDATE public.staff
           SET active = false, updated_at = now()
         WHERE id = p_staff;

        RETURN jsonb_build_object(
            'acao', 'desativado', 'nome', v_nome,
            'movimentos', v_mov, 'pagamentos', v_pag, 'consignacoes', v_cons
        );
    END IF;

    -- Sem histórico: os caixas vazios saem junto (senão o RESTRICT barra).
    DELETE FROM public.cashboxes WHERE staff_id = p_staff;
    DELETE FROM public.staff     WHERE id = p_staff;

    -- A conta de acesso só pode sair se a pessoa não estiver em nenhum outro
    -- clube — senão ela perderia o acesso a um trabalho que continua tendo.
    SELECT count(*) INTO v_outras FROM public.staff WHERE auth_user_id = v_auth;

    RETURN jsonb_build_object(
        'acao', 'removido', 'nome', v_nome,
        'auth_user_id', v_auth,
        'ultima_organizacao', (v_outras = 0),
        'outras_organizacoes', v_outras
    );
END $function$;
