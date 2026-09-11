-- ============================================================================
-- REALTIME — publica as tabelas da operação ao vivo
-- ----------------------------------------------------------------------------
-- POR QUE: as telas operacionais refaziam TODAS as suas consultas a cada 5
-- segundos. Numa tela como o Caixa isso era `/transactions` + `/tournaments` +
-- `/players` (a lista inteira de jogadores) doze vezes por minuto, por operador
-- logado — e um re-render completo da lista junto. O dado quase sempre voltava
-- idêntico: era trabalho para descobrir que nada mudou.
--
-- Com Realtime o banco AVISA quando muda, e a tela só busca quando há o que
-- buscar. O padrão já existia no sistema para as telas de blind ao vivo
-- (`tournament_days` e `blinds`, únicas publicadas até aqui); isto o estende
-- para o resto da operação.
--
-- NÃO substitui o polling: continua um poll LENTO (30s) como rede de segurança,
-- porque WebSocket cai — troca de rede, suspensão do tablet, proxy que derruba
-- conexão ociosa. Realtime é o caminho rápido, não o único caminho.
--
-- ISOLAMENTO: o Realtime aplica RLS por assinante. As políticas destas tabelas
-- filtram por `organization_id = (SELECT current_org_id())`, e `current_org_id()`
-- lê `request.jwt.claims ->> 'organization_id'` — que o Realtime preenche a
-- partir do JWT da conexão. Um clube não recebe evento do outro.
--
-- REPLICA IDENTITY: deixada no padrão (a chave primária), de propósito. `FULL`
-- faria o Postgres escrever a linha INTEIRA no WAL a cada UPDATE, o que é caro
-- em tabelas largas como `transactions`. O custo disso é que evento de DELETE
-- não carrega `organization_id` e portanto não passa pelo RLS — o poll de 30s é
-- justamente quem cobre esse caso. Aqui isso quase não aparece: cancelamento de
-- venda é estorno lógico (UPDATE), não DELETE.
--
-- ORDEM: aplicar DEPOIS de database_migration_cash_fase3_jackpot.sql.
-- Reaplicável: a função abaixo ignora tabela que já está publicada.
-- ============================================================================

DO $guard$ BEGIN
  IF to_regclass('public.cash_waitlist') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_cash_fase2_waitlist.sql';
  END IF;
END $guard$;


DO $publica$
DECLARE
  t text;
  -- Só o que uma tela ao vivo observa. Tabela de cadastro (players, stages,
  -- payment_methods) fica de fora: muda raramente, e o ganho não paga o custo
  -- de o Realtime avaliar RLS por assinante a cada escrita.
  tabelas text[] := ARRAY[
    -- Torneio
    'transactions',          -- vendas: o Caixa e o extrato
    'tournament_players',    -- inscrições, eliminação, ranking
    'tournament_tables',     -- mesas e realocação
    'tournaments',           -- mudança de status derivada dos dias
    'cashboxes',             -- a tarja de caixa aberto, visível em toda tela
    -- Cash game
    'cash_days',
    'cash_tables',
    'cash_seats',
    'cash_player_sessions',
    'cash_transactions',
    'cash_rake_entries',
    'cash_waitlist'
  ];
BEGIN
  FOREACH t IN ARRAY tabelas LOOP
    IF to_regclass('public.' || t) IS NULL THEN
      RAISE NOTICE 'tabela ausente, ignorada: %', t;
      CONTINUE;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t
    ) THEN
      RAISE NOTICE 'ja publicada: %', t;
      CONTINUE;
    END IF;

    EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    RAISE NOTICE 'publicada: %', t;
  END LOOP;
END $publica$;


-- ── Conferência ─────────────────────────────────────────────────────────────
-- Deve listar as 12 acima mais `blinds` e `tournament_days`:
--   SELECT tablename FROM pg_publication_tables
--    WHERE pubname='supabase_realtime' ORDER BY tablename;
--
-- E nenhuma delas pode estar sem RLS — sem política, o Realtime não entrega
-- nada ao `authenticated`, e a tela ficaria dependendo só do poll de 30s:
--   SELECT c.relname FROM pg_class c
--     JOIN pg_namespace n ON n.oid=c.relnamespace
--    WHERE n.nspname='public' AND c.relrowsecurity = false
--      AND c.relname IN (SELECT tablename FROM pg_publication_tables
--                         WHERE pubname='supabase_realtime');
