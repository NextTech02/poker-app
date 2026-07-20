-- SaaS Fase 4 — app_settings deixa de ser tabela de UMA linha.
--
-- `id` era `integer DEFAULT 1`: a tabela foi desenhada como singleton global
-- (uma única linha de configuração para o sistema inteiro). No multi-tenant há
-- uma linha POR ORGANIZAÇÃO, e o provisionamento da 2ª org falhava com
-- "duplicate key (id)=(1)".
--
-- Passa a usar uma sequência (as irmãs general_cash_register e rake_register já
-- usavam gen_random_uuid(), por isso não deram problema). A sequência começa
-- acima do maior id existente para não colidir com a linha da Org #1.

CREATE SEQUENCE IF NOT EXISTS public.app_settings_id_seq OWNED BY public.app_settings.id;

SELECT setval('public.app_settings_id_seq', GREATEST((SELECT COALESCE(max(id), 0) FROM public.app_settings), 1));

ALTER TABLE public.app_settings ALTER COLUMN id SET DEFAULT nextval('public.app_settings_id_seq');
