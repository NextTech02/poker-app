-- ============================================================================
-- Meios de entrada por TORNEIO
-- ============================================================================
-- ANTES: cada DIA do torneio tinha a própria lista de meios de entrada
-- (`buy_types.tournament_day_id`, migração de 29/08/2026). Antes disso a lista
-- era da ETAPA e só dizia o rake (`stage_id`).
--
-- AGORA: a lista é do TORNEIO (`buy_types.tournament_id`) e vale para todos os
-- seus dias. Pedido do cliente em 07/10/2026: torneios diferentes vendem coisas
-- diferentes, mas os dias do MESMO torneio vendem a mesma coisa — configurar
-- dia a dia repetia a lista N vezes. Flight com valor diferente vira um meio a
-- mais na mesma lista ("Buy-in turbo"), não uma lista à parte.
--
-- `tournament_day_id` e `stage_id` ficam como HISTÓRICO: vendas antigas apontam
-- para essas linhas (`transactions.buy_type_id` é ON DELETE SET NULL) e elas
-- nunca mais são gravadas. Regra de LEGADO no código: `tournament_id IS NULL`
-- (só as linhas antigas da etapa ficam assim — as do dia ganham o torneio aqui).
--
-- DEPLOY: aplicar ANTES do backend/frontend novos (eles leem `tournament_id`).
-- O frontend antigo consulta `tournament_day_id` e segue funcionando até subir.
-- ============================================================================


-- ── Prévia (read-only). Rode ANTES de aplicar, para saber o que vai mudar ───
-- Por torneio: quantas linhas vieram dos dias, quantas são repetição exata de
-- outra linha do mesmo torneio e quantas dessas repetições têm venda.
--
--   WITH r AS (
--     SELECT bt.id, d.tournament_id,
--            ROW_NUMBER() OVER (
--              PARTITION BY d.tournament_id, bt.category, lower(btrim(bt.name)),
--                           bt.amount, bt.rake_percentage, bt.chips
--              ORDER BY bt.active DESC, (d.day_type = 'final'), d.day_number,
--                       bt.created_at, bt.id) AS posicao,
--            EXISTS (SELECT 1 FROM public.transactions tx
--                     WHERE tx.buy_type_id = bt.id) AS vendido
--       FROM public.buy_types bt
--       JOIN public.tournament_days d ON d.id = bt.tournament_day_id)
--   SELECT tournament_id,
--          count(*)                                        AS linhas,
--          count(*) FILTER (WHERE posicao > 1)             AS duplicatas,
--          count(*) FILTER (WHERE posicao > 1 AND vendido) AS duplicatas_com_venda
--     FROM r GROUP BY 1 ORDER BY 2 DESC;
--
-- Guarde também este número; ele tem de ser IGUAL depois (nenhuma venda pode
-- perder a referência do que vendeu):
--   SELECT count(*) FROM public.transactions tx
--    WHERE tx.buy_type_id IS NOT NULL
--      AND NOT EXISTS (SELECT 1 FROM public.buy_types b WHERE b.id = tx.buy_type_id);


-- ── 1) A nova dona ──────────────────────────────────────────────────────────
-- CASCADE, não RESTRICT: `delete_organization()` apaga `tournaments` ANTES de
-- `buy_types` (database_migration_bar_fase2_auditoria.sql) e pararia no meio.
ALTER TABLE public.buy_types
  ADD COLUMN IF NOT EXISTS tournament_id uuid
    REFERENCES public.tournaments(id) ON DELETE CASCADE;


-- ── 2) Cada linha do dia passa a ser do torneio daquele dia ─────────────────
-- As linhas antigas da etapa (sem dia) ficam sem torneio: são o legado.
UPDATE public.buy_types bt
   SET tournament_id = d.tournament_id
  FROM public.tournament_days d
 WHERE bt.tournament_day_id = d.id
   AND bt.tournament_id IS NULL;


-- ── 3) Dedupe: um torneio de 3 dias tinha a mesma lista 3 vezes ─────────────
-- A migração anterior criou Buy-in/Rebuy/Add-on para TODO dia, inclusive o
-- final (com valor 0). Juntas no torneio, "Buy-in" apareceria 3 vezes no Caixa.
--
-- Regra: linhas IGUAIS (categoria, nome, valor, rake, fichas) no mesmo torneio
-- → fica UMA, a guardiã (ativa, de dia não-final, do dia de menor número). As
-- outras SOMEM se nunca foram vendidas e são DESATIVADAS se foram — a mesma
-- regra de `BuyTypeService.substituir`: apagar uma linha vendida tiraria do
-- recibo o que a pessoa comprou. Linhas que diferem em algum valor FICAM
-- ativas: o operador decide na tela do torneio o que é flight e o que é lixo.
--
-- Os gatilhos de auditoria ficam desligados neste passo: é arrumação de dados,
-- não ação de operador, e encheria `activity_logs` com centenas de linhas. A
-- checagem de existência é porque nem toda instalação rodou a migração deles.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname = 'trg_log_buy_types_upd'
                AND tgrelid = 'public.buy_types'::regclass) THEN
    EXECUTE 'ALTER TABLE public.buy_types DISABLE TRIGGER trg_log_buy_types_upd';
    EXECUTE 'ALTER TABLE public.buy_types DISABLE TRIGGER trg_log_buy_types_del';
  END IF;
END $$;

DROP TABLE IF EXISTS _meios_que_sobram;
CREATE TEMP TABLE _meios_que_sobram AS
WITH ranqueados AS (
  SELECT bt.id, bt.tournament_id, bt.category, bt.amount, bt.active,
         (d.day_type = 'final') AS do_final,
         ROW_NUMBER() OVER (
           PARTITION BY bt.tournament_id, bt.category, lower(btrim(bt.name)),
                        bt.amount, bt.rake_percentage, bt.chips
           ORDER BY bt.active DESC, (d.day_type = 'final'), d.day_number NULLS LAST,
                    bt.created_at, bt.id
         ) AS posicao
    FROM public.buy_types bt
    JOIN public.tournament_days d ON d.id = bt.tournament_day_id
   WHERE bt.tournament_id IS NOT NULL
),
duplicatas AS (
  SELECT id FROM ranqueados WHERE posicao > 1
),
-- Sobras do dia final: "Buy-in R$ 0" não é um meio de entrada, é o que a
-- migração anterior inventou para um dia que não vende nada. Só sai quando o
-- torneio tem um buy-in ativo DE VERDADE (valor > 0, de dia não-final) que
-- fica — um torneio que só tenha dia final mantém o que tem.
sobras_do_final AS (
  SELECT r.id
    FROM ranqueados r
   WHERE r.do_final AND r.amount = 0 AND r.posicao = 1
     AND EXISTS (
       SELECT 1 FROM ranqueados g
        WHERE g.tournament_id = r.tournament_id
          AND g.category = 'buy_in' AND g.active AND g.amount > 0
          AND g.posicao = 1 AND NOT g.do_final
     )
)
SELECT s.id,
       EXISTS (SELECT 1 FROM public.transactions tx WHERE tx.buy_type_id = s.id) AS vendido
  FROM (SELECT id FROM duplicatas UNION SELECT id FROM sobras_do_final) s;

DELETE FROM public.buy_types
 WHERE id IN (SELECT id FROM _meios_que_sobram WHERE NOT vendido);

UPDATE public.buy_types
   SET active = false, updated_at = now()
 WHERE active
   AND id IN (SELECT id FROM _meios_que_sobram WHERE vendido);

DROP TABLE _meios_que_sobram;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_trigger
              WHERE tgname = 'trg_log_buy_types_upd'
                AND tgrelid = 'public.buy_types'::regclass) THEN
    EXECUTE 'ALTER TABLE public.buy_types ENABLE TRIGGER trg_log_buy_types_upd';
    EXECUTE 'ALTER TABLE public.buy_types ENABLE TRIGGER trg_log_buy_types_del';
  END IF;
END $$;


-- ── 4) Guarda de dono, índice e comentários ─────────────────────────────────
-- Toda linha pertence a alguém: ao torneio (novo), ao dia ou à etapa (histórico).
-- Sem a guarda, uma linha órfã não apareceria em lugar nenhum e ninguém
-- entenderia por que sumiu do Caixa.
ALTER TABLE public.buy_types DROP CONSTRAINT IF EXISTS buy_types_dono_check;
ALTER TABLE public.buy_types
  ADD CONSTRAINT buy_types_dono_check
  CHECK (tournament_id IS NOT NULL OR tournament_day_id IS NOT NULL OR stage_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_buy_types_torneio
  ON public.buy_types (tournament_id, sort_order)
  WHERE tournament_id IS NOT NULL;

COMMENT ON COLUMN public.buy_types.tournament_id IS
  'O torneio dono deste meio de entrada. A lista vale para todos os dias do torneio.';
COMMENT ON COLUMN public.buy_types.tournament_day_id IS
  'LEGADO: dono anterior (a lista era por dia até 10/2026). Nunca mais gravado; mantido porque vendas antigas apontam para estas linhas.';


-- ── Verificação (depois de aplicar) ─────────────────────────────────────────
-- Nenhuma linha de dia ficou sem torneio:
--   SELECT count(*) FROM public.buy_types
--    WHERE tournament_day_id IS NOT NULL AND tournament_id IS NULL;        -- 0
-- Nenhuma repetição exata ativa sobrou:
--   SELECT tournament_id, category, lower(btrim(name)), amount, rake_percentage, chips, count(*)
--     FROM public.buy_types WHERE active AND tournament_id IS NOT NULL
--    GROUP BY 1,2,3,4,5,6 HAVING count(*) > 1;                             -- 0 linhas
-- Todo torneio com dias tem ao menos um buy-in ativo:
--   SELECT t.id, t.name FROM public.tournaments t
--    WHERE EXISTS (SELECT 1 FROM public.tournament_days d WHERE d.tournament_id = t.id)
--      AND NOT EXISTS (SELECT 1 FROM public.buy_types b
--                       WHERE b.tournament_id = t.id AND b.active AND b.category = 'buy_in');
-- E o número de vendas sem referência é o MESMO da prévia.
