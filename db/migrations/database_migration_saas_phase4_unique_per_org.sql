-- SaaS Fase 4 — corrige UNIQUEs globais que impediam a 2ª organização de existir.
--
-- Descoberto ao provisionar a primeira organização de teste: falhou com
-- "duplicate key ... permission_groups_name_key", porque o nome do grupo era
-- único no SISTEMA INTEIRO. Ou seja: se a Org #1 tem um grupo "Admin", nenhum
-- outro cliente pode ter. O mesmo valia para formas de pagamento e jogadores.
--
-- Estes 4 índices viram (coluna, organization_id):
--   permission_groups.name      -> cada org tem seu "Admin", "Caixa"...
--   payment_methods.code        -> cada org tem seu 'cash', 'pix'...
--   players.email               -> o mesmo jogador pode estar em clubes diferentes
--   players.(document_type,num) -> idem, por documento
--
-- Os demais UNIQUEs foram auditados e mantidos:
--   * já escopados por uma FK que pertence à org (stage_id, tournament_id,
--     tournament_day_id, staff_id) — não vazam entre organizações;
--   * globais POR DESIGN: staff.auth_user_id (1 usuário = 1 org, decisão do
--     projeto), broadcast_code (código de TV precisa ser único no sistema) e
--     client_id/client_mutation_id (UUIDs do modo offline, únicos globalmente).

ALTER TABLE public.permission_groups DROP CONSTRAINT IF EXISTS permission_groups_name_key;
DROP INDEX IF EXISTS public.permission_groups_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS permission_groups_name_org_key
    ON public.permission_groups (name, organization_id);

ALTER TABLE public.payment_methods DROP CONSTRAINT IF EXISTS payment_methods_code_key;
DROP INDEX IF EXISTS public.payment_methods_code_key;
CREATE UNIQUE INDEX IF NOT EXISTS payment_methods_code_org_key
    ON public.payment_methods (code, organization_id);

ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_email_key;
DROP INDEX IF EXISTS public.players_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS players_email_org_key
    ON public.players (email, organization_id);

ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_document_type_document_number_key;
DROP INDEX IF EXISTS public.players_document_type_document_number_key;
CREATE UNIQUE INDEX IF NOT EXISTS players_document_org_key
    ON public.players (document_type, document_number, organization_id);
