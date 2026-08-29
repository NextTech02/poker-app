-- ============================================================================
-- Meios de entrada por DIA do torneio
-- ============================================================================
-- Já APLICADA em produção (Supabase) em 29/08/2026.
--
-- ANTES: o "tipo de buy" pertencia à ETAPA e servia só para dizer o RAKE. Valor
-- e fichas vinham sempre do dia — estava escrito no código: "Valor sempre do
-- dia; o tipo de buy define apenas o rake".
--
-- Isso impedia o que o cliente precisa: um "rebuy duplo" NÃO é rebuy × 2. É uma
-- venda com valor E quantidade de fichas próprios. Sem coluna de fichas no
-- tipo, não havia onde dizer isso — e por isso o Caixa tinha um campo
-- "quantidade de rebuys", que multiplicava o valor e as fichas do rebuy
-- simples: a conta certa só por acidente.
--
-- AGORA: o meio de entrada pertence ao DIA e carrega nome, valor, rake e
-- fichas. Um torneio de 6 dias pode ter 6 configurações diferentes, que é como
-- o clube opera (o dia final costuma ter buy-in zerado, porque quem chega lá
-- vem classificado).
-- ============================================================================


-- ── 0) Conserto pontual, autorizado pelo dono ───────────────────────────────
-- Na etapa "All Win Poker Club" havia um meio de entrada chamado "Add-on"
-- cadastrado na categoria buy_in. A categoria não é rótulo: é ela que decide
-- qual contador sobe na venda e, portanto, se aquilo soma um JOGADOR NOVO à
-- contagem do torneio. Só a linha sem nenhuma venda é tocada — com venda,
-- mudar a categoria reinterpretaria o passado.
UPDATE public.buy_types bt
   SET category = 'addon', updated_at = now()
 WHERE bt.name = 'Add-on'
   AND bt.category = 'buy_in'
   AND NOT EXISTS (SELECT 1 FROM public.transactions tx WHERE tx.buy_type_id = bt.id);


-- ── 1) O tipo passa a ser do dia, e ganha fichas ────────────────────────────
ALTER TABLE public.buy_types
  ADD COLUMN IF NOT EXISTS tournament_day_id uuid
    REFERENCES public.tournament_days(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS chips integer NOT NULL DEFAULT 0;

-- `stage_id` vira opcional em vez de sumir: vendas já apontam para os tipos
-- antigos, e `transactions.buy_type_id` é ON DELETE SET NULL — apagá-los faria
-- o histórico perder a referência do que foi vendido.
ALTER TABLE public.buy_types ALTER COLUMN stage_id DROP NOT NULL;

-- Todo tipo pertence a UM dos dois: ao dia (novo) ou à etapa (legado). Sem esta
-- guarda, uma linha órfã não apareceria em lugar nenhum e ninguém entenderia
-- por que sumiu do Caixa.
ALTER TABLE public.buy_types DROP CONSTRAINT IF EXISTS buy_types_dono_check;
ALTER TABLE public.buy_types
  ADD CONSTRAINT buy_types_dono_check
  CHECK (tournament_day_id IS NOT NULL OR stage_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_buy_types_dia
  ON public.buy_types (tournament_day_id, sort_order)
  WHERE tournament_day_id IS NOT NULL;

COMMENT ON COLUMN public.buy_types.tournament_day_id IS
  'O dia a que este meio de entrada pertence. Cada dia do torneio configura os seus.';
COMMENT ON COLUMN public.buy_types.chips IS
  'Fichas entregues por esta venda. É o que permite "rebuy duplo" ser uma coisa própria, e não rebuy vezes dois.';
COMMENT ON COLUMN public.buy_types.stage_id IS
  'LEGADO: como os tipos eram guardados antes de pertencerem ao dia. Mantido porque vendas antigas apontam para estas linhas.';


-- ── 2) A venda guarda o que foi vendido, não só a referência ────────────────
-- A transação já guarda `rake_percentage` e `rake_amount` como retrato do
-- momento, em vez de recalcular. As fichas precisam do mesmo tratamento, e por
-- um motivo concreto: o ESTORNO devolve fichas. Se ele fosse ler do tipo na
-- hora de cancelar, um tipo editado depois da venda (10.000 -> 15.000 fichas)
-- faria o estorno devolver mais fichas do que a venda entregou.
--
-- O nome vai junto pelo mesmo motivo: renomear "Buy-in duplo" para "Buy-in
-- casal" reescreveria o histórico, e apagar o tipo (SET NULL) apagaria do
-- recibo a informação do que a pessoa comprou.
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS chips integer,
  ADD COLUMN IF NOT EXISTS buy_type_name varchar(80);

COMMENT ON COLUMN public.transactions.chips IS
  'Fichas entregues nesta venda, congeladas no momento dela. O estorno devolve ESTE número — não o que o tipo diz hoje.';
COMMENT ON COLUMN public.transactions.buy_type_name IS
  'Nome do meio de entrada no momento da venda. Renomear ou apagar o tipo não reescreve o recibo.';


-- ── 3) Cada dia que já existe ganha os seus três meios de entrada ───────────
-- Montados a partir do que o dia JÁ COBRA. Nada muda para quem está operando:
-- o Caixa continua vendendo pelos mesmos valores e entregando as mesmas fichas
-- — a diferença é que agora isso tem nome e pode ser duplicado.
--
-- Onde a etapa já tinha um tipo daquela categoria, o NOME e o RAKE que o clube
-- configurou são preservados: o "Buy-in VIP" com rake de 15% do NSOP PERU não
-- pode virar um "Buy-in" genérico de 20%.
--
-- O `WHERE NOT EXISTS` no fim faz a migração poder rodar de novo sem duplicar.
INSERT INTO public.buy_types
  (tournament_day_id, name, category, amount, rake_percentage, chips,
   active, sort_order, organization_id)
SELECT d.id,
       COALESCE(legado.name, padrao.nome),
       padrao.categoria,
       padrao.valor,
       COALESCE(legado.rake_percentage, d.rake_percentage, 0),
       padrao.fichas,
       true,
       padrao.ordem,
       d.organization_id
  FROM public.tournament_days d
  CROSS JOIN LATERAL (VALUES
      ('buy_in', 'Buy-in', COALESCE(d.buy_in, 0),        COALESCE(d.starting_chips, 0), 0),
      ('rebuy',  'Rebuy',  COALESCE(d.rebuy_amount, 0),  COALESCE(d.rebuy_chips, 0),    1),
      ('addon',  'Add-on', COALESCE(d.addon_amount, 0),  COALESCE(d.addon_chips, 0),    2)
    ) AS padrao(categoria, nome, valor, fichas, ordem)
  LEFT JOIN LATERAL (
      SELECT bt.name, bt.rake_percentage
        FROM public.buy_types bt
        JOIN public.tournaments t ON t.id = d.tournament_id
       WHERE bt.stage_id = t.stage_id
         AND bt.category = padrao.categoria
       ORDER BY bt.sort_order
       LIMIT 1
  ) AS legado ON true
 WHERE NOT EXISTS (
     SELECT 1 FROM public.buy_types x
      WHERE x.tournament_day_id = d.id AND x.category = padrao.categoria
 );


-- ── 4) O estorno passa a devolver as fichas DAQUELA venda ───────────────
-- Está em arquivo próprio, porque é a reescrita de uma função inteira e misturar
-- 130 linhas dela aqui esconderia a mudança de esquema acima:
--
--     db/migrations/database_migration_estorno_fichas_da_venda.sql
--
-- Aplique-o DEPOIS deste (ele depende da coluna `transactions.chips` criada
-- aqui) e depois de database_migration_recompra_desfaz_eliminacao.sql, cuja
-- versão da mesma função ele substitui.
