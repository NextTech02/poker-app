-- SaaS Fase 5 — VAZAMENTO REAL: funções SECURITY DEFINER furavam o RLS.
--
-- Descoberto no teste E2E: logado como um clube RECÉM-CRIADO (zero dados), o
-- dashboard mostrava "10 Torneios Ativos / 2 Jogadores / R$ 3.740,00" — números
-- da OUTRA organização. As listas apareciam corretamente vazias; só os cards
-- vazavam. Ou seja: um cliente veria o faturamento de outro cliente na tela
-- inicial.
--
-- Causa: estas funções são SECURITY DEFINER, então rodam com o privilégio do
-- DONO e ignoram o RLS — não importa quão corretas sejam as políticas.
-- Foram criadas assim para performance (agregação no banco), sem intenção de
-- burlar isolamento, que nem existia na época.
--
-- Correção: SECURITY INVOKER. Elas apenas agregam as próprias tabelas, então
-- passam a enxergar exatamente o que o usuário enxerga — o RLS faz o filtro por
-- organização automaticamente, sem precisar reescrever a lógica.
--
-- A mais grave era bulk_update_chip_counts: é ESCRITA (UPDATE em
-- tournament_players) e, como DEFINER, permitiria alterar as fichas de jogadores
-- de OUTRA organização.
--
-- Mantidas como DEFINER (corretamente, e com EXECUTE restrito):
--   custom_access_token_hook  -> precisa ler staff/platform_admins no login
--   provision_organization    -> precisa escrever em organizations (deny-all)

ALTER FUNCTION public.get_dashboard_stats(uuid)                       SECURITY INVOKER;
ALTER FUNCTION public.get_reports_totals(timestamptz, timestamptz)    SECURITY INVOKER;
ALTER FUNCTION public.get_stage_pending_rake(uuid)                    SECURITY INVOKER;
ALTER FUNCTION public.get_tournament_entry_totals(uuid)               SECURITY INVOKER;
ALTER FUNCTION public.bulk_update_chip_counts(uuid, uuid[], integer[]) SECURITY INVOKER;
