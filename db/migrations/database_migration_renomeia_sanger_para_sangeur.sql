-- ============================================================================
-- Renomeia o cargo "Sanger" para "Sangeur"
-- ============================================================================
-- Pedido do dono do clube: o cargo de quem vende fichas em consignação passa a
-- se chamar Sangeur.
--
-- O QUE MUDA: apenas o RÓTULO. A permissão continua sendo a chave `sangi`, que
-- é o que o backend de fato verifica (chip_consignment_service.release: "if
-- 'sangi' not in group.permissions"). Por isso renomear o grupo NÃO afeta
-- nenhuma verificação de acesso — se afetasse, quem é sangeur perderia o
-- direito de receber consignação no meio de um evento.
--
-- DOIS LUGARES, e esquecer o segundo é o erro fácil:
--   1) as linhas de permission_groups que já existem;
--   2) `provision_organization`, que cria os grupos padrão de toda organização
--      NOVA — sem ela, o próximo clube cadastrado nasceria com "Sanger" de novo.
--      Há DUAS sobrecargas da função (com e sem p_plan); as duas citam o nome.
--
-- A troca na função é feita lendo a definição atual e reescrevendo só o texto,
-- em vez de transcrever 2,5 KB de SQL à mão — assim nada mais do corpo muda por
-- descuido.
--
-- ADITIVA e IDEMPOTENTE: rodar de novo não faz nada (não sobra "Sanger").
-- ============================================================================

BEGIN;

-- 1) Grupos que já existem
UPDATE public.permission_groups
   SET name        = replace(name, 'Sanger', 'Sangeur'),
       description = replace(description, 'sanger', 'sangeur')
 WHERE name ILIKE '%sanger%' OR description ILIKE '%sanger%';

-- 2) A função que provisiona organização nova (as duas sobrecargas)
DO $$
DECLARE
  r    record;
  novo text;
BEGIN
  FOR r IN
    SELECT p.oid
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'provision_organization'
       AND pg_get_functiondef(p.oid) LIKE '%Sanger%'
  LOOP
    -- 'Sangeur' não contém 'sanger', então a segunda troca não desfaz a
    -- primeira. E 'sangi' (a chave da permissão) não contém 'sanger',
    -- então ela passa intacta — que é exatamente o que precisa acontecer.
    novo := replace(replace(pg_get_functiondef(r.oid), 'Sanger', 'Sangeur'),
                    'sanger', 'sangeur');
    EXECUTE novo;
  END LOOP;
END $$;

COMMIT;

-- ============================================================================
-- CONFERÊNCIA (só leitura)
-- ============================================================================
--   SELECT name, description FROM public.permission_groups
--    WHERE name ILIKE '%sang%';
--
--   SELECT p.proname, pg_get_functiondef(p.oid) LIKE '%Sanger%' AS ainda_tem_sanger
--     FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
--    WHERE n.nspname='public' AND p.proname='provision_organization';
--   -- esperado: ainda_tem_sanger = false nas duas linhas
-- ============================================================================
