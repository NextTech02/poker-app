-- Clube novo nasce com categorias do bar, níveis e recompensas da fidelidade
-- no idioma e na moeda dele (achados dos vídeos de suporte, nov/2026).
--
-- O PROBLEMA: provision_organization grava, nesta ordem, a organização, os
-- módulos e só depois app_settings (idioma e moeda). As sementes rodam antes:
--   * loyalty_seed_new_org, no INSERT de organizations, cria Bronze/Prata/Ouro/
--     Diamante e "R$ 25 em crédito" sem saber idioma nem moeda;
--   * bar_seed_on_module, no INSERT de org_modules, procura o idioma em
--     app_settings, não acha e cai no pt-BR.
-- Resultado: o clube colombiano em pesos nascia com "Prata", "Petiscos" e
-- "R$ 25 em crédito".
--
-- A CORREÇÃO, sem reescrever provision_organization nem loyalty_seed_new_org:
--   1) bar_seed_on_module não semeia enquanto o clube não tem app_settings
--      (ele ainda está nascendo);
--   2) um trigger novo, no INSERT de app_settings — o momento em que idioma e
--      moeda passam a existir —, semeia o bar e traduz os níveis e as
--      recompensas que a fidelidade acabou de criar.
--
-- CLUBE EXISTENTE NÃO MUDA. O trigger só traduz linha criada NA MESMA
-- TRANSAÇÃO (created_at = now(), o instante de início da transação), e só se
-- ela ainda tiver o nome padrão em português. Os clubes que já existem
-- continuam com os nomes que têm; a tela traduz os nomes padrão conhecidos na
-- exibição (frontend/src/utils/barRotulos.js e nomesPadraoDaFidelidade.js).
--
-- Os VALORES das recompensas (25/50/100 de crédito, 500/900/1700 pontos) não
-- mudam: a moeda passa a aparecer no nome, mas escalar o valor por moeda é
-- decisão de produto.
--
-- DEPLOY: só banco. Nenhuma tela lê nada novo; antes desta migração o clube
-- novo continua nascendo em português, como hoje.
--
-- Idempotente: CREATE OR REPLACE e DROP TRIGGER IF EXISTS.

DO $$ BEGIN
  IF to_regprocedure('public.bar_categorias_padrao(text)') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_bar_fase1_core.sql';
  END IF;
  IF to_regclass('public.loyalty_tiers') IS NULL OR to_regclass('public.loyalty_rewards') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_loyalty_phase1.sql';
  END IF;
END $$;


-- 1) A semente do bar espera o clube ter idioma -----------------------------
-- Mesmo corpo de database_migration_bar_fase1_core.sql, mais a guarda: sem
-- app_settings o clube ainda está sendo criado, e quem semeia é o trigger de
-- app_settings (passo 2). Para um clube que já existe nada muda — todos têm
-- app_settings.
CREATE OR REPLACE FUNCTION public.bar_seed_on_module()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_idioma text;
BEGIN
    IF NEW.module <> 'bar' OR NOT NEW.enabled THEN
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM public.bar_product_categories WHERE organization_id = NEW.organization_id) THEN
        RETURN NEW;
    END IF;
    SELECT language INTO v_idioma FROM public.app_settings
     WHERE organization_id = NEW.organization_id LIMIT 1;
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.bar_product_categories (organization_id, name, sort_order)
    SELECT NEW.organization_id, c.nome, c.ordem
      FROM public.bar_categorias_padrao(COALESCE(v_idioma, 'pt-BR')) c;
    RETURN NEW;
END $fn$;


-- 2) Quando o idioma e a moeda chegam ---------------------------------------
CREATE OR REPLACE FUNCTION public.padroes_no_idioma_do_clube()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE
    v_idioma text := CASE WHEN NEW.language IN ('pt-BR','en-US','es-ES')
                          THEN NEW.language ELSE 'pt-BR' END;
    v_moeda  text := upper(COALESCE(NULLIF(NEW.currency, ''), 'BRL'));
    v_simbolo text;
BEGIN
    -- Símbolos iguais aos de frontend/src/utils/currencyUtils.js (CURRENCIES).
    v_simbolo := CASE v_moeda
        WHEN 'BRL' THEN 'R$'   WHEN 'USD' THEN 'US$'  WHEN 'EUR' THEN '€'
        WHEN 'ARS' THEN 'AR$'  WHEN 'CLP' THEN 'CLP$' WHEN 'COP' THEN 'COP$'
        WHEN 'PEN' THEN 'S/'   WHEN 'MXN' THEN 'MX$'  WHEN 'PYG' THEN '₲'
        WHEN 'UYU' THEN '$U'   WHEN 'GBP' THEN '£'
        ELSE v_moeda
    END;

    -- Bar: o módulo foi ligado antes de o clube ter idioma (passo 1 adiou a
    -- semente). Mesma regra de bar_seed_on_module: só clube sem categoria.
    IF EXISTS (SELECT 1 FROM public.org_modules
                WHERE organization_id = NEW.organization_id
                  AND module = 'bar' AND enabled)
       AND NOT EXISTS (SELECT 1 FROM public.bar_product_categories
                        WHERE organization_id = NEW.organization_id) THEN
        INSERT INTO public.bar_product_categories (organization_id, name, sort_order)
        SELECT NEW.organization_id, c.nome, c.ordem
          FROM public.bar_categorias_padrao(v_idioma) c;
    END IF;

    -- Fidelidade: níveis criados AGORA por loyalty_seed_new_org, ainda com o
    -- nome padrão. created_at = now() quer dizer "nesta transação".
    IF v_idioma <> 'pt-BR' THEN
        UPDATE public.loyalty_tiers t
           SET name = n.novo
          FROM (VALUES
                  ('en-US', 'Bronze', 'Bronze'), ('en-US', 'Prata', 'Silver'),
                  ('en-US', 'Ouro', 'Gold'),     ('en-US', 'Diamante', 'Diamond'),
                  ('es-ES', 'Bronze', 'Bronce'), ('es-ES', 'Prata', 'Plata'),
                  ('es-ES', 'Ouro', 'Oro'),      ('es-ES', 'Diamante', 'Diamante')
               ) AS n(idioma, padrao, novo)
         WHERE t.organization_id = NEW.organization_id
           AND t.created_at = now()
           AND n.idioma = v_idioma
           AND t.name = n.padrao;
    END IF;

    -- Recompensas "R$ N em crédito": o crédito sai na moeda do clube, então o
    -- nome também. O clube em português que usa real fica exatamente como era.
    IF NOT (v_idioma = 'pt-BR' AND v_moeda = 'BRL') THEN
        UPDATE public.loyalty_rewards r
           SET name = CASE v_idioma
                        WHEN 'en-US' THEN v_simbolo || ' ' || v.valor || ' in credit'
                        WHEN 'es-ES' THEN v_simbolo || ' ' || v.valor || ' en crédito'
                        ELSE v_simbolo || ' ' || v.valor || ' em crédito'
                      END,
               description = CASE v_idioma
                        WHEN 'en-US' THEN v_simbolo || ' ' || v.valor || ' credit at the cashier'
                        WHEN 'es-ES' THEN 'Crédito de ' || v_simbolo || ' ' || v.valor || ' en la caja'
                        ELSE 'Crédito de ' || v_simbolo || ' ' || v.valor || ' no caixa'
                      END
          FROM (VALUES ('25'), ('50'), ('100')) AS v(valor)
         WHERE r.organization_id = NEW.organization_id
           AND r.created_at = now()
           AND r.name = 'R$ ' || v.valor || ' em crédito'
           AND r.credit_value = v.valor::numeric;
    END IF;

    RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_padroes_no_idioma_do_clube ON public.app_settings;
CREATE TRIGGER trg_padroes_no_idioma_do_clube
    AFTER INSERT ON public.app_settings
    FOR EACH ROW EXECUTE FUNCTION public.padroes_no_idioma_do_clube();
