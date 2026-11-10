-- ============================================================================
-- Categorias de despesa e patrocinador "Fidelidade" no idioma do clube
-- ----------------------------------------------------------------------------
-- O PROBLEMA: as categorias de despesa da semente (expense_seed_new_org, de
-- database_migration_expenses_phase1.sql) e o patrocinador de sistema do
-- programa de fidelidade (loyalty_seed_new_org) nascem em português em
-- qualquer clube. O clube do Peru abria Despesas e lia "Aluguel do espaço".
--
-- POR QUE NO INSERT DE app_settings: as sementes rodam no INSERT da
-- organização, e provision_organization só grava o idioma (app_settings)
-- DEPOIS. Na hora da semente o idioma ainda não existe. Este trigger roda no
-- INSERT de app_settings, na mesma transação, e troca para o idioma do clube
-- o que a semente acabou de criar.
--
-- NÃO MEXE EM CLUBE EXISTENTE: só troca o que nasceu NESTA transação
-- (created_at >= now()) e ainda tem o nome padrão em português. O clube que
-- já existe fica como está; a tela de Despesas e a do crédito do jogador
-- mostram os nomes padrão conhecidos no idioma do app.
--
-- Não redefine loyalty_seed_new_org (os níveis e as recompensas da
-- fidelidade são de outra correção): só renomeia o patrocinador que ela criou.
--
-- Reaplicável. Sem dependência de deploy: o backend e o frontend não leem
-- nada que este arquivo crie.
-- ============================================================================


-- ── 1) Categorias de despesa padrão, por idioma ─────────────────────────────
-- A ordem (`ordem`) é a chave entre os idiomas: a categoria 1 em português é
-- a categoria 1 em inglês.
CREATE OR REPLACE FUNCTION public.categorias_despesa_padrao(p_language text DEFAULT 'pt-BR')
RETURNS TABLE(nome text, tipo text, ordem int)
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  WITH escolhido AS (
    SELECT CASE WHEN COALESCE(NULLIF(p_language, ''), 'pt-BR') IN ('pt-BR','en-US','es-ES')
                THEN COALESCE(NULLIF(p_language, ''), 'pt-BR')
                ELSE 'pt-BR' END AS idioma
  )
  SELECT t.nome, t.tipo, t.ordem
    FROM (VALUES
      ('pt-BR', 'Aluguel do espaço',  'fixo',     1),
      ('pt-BR', 'Dealers',            'variavel', 2),
      ('pt-BR', 'Equipe de apoio',    'variavel', 3),
      ('pt-BR', 'Alimentação',        'variavel', 4),
      ('pt-BR', 'Marketing',          'variavel', 5),
      ('pt-BR', 'Material',           'variavel', 6),
      ('pt-BR', 'Estrutura',          'variavel', 7),
      ('pt-BR', 'Taxas e impostos',   'variavel', 8),
      ('pt-BR', 'Outros',             'variavel', 9),
      ('en-US', 'Venue rent',         'fixo',     1),
      ('en-US', 'Dealers',            'variavel', 2),
      ('en-US', 'Support staff',      'variavel', 3),
      ('en-US', 'Food and drinks',    'variavel', 4),
      ('en-US', 'Marketing',          'variavel', 5),
      ('en-US', 'Supplies',           'variavel', 6),
      ('en-US', 'Setup',              'variavel', 7),
      ('en-US', 'Fees and taxes',     'variavel', 8),
      ('en-US', 'Other',              'variavel', 9),
      ('es-ES', 'Alquiler del local', 'fixo',     1),
      ('es-ES', 'Dealers',            'variavel', 2),
      ('es-ES', 'Personal de apoyo',  'variavel', 3),
      ('es-ES', 'Alimentación',       'variavel', 4),
      ('es-ES', 'Marketing',          'variavel', 5),
      ('es-ES', 'Materiales',         'variavel', 6),
      ('es-ES', 'Estructura',         'variavel', 7),
      ('es-ES', 'Tasas e impuestos',  'variavel', 8),
      ('es-ES', 'Otros',              'variavel', 9)
    ) AS t(idioma, nome, tipo, ordem)
    JOIN escolhido e ON e.idioma = t.idioma
   ORDER BY t.ordem;
$$;


-- ── 2) A semente passa a usar a lista (o resultado em português não muda) ──
-- Se um dia a organização nascer com app_settings já gravado, a semente sai
-- direto no idioma dele.
CREATE OR REPLACE FUNCTION public.expense_seed_new_org()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_idioma text;
BEGIN
  SELECT language INTO v_idioma FROM public.app_settings WHERE organization_id = NEW.id LIMIT 1;
  INSERT INTO public.expense_categories (organization_id, name, kind, sort_order)
  SELECT NEW.id, c.nome, c.tipo, c.ordem
    FROM public.categorias_despesa_padrao(COALESCE(v_idioma, 'pt-BR')) c;
  RETURN NEW;
END $$;


-- ── 3) No INSERT do idioma, o que a semente acabou de criar vai para ele ────
CREATE OR REPLACE FUNCTION public.textos_padrao_no_idioma_do_clube()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF NEW.organization_id IS NULL OR COALESCE(NEW.language, 'pt-BR') = 'pt-BR' THEN
    RETURN NEW;
  END IF;

  UPDATE public.expense_categories c
     SET name = alvo.nome
    FROM public.categorias_despesa_padrao('pt-BR') pt
    JOIN public.categorias_despesa_padrao(NEW.language) alvo ON alvo.ordem = pt.ordem
   WHERE c.organization_id = NEW.organization_id
     AND c.name = pt.nome
     AND c.sort_order = pt.ordem
     AND c.created_at >= now();

  IF to_regclass('public.loyalty_settings') IS NOT NULL THEN
    UPDATE public.sponsors s
       SET name = CASE NEW.language WHEN 'en-US' THEN 'Loyalty' ELSE 'Fidelidad' END
      FROM public.loyalty_settings ls
     WHERE ls.organization_id = NEW.organization_id
       AND s.id = ls.system_sponsor_id
       AND s.name = 'Fidelidade'
       AND s.created_at >= now();
  END IF;

  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_app_settings_textos_padrao ON public.app_settings;
CREATE TRIGGER trg_app_settings_textos_padrao
  AFTER INSERT ON public.app_settings
  FOR EACH ROW EXECUTE FUNCTION public.textos_padrao_no_idioma_do_clube();


-- ── 4) Conferência ──────────────────────────────────────────────────────────
--   SELECT * FROM public.categorias_despesa_padrao('es-ES');
--   SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.app_settings'::regclass AND NOT tgisinternal;
-- Depois de criar um clube em espanhol:
--   SELECT name FROM public.expense_categories WHERE organization_id = '<id>' ORDER BY sort_order;
