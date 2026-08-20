-- ============================================================================
-- Unifica o nome do cargo: o grupo "Sangi" também passa a "Sangeur"
-- ============================================================================
-- Complementa database_migration_renomeia_sanger_para_sangeur.sql. Aquela
-- migração trocou "Sanger" -> "Sangeur", mas as organizações não usavam todas o
-- mesmo nome: uma tinha o grupo como "Sanger" e outra como "Sangi" — grafias
-- diferentes para o mesmo cargo, herdadas de versões diferentes do provisiona-
-- mento. O menu já dizia "Sangeur", e a tela de Funcionários continuava
-- mostrando "Sangi".
--
-- Só o RÓTULO muda. A permissão continua sendo a chave `sangi` dentro do array
-- `permissions` — é ela que o backend verifica (chip_consignment_service:
-- "'sangi' in permissions"), e é por isso que o WHERE casa pelo NOME do grupo e
-- nunca pelo conteúdo de `permissions`. Trocar a chave derrubaria o acesso de
-- quem é sangeur no meio de um evento.
--
-- APLICADA EM PRODUÇÃO em 19/08/2026: 1 linha (organização NextHub, 0
-- funcionários no grupo, então ninguém foi afetado).
--
-- IDEMPOTENTE: rodar de novo não encontra mais nenhuma linha.
-- ============================================================================

UPDATE public.permission_groups
   SET name        = 'Sangeur',
       description = 'Vendedor(a) de fichas em consignação (acesso restrito à venda)'
 WHERE name = 'Sangi';

-- Conferência (só leitura) — as duas organizações devem mostrar "Sangeur",
-- e tem_a_permissao precisa continuar true nas duas:
--
--   SELECT pg.name, o.name AS organizacao, 'sangi' = ANY(pg.permissions) AS tem_a_permissao
--     FROM permission_groups pg LEFT JOIN organizations o ON o.id = pg.organization_id
--    WHERE 'sangi' = ANY(pg.permissions) AND pg.name <> 'Admin';
