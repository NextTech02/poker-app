-- ============================================================================
-- PAGAMENTO DIVIDIDO ("pago mixto") — uma venda paga com vários meios
-- ----------------------------------------------------------------------------
-- Pedido do cliente: entrada de 500 paga com 300 em dinheiro + 200 em
-- transferência. Vale para o torneio (transactions) e para o cash game
-- (cash_transactions).
--
-- A venda continua sendo UMA linha por item. Relatórios, bolsa, fichas, rake,
-- KO, fidelidade e estorno contam e somam por linha: partir a venda em duas
-- linhas contaria a entrada duas vezes. As partes moram NA linha, em
-- `payment_split`, e o banco confere que elas fecham o valor exato.
--
-- Contrato:
--   payment_split = NULL                -> venda de um meio só (todas as antigas)
--   payment_split = [{"payment_method":"cash","amount":300},
--                    {"payment_method":"transfer","amount":200}]
--                                       -> payment_method = 'split'
-- 'split' é código RESERVADO: um relatório que esquecer de ler as partes
-- mostra um balde "Dividido" em vez de jogar transferência no dinheiro — o pior
-- erro na conferência da gaveta.
--
-- Prod conferido em 2026-10-26: nenhuma linha com payment_method = 'split' em
-- transactions/cash_transactions e nenhum payment_methods.code = 'split'.
--
-- Sem DROP de propósito (o conector do MCP recusa comando destrutivo): os
-- CHECKs entram dentro de DO que confere pg_constraint, então o arquivo é
-- reaplicável. NOT VALID + VALIDATE: o VALIDATE não bloqueia escrita nas
-- tabelas quentes do caixa.
-- ============================================================================

SET lock_timeout = '5s';

-- ----------------------------------------------------------------------------
-- 1) Validação das partes (IMMUTABLE: só olha os argumentos, cabe num CHECK)
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pagamento_dividido_valido(p_split jsonb, p_valor numeric)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN p_split IS NULL OR jsonb_typeof(p_split) <> 'array' THEN false
    WHEN jsonb_array_length(p_split) < 2 THEN false
    -- Cada parte: meio não vazio, diferente de 'split', e valor NUMÉRICO
    -- positivo com até 2 casas. O CASE interno evita converter texto em número
    -- (o Postgres não garante a ordem de avaliação de um OR).
    WHEN EXISTS (
      SELECT 1 FROM jsonb_array_elements(p_split) AS l
       WHERE jsonb_typeof(l) <> 'object'
          OR COALESCE(l ->> 'payment_method', '') IN ('', 'split')
          OR NOT CASE WHEN jsonb_typeof(l -> 'amount') = 'number'
                      THEN (l ->> 'amount')::numeric > 0
                       AND (l ->> 'amount')::numeric = round((l ->> 'amount')::numeric, 2)
                      ELSE false END
    ) THEN false
    -- Meio repetido: o cliente funde antes de mandar.
    WHEN (SELECT count(DISTINCT l ->> 'payment_method') FROM jsonb_array_elements(p_split) AS l)
         <> jsonb_array_length(p_split) THEN false
    ELSE (SELECT sum((l ->> 'amount')::numeric) FROM jsonb_array_elements(p_split) AS l) = p_valor
  END;
$$;

COMMENT ON FUNCTION public.pagamento_dividido_valido(jsonb, numeric) IS
  'Pagamento dividido: >= 2 partes {payment_method, amount}, meios distintos e != split, valores > 0 com 2 casas, soma = valor da linha.';

-- ----------------------------------------------------------------------------
-- 2) Colunas
-- ----------------------------------------------------------------------------
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS payment_split jsonb;
ALTER TABLE public.cash_transactions ADD COLUMN IF NOT EXISTS payment_split jsonb;

COMMENT ON COLUMN public.transactions.payment_split IS
  'Pagamento dividido: [{payment_method, amount}, ...] somando amount; com ele payment_method = ''split''. NULL = um meio só. Agregados por meio leem as partes.';
COMMENT ON COLUMN public.cash_transactions.payment_split IS
  'Pagamento dividido do buy-in/recompra do cash: [{payment_method, amount}, ...] somando amount; com ele payment_method = ''split''. NULL = um meio só.';

-- ----------------------------------------------------------------------------
-- 3) Coerência: 'split' se e só se há partes, e só em venda paga em dinheiro
--    (crédito de patrocinador, ticket e fiado nunca dividem)
-- ----------------------------------------------------------------------------
DO $chk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.transactions'::regclass
                    AND conname = 'transactions_pagamento_dividido') THEN
    ALTER TABLE public.transactions ADD CONSTRAINT transactions_pagamento_dividido CHECK (
      ((payment_method)::text IS NOT DISTINCT FROM 'split') = (payment_split IS NOT NULL)
      AND (payment_split IS NULL OR (
            (type)::text IN ('buy_in', 'rebuy', 'addon')
        AND COALESCE((payment_source)::text, 'cash') = 'cash'
        AND public.pagamento_dividido_valido(payment_split, amount)))
    ) NOT VALID;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.cash_transactions'::regclass
                    AND conname = 'cash_tx_pagamento_dividido') THEN
    ALTER TABLE public.cash_transactions ADD CONSTRAINT cash_tx_pagamento_dividido CHECK (
      ((payment_method)::text IS NOT DISTINCT FROM 'split') = (payment_split IS NOT NULL)
      AND (payment_split IS NULL OR (
            (type)::text IN ('buy_in', 'rebuy')
        AND COALESCE((payment_source)::text, 'cash') = 'cash'
        AND public.pagamento_dividido_valido(payment_split, amount)))
    ) NOT VALID;
  END IF;

  -- O código reservado não pode virar meio cadastrado (o cadastro gera o
  -- código a partir do nome: um meio chamado "Split" colidiria).
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'public.payment_methods'::regclass
                    AND conname = 'payment_methods_codigo_reservado') THEN
    ALTER TABLE public.payment_methods ADD CONSTRAINT payment_methods_codigo_reservado
      CHECK ((code)::text <> 'split') NOT VALID;
  END IF;
END $chk$;

ALTER TABLE public.transactions VALIDATE CONSTRAINT transactions_pagamento_dividido;
ALTER TABLE public.cash_transactions VALIDATE CONSTRAINT cash_tx_pagamento_dividido;
ALTER TABLE public.payment_methods VALIDATE CONSTRAINT payment_methods_codigo_reservado;

-- ----------------------------------------------------------------------------
-- 4) Conferência da gaveta por forma de pagamento lendo as partes
--    MESMA assinatura da vigente em prod (2026-10-26, = cancel_sale.sql): o
--    CREATE OR REPLACE substitui sem DROP. A venda dividida conta em cada meio
--    (entries = partes); a cancelada continua fora.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.get_stage_totals_by_payment_method(p_stage_id uuid)
RETURNS TABLE(payment_method text, total numeric, entries int)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT parte.metodo, sum(parte.valor)::numeric, count(*)::int
  FROM transactions tx
  CROSS JOIN LATERAL (
    SELECT tx.payment_method::text AS metodo, tx.amount AS valor
     WHERE tx.payment_split IS NULL
    UNION ALL
    SELECT l ->> 'payment_method', (l ->> 'amount')::numeric
      FROM jsonb_array_elements(tx.payment_split) AS l
     WHERE tx.payment_split IS NOT NULL
  ) AS parte
  WHERE tx.type IN ('buy_in','rebuy','addon')
    AND COALESCE(tx.status,'active') = 'active'
    AND tx.tournament_id IN (SELECT id FROM tournaments WHERE stage_id = p_stage_id)
  GROUP BY parte.metodo
  ORDER BY sum(parte.valor) DESC;
$$;

-- ----------------------------------------------------------------------------
-- Conferência (rodar depois):
--   SELECT conname, convalidated FROM pg_constraint
--    WHERE conname IN ('transactions_pagamento_dividido','cash_tx_pagamento_dividido',
--                      'payment_methods_codigo_reservado');           -- 3 linhas, todas true
--   SELECT count(*) FROM pg_proc WHERE proname = 'get_stage_totals_by_payment_method';  -- 1
-- ----------------------------------------------------------------------------
