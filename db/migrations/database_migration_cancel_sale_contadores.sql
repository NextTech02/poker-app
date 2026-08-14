-- ============================================================================
-- Cancelamento de venda — RECIBO do acerto dos CONTADORES do jogador
-- ----------------------------------------------------------------------------
-- Complementa database_migration_cancel_sale_idempotencia.sql, que já resolveu
-- o mesmo problema no caixa da etapa. Falta o contador do jogador e o inscrito
-- do dia.
--
-- O QUE ESTÁ EM JOGO
-- Cancelar um rebuy tem de tirar do jogador UMA recompra: um do `rebuy_count`,
-- o valor do `total_rebuy_amount` e as `rebuy_chips` do dia do `total_chips`.
-- Nem uma a mais, nem uma a menos — as fichas estão na mesa, na frente dele.
-- Cancelar um buy-in tem de desfazer a inscrição e tirar UM inscrito do dia:
-- nem zero (o Caixa recusa o próximo jogador por max_players), nem dois (o
-- Caixa aceita jogador acima do limite da sala).
--
-- Duas tentativas erradas já foram feitas:
--
--   1. Decrementar guardado só por `transactions.cancel_steps`. Esse marcador é
--      gravado DEPOIS do passo, numa segunda chamada, e o backend engole a
--      falha dela de propósito (perder o marcador é menos grave do que perder
--      o estorno inteiro). Marcador perdido + admin clicando "cancelar" de
--      novo = duas recompras descontadas por uma só.
--
--   2. RECONTAR as recompras vivas e gravar o total. Idempotente, mas errado:
--      `add_rebuy` grava rebuy_count/total_chips ANTES de inserir a linha em
--      `transactions`, sem atomicidade. Quando a inserção falha, o contador
--      fica à frente das vendas, e a recontagem faz UM cancelamento tirar DUAS
--      recompras. Pior: ela lê o jogador num instante e as vendas em outro, e
--      uma recompra vendida nessa janela tem as fichas apagadas.
--      (Recontar os INSCRITOS do dia tem furo equivalente: o dia final também
--      recebe os classificados que `_avancar_por_contador` soma sem criar linha
--      em `tournament_players`.)
--
-- A SOLUÇÃO É A MESMA DO CAIXA DA ETAPA: decremento simples (certo em todos os
-- casos) + um RECIBO com chave primária gravado na MESMA instrução que
-- desconta. Ou os dois acontecem, ou nenhum — e a segunda tentativa não
-- desconta nada.
--
-- ADITIVA e IDEMPOTENTE. O backend tolera o schema antigo: sem a função ele cai
-- no decremento direto de hoje (deploy não é atômico com a migração).
-- ============================================================================

-- ============================================================
-- 1) Recibo do acerto dos contadores
--    Uma linha por venda cancelada. É a única prova durável de que aquelas
--    fichas já saíram do jogador (e aquele inscrito, do dia).
-- ============================================================
CREATE TABLE IF NOT EXISTS public.transaction_counter_refunds (
  transaction_id       uuid PRIMARY KEY REFERENCES public.transactions(id) ON DELETE CASCADE,
  tournament_player_id uuid,
  organization_id      uuid,
  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transaction_counter_refunds_tp
  ON public.transaction_counter_refunds(tournament_player_id);

COMMENT ON TABLE public.transaction_counter_refunds IS
  'Recibo do acerto de contadores no cancelamento de uma venda: uma linha por venda. A PK em '
  'transaction_id é o que impede uma retentativa de tirar as mesmas fichas do jogador (ou o mesmo '
  'inscrito do dia) duas vezes.';

GRANT SELECT, INSERT ON TABLE public.transaction_counter_refunds TO authenticated;

ALTER TABLE public.transaction_counter_refunds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS transaction_counter_refunds_org_isolation ON public.transaction_counter_refunds;
CREATE POLICY transaction_counter_refunds_org_isolation ON public.transaction_counter_refunds
  FOR ALL
  USING ((organization_id IS NULL) OR (organization_id = (SELECT current_org_id())) OR (SELECT is_platform_admin()))
  WITH CHECK ((organization_id IS NULL) OR (organization_id = (SELECT current_org_id())) OR (SELECT is_platform_admin()));

-- ============================================================
-- 2) Acerto dos contadores com recibo, numa instrução só
--    O recibo é inserido ANTES do acerto e no MESMO comando: venda já
--    acertada, o ON CONFLICT não insere nada, os UPDATEs não rodam e a função
--    devolve false sem mexer em nada. Isso também cobre o caso em que a
--    resposta HTTP se perde depois do commit.
--    Os UPDATEs são RELATIVOS (`rebuy_count - 1`), nunca "leia e grave o
--    total": uma recompra vendida ao mesmo jogador no mesmo instante continua
--    contando, em vez de ser apagada por um valor calculado de leitura velha.
--    SECURITY INVOKER: roda com o JWT do usuário, então o RLS por organização
--    continua valendo (ver saas_phase5_fix_definer_leak).
-- ============================================================
CREATE OR REPLACE FUNCTION public.undo_entry_counters_once(p_transaction_id uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = public AS $$
DECLARE
  v_tx        public.transactions%rowtype;
  v_dia_id    uuid;
  v_fichas    integer;
  v_inseridos int;
BEGIN
  SELECT * INTO v_tx FROM public.transactions WHERE id = p_transaction_id;
  IF NOT FOUND OR v_tx.tournament_player_id IS NULL THEN
    RETURN false;
  END IF;
  -- COALESCE porque `NULL NOT IN (...)` é NULL, e não TRUE: sem ele uma linha
  -- de tipo nulo escaparia da guarda e cairia no ramo do buy-in.
  IF COALESCE(v_tx.type, '') NOT IN ('buy_in', 'rebuy', 'addon') THEN
    RETURN false;
  END IF;

  INSERT INTO public.transaction_counter_refunds
    (transaction_id, tournament_player_id, organization_id)
  VALUES (p_transaction_id, v_tx.tournament_player_id, v_tx.organization_id)
  ON CONFLICT (transaction_id) DO NOTHING;
  GET DIAGNOSTICS v_inseridos = ROW_COUNT;
  IF v_inseridos = 0 THEN
    RETURN false;   -- já acertada: as fichas (e o inscrito) já saíram uma vez
  END IF;

  SELECT tournament_day_id INTO v_dia_id
    FROM public.tournament_players WHERE id = v_tx.tournament_player_id;

  IF v_tx.type = 'rebuy' THEN
    SELECT COALESCE(rebuy_chips, 0) INTO v_fichas
      FROM public.tournament_days WHERE id = v_dia_id;
    UPDATE public.tournament_players
       SET rebuy_count        = GREATEST(COALESCE(rebuy_count, 0) - 1, 0),
           total_rebuy_amount = GREATEST(COALESCE(total_rebuy_amount, 0) - COALESCE(v_tx.amount, 0), 0),
           total_chips        = GREATEST(COALESCE(total_chips, 0) - COALESCE(v_fichas, 0), 0)
     WHERE id = v_tx.tournament_player_id;
  ELSIF v_tx.type = 'addon' THEN
    SELECT COALESCE(addon_chips, 0) INTO v_fichas
      FROM public.tournament_days WHERE id = v_dia_id;
    UPDATE public.tournament_players
       SET addon_count        = GREATEST(COALESCE(addon_count, 0) - 1, 0),
           total_addon_amount = GREATEST(COALESCE(total_addon_amount, 0) - COALESCE(v_tx.amount, 0), 0),
           total_chips        = GREATEST(COALESCE(total_chips, 0) - COALESCE(v_fichas, 0), 0)
     WHERE id = v_tx.tournament_player_id;
  ELSE
    -- Buy-in: a inscrição inteira é desfeita. `buy_in_count` zera junto com o
    -- valor porque é ELE que todo agregado de ENTRADAS conta — sem isso o dia
    -- mostra 78 entradas com receita de 77.
    UPDATE public.tournament_players
       SET status               = 'cancelled',
           total_buy_in_amount  = 0,
           buy_in_count         = 0,
           total_chips          = 0
     WHERE id = v_tx.tournament_player_id;

    -- O trigger update_tournament_player_count só mexe no inscrito em
    -- INSERT/DELETE da linha; cancelar é UPDATE, então o dia é acertado aqui —
    -- MENOS UM, nunca uma recontagem (ver o cabeçalho).
    IF v_dia_id IS NOT NULL THEN
      UPDATE public.tournament_days
         SET registered_players = GREATEST(COALESCE(registered_players, 0) - 1, 0)
       WHERE id = v_dia_id;
    END IF;
  END IF;

  -- `total_spent` costuma ser recalculado por trigger BEFORE UPDATE; regravado
  -- aqui para o número fechar mesmo onde o trigger não existe.
  UPDATE public.tournament_players
     SET total_spent = COALESCE(total_buy_in_amount, 0)
                     + COALESCE(total_rebuy_amount, 0)
                     + COALESCE(total_addon_amount, 0)
   WHERE id = v_tx.tournament_player_id;

  RETURN true;
END $$;

GRANT EXECUTE ON FUNCTION public.undo_entry_counters_once(uuid) TO authenticated;

COMMENT ON FUNCTION public.undo_entry_counters_once(uuid) IS
  'Desfaz os contadores de UMA venda cancelada (uma recompra, um add-on ou a inscrição do buy-in), uma vez '
  'só por venda. Decremento relativo, para não apagar uma recompra vendida no mesmo instante, e com recibo '
  'na mesma instrução, para a retentativa não tirar as mesmas fichas duas vezes.';

-- Recibos dos contadores JÁ acertados pelo backend anterior a esta migração:
-- sem eles, um "cancelar de novo" numa venda presa em 'cancelling' tiraria as
-- fichas do jogador (ou o inscrito do dia) outra vez.
INSERT INTO public.transaction_counter_refunds
  (transaction_id, tournament_player_id, organization_id)
SELECT tx.id, tx.tournament_player_id, tx.organization_id
  FROM public.transactions tx
 WHERE tx.type IN ('buy_in', 'rebuy', 'addon')
   AND tx.tournament_player_id IS NOT NULL
   AND COALESCE(tx.status, 'active') <> 'active'
   AND 'contadores' = ANY(COALESCE(tx.cancel_steps, ARRAY[]::text[]))
ON CONFLICT (transaction_id) DO NOTHING;
