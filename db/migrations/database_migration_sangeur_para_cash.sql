-- ============================================================================
-- SANGEUR: de torneio para CASH GAME
-- ----------------------------------------------------------------------------
-- POR QUE: o sangeur é o papel do CASH. É ele que circula pelas mesas vendendo
-- fichas e cortando a sangria do pote — no torneio a venda acontece no caixa,
-- com o jogador indo até lá. A consignação nasceu ancorada em `stages` porque
-- na época só existia torneio.
--
-- SEGURANÇA DA MUDANÇA: conferido em produção antes de escrever. Só a NextHub
-- (org de teste) tem consignação — 3 registros, todos ainda abertos, de
-- julho/agosto — e o cargo "Sangeur" existe nos 5 clubes com ZERO funcionários.
-- Nenhum cliente opera isto hoje.
--
-- O QUE MUDA NO DINHEIRO, E A ARMADILHA QUE ISSO CRIA
--
-- A venda do sangeur passa a gerar um `rebuy` em `cash_transactions`: sem isso
-- ele vende R$ 500 em fichas na mesa 3 e o DIA não enxerga esse dinheiro —
-- `total_buy_ins` fica curto, a sessão do jogador mostra um resultado que não
-- é o dele, e o fechamento do dia não fecha.
--
-- Só que o dinheiro dessa venda está NO BOLSO DO SANGEUR, não na gaveta. Se a
-- transação fosse espelhada num caixa como qualquer outra, a conferência
-- acusaria falta — o operador seria cobrado por um dinheiro que nunca passou
-- pela mão dele.
--
-- Hoje isso não aconteceria por ACIDENTE: `resolve_cash_transaction_cashbox`
-- procura a gaveta ABERTA de quem lançou, e o sangeur não tem gaveta, tem
-- consignação. Acidente não é garantia: basta alguém acumular os dois papéis
-- para o valor ser contado duas vezes. Por isso `consignment_id` entra na
-- transação e o trigger passa a DESVIAR explicitamente.
--
-- Quem controla esse dinheiro é a própria consignação: `released_amount` são as
-- fichas que saíram, `total_sold` o que virou dinheiro na mão dele, e a
-- reconciliação no fim do turno compara os dois.
--
-- ORDEM: aplicar DEPOIS de database_migration_cash_fase1_core.sql.
-- Reaplicável.
-- ============================================================================

DO $guard$ BEGIN
  IF to_regclass('public.cash_transactions') IS NULL THEN
    RAISE EXCEPTION 'Aplique antes: database_migration_cash_fase1_core.sql';
  END IF;
  IF to_regclass('public.chip_consignments') IS NULL THEN
    RAISE EXCEPTION 'chip_consignments não existe — nada a migrar';
  END IF;
END $guard$;


-- ── 1) A consignação passa a ser do DIA ─────────────────────────────────────
-- `stage_id` fica NULLABLE em vez de sumir: as 3 linhas históricas apontam para
-- uma etapa, e inventar um dia de cash para elas seria falsificar registro.
ALTER TABLE public.chip_consignments ALTER COLUMN stage_id DROP NOT NULL;

ALTER TABLE public.chip_consignments
  ADD COLUMN IF NOT EXISTS cash_day_id UUID
      REFERENCES public.cash_days(id) ON DELETE RESTRICT;

-- Uma âncora, nunca duas nem nenhuma. Vale para as linhas antigas (que têm
-- `stage_id` e não têm `cash_day_id`) e para as novas, ao contrário.
ALTER TABLE public.chip_consignments DROP CONSTRAINT IF EXISTS chip_consignments_ancora;
ALTER TABLE public.chip_consignments ADD CONSTRAINT chip_consignments_ancora
  CHECK (num_nonnulls(stage_id, cash_day_id) = 1);

-- "Uma consignação aberta por sangeur" agora conta por dia. O índice antigo era
-- por etapa e continua valendo para o histórico.
CREATE UNIQUE INDEX IF NOT EXISTS uq_consignacao_aberta_por_dia
  ON public.chip_consignments(sangi_staff_id, cash_day_id)
  WHERE cash_day_id IS NOT NULL AND status = 'open';

CREATE INDEX IF NOT EXISTS idx_chip_consignments_cash_day
  ON public.chip_consignments(cash_day_id) WHERE cash_day_id IS NOT NULL;


-- ── 2) A venda passa a saber ONDE aconteceu e o que gerou ───────────────────
ALTER TABLE public.chip_consignment_sales
  ADD COLUMN IF NOT EXISTS table_id UUID
      REFERENCES public.cash_tables(id) ON DELETE SET NULL,
  -- A transação de cash que esta venda gerou. É o fio que liga o livro do
  -- sangeur ao dinheiro do dia — sem ele, conferir os dois exigiria casar por
  -- valor e horário, que é como se perde dinheiro.
  ADD COLUMN IF NOT EXISTS cash_transaction_id UUID
      REFERENCES public.cash_transactions(id) ON DELETE SET NULL,
  -- Mesma proteção das outras escritas de dinheiro do módulo: duplo clique e
  -- retry não podem virar duas vendas.
  ADD COLUMN IF NOT EXISTS client_mutation_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_venda_consignacao_mutation
  ON public.chip_consignment_sales(organization_id, client_mutation_id)
  WHERE client_mutation_id IS NOT NULL;


-- ── 3) A transação sabe que veio de consignação ─────────────────────────────
ALTER TABLE public.cash_transactions
  ADD COLUMN IF NOT EXISTS consignment_id UUID
      REFERENCES public.chip_consignments(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_cash_transactions_consignment
  ON public.cash_transactions(consignment_id) WHERE consignment_id IS NOT NULL;


-- ── 4) O trigger desvia da gaveta quando a venda é do sangeur ───────────────
-- Único trecho novo: o `IF NEW.consignment_id IS NOT NULL`. O resto é o corpo
-- que já estava lá.
CREATE OR REPLACE FUNCTION public.resolve_cash_transaction_cashbox()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
    v_cashbox_id UUID;
BEGIN
    -- Venda do sangeur: o dinheiro está com ELE, não na gaveta de ninguém.
    -- Quem controla é a consignação (released x sold, conferidos no fim do
    -- turno). Espelhar isto num caixa faria a conferência acusar falta contra
    -- um operador que nunca tocou nesse dinheiro.
    IF NEW.consignment_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    IF NEW.cashbox_id IS NOT NULL OR NEW.created_by IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT c.id INTO v_cashbox_id
      FROM public.cashboxes c
      JOIN public.staff s ON s.id = c.staff_id
     WHERE s.auth_user_id = NEW.created_by
       AND c.cash_day_id = NEW.cash_day_id
       AND c.status = 'open';

    IF v_cashbox_id IS NOT NULL THEN
        NEW.cashbox_id := v_cashbox_id;
    END IF;
    RETURN NEW;
END $function$;


-- ── Conferência ─────────────────────────────────────────────────────────────
-- Âncora única em todas as linhas (deve voltar 0):
--   SELECT count(*) FROM public.chip_consignments
--    WHERE num_nonnulls(stage_id, cash_day_id) <> 1;
--
-- Nenhuma venda de consignação espelhada em gaveta (deve voltar 0):
--   SELECT count(*) FROM public.cash_transactions t
--    JOIN public.cashbox_transactions ct ON ct.cash_transaction_id = t.id
--    WHERE t.consignment_id IS NOT NULL;
