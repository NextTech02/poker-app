-- ============================================================================
-- Recompra desfaz eliminação
-- ============================================================================
-- Já APLICADA em produção (Supabase) em 24/08/2026. O arquivo existe para o
-- histórico e para reconstruir o banco do zero.
--
-- O PROBLEMA: a tela de controle mostrava, por extenso,
--   "ENTRADAS 2  -  ELIMINAÇÕES 0  =  JOGADORES ATIVOS 7".
-- As recompras eram SOMADAS aos ativos, em vez de cancelarem uma eliminação.
--
-- A regra correta, nas palavras do dono do clube: com 100 entradas, o jogador X
-- é eliminado e ficam 99 ativos; X recompra e voltam as mesmas 100 entradas com
-- 100 ativos. A recompra não cria jogador nem entrada — ela devolve alguém à
-- mesa.
--
-- O contador `tournament_days.eliminations_count` é genérico: o operador clica
-- "Eliminar 1" e o número sobe, sem dizer quem saiu. Por isso a recompra mexe
-- nele, e não no status de um jogador específico.
--
-- UMA POR VENDA, não por recompra: o jogador que compra 5 recompras de uma vez
-- foi ao caixa UMA vez e sentou UMA vez — comprou mais fichas, não mais
-- cadeiras. Descontar 5 daria 104 jogadores ativos num torneio de 100 entradas.
-- ============================================================================


-- ── 1) A venda da recompra baixa o contador ─────────────────────────────────
-- POR QUE UMA FUNÇÃO, e não um SELECT seguido de UPDATE no Python: duas caixas
-- vendendo recompra ao mesmo tempo leriam o mesmo valor e uma gravaria por cima
-- da outra, perdendo uma volta. Aqui a leitura e a escrita são a mesma
-- instrução.
--
-- O piso em zero importa mais do que parece: recompra sem eliminação registrada
-- é comum (o operador vende a recompra e nunca clicou em "Eliminar"). Sem o
-- GREATEST o contador ficaria negativo e os "ativos" passariam do número de
-- entradas — que é exatamente o defeito que estamos consertando.
--
-- SECURITY INVOKER de propósito: quem chama é o backend com service_role, e
-- esta função não precisa de poder além do de quem a chama.
CREATE OR REPLACE FUNCTION public.desfazer_eliminacoes(p_day_id uuid, p_qtd int)
RETURNS int
LANGUAGE sql
SET search_path = pg_catalog, public
AS $$
  UPDATE public.tournament_days
     SET eliminations_count = GREATEST(COALESCE(eliminations_count, 0) - GREATEST(p_qtd, 0), 0)
   WHERE id = p_day_id
  RETURNING eliminations_count;
$$;

COMMENT ON FUNCTION public.desfazer_eliminacoes(uuid, int) IS
  'Recompra devolve o jogador ao torneio: baixa o contador de eliminações do dia, com piso em zero. Leitura e escrita na mesma instrução, para duas caixas vendendo ao mesmo tempo não perderem uma volta.';


-- ── 2) O estorno da recompra devolve a eliminação ───────────────────────────
-- Simetria: sem ela o telão fica com um jogador ativo a mais PARA SEMPRE, e
-- ninguém percebe — o número está a um dígito do certo.
--
-- Só quando some a ÚLTIMA recompra do jogador. O estorno é POR TRANSAÇÃO, e uma
-- venda de 5 recompras gerou 5 linhas; se cada cancelamento devolvesse 1,
-- sairia 1 e voltariam 5.
--
-- LIMITE CONHECIDO: se o jogador recomprou em VENDAS separadas (três idas ao
-- caixa, três eliminações desfeitas) e todas forem canceladas, isto devolve uma
-- só. O contador fica abaixo do real, e o operador acerta no botão
-- "Eliminar 1". Cancelar recompra é estorno — operação excepcional, sempre
-- conferida — e o caso comum, o do lote vendido de uma vez, fica exato.
--
-- Entra dentro de `undo_entry_counters_once`, e não no Python, por dois
-- motivos: roda na mesma transação do resto do acerto, e herda a guarda que já
-- existe — o recibo em `transaction_counter_refunds` faz a função valer uma vez
-- só, então uma retomada de cancelamento não soma duas eliminações.
--
-- O teto é o total de buy-ins do dia: não pode haver mais gente eliminada do
-- que entrou.
CREATE OR REPLACE FUNCTION public.undo_entry_counters_once(p_transaction_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tx        public.transactions%rowtype;
  v_dia_id    uuid;
  v_fichas    integer;
  v_inseridos int;
  v_restantes int;
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
     WHERE id = v_tx.tournament_player_id
    RETURNING rebuy_count INTO v_restantes;

    -- Só quando não sobra nenhuma recompra o jogador volta a estar fora da mesa
    -- (ver o cabeçalho). Teto no total de buy-ins do dia: não há mais eliminados
    -- do que gente que entrou.
    IF v_dia_id IS NOT NULL AND COALESCE(v_restantes, 0) = 0 THEN
      UPDATE public.tournament_days d
         SET eliminations_count = LEAST(
               COALESCE(d.eliminations_count, 0) + 1,
               (SELECT COALESCE(SUM(COALESCE(tp.buy_in_count, 0)), 0)
                  FROM public.tournament_players tp
                 WHERE tp.tournament_day_id = d.id)
             )
       WHERE d.id = v_dia_id;
    END IF;
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
    -- MENOS UM, nunca uma recontagem.
    IF v_dia_id IS NOT NULL THEN
      UPDATE public.tournament_days
         SET registered_players = GREATEST(COALESCE(registered_players, 0) - 1, 0)
       WHERE id = v_dia_id;

      -- Uma entrada a menos pode deixar o contador de eliminações acima do novo
      -- total. Sem este aparo, "entradas - eliminações" viraria negativo.
      UPDATE public.tournament_days d
         SET eliminations_count = LEAST(
               COALESCE(d.eliminations_count, 0),
               (SELECT COALESCE(SUM(COALESCE(tp.buy_in_count, 0)), 0)
                  FROM public.tournament_players tp
                 WHERE tp.tournament_day_id = d.id)
             )
       WHERE d.id = v_dia_id;
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
END $function$;


-- ── 3) Backfill dos dias que já existem ─────────────────────────────────────
-- Até agora a conta dos ativos era `(buy-ins + recompras) - eliminações`. As
-- recompras JÁ VENDIDAS nunca baixaram nada, então o contador desses dias está
-- inflado exatamente pelo número de recompras.
--
-- Descontar as recompras aqui PRESERVA o número de jogadores ativos que o clube
-- vê hoje: (E + R) - X  ==  E - (X - R). Nenhum torneio em andamento muda de
-- número por causa desta migração — só os que já estavam errados, como um dia
-- que exibia 11 ativos tendo 10 entradas.
UPDATE public.tournament_days d
   SET eliminations_count = LEAST(
         GREATEST(COALESCE(d.eliminations_count, 0) - agg.recompras, 0),
         agg.entradas
       )
  FROM (
    SELECT tp.tournament_day_id AS dia,
           COALESCE(SUM(COALESCE(tp.buy_in_count, 0)), 0) AS entradas,
           COALESCE(SUM(COALESCE(tp.rebuy_count, 0)), 0)  AS recompras
      FROM public.tournament_players tp
     GROUP BY tp.tournament_day_id
  ) agg
 WHERE d.id = agg.dia
   AND COALESCE(d.eliminations_count, 0) <> LEAST(
         GREATEST(COALESCE(d.eliminations_count, 0) - agg.recompras, 0),
         agg.entradas
       );

-- Dias sem nenhum inscrito não podem ter eliminação.
UPDATE public.tournament_days d
   SET eliminations_count = 0
 WHERE COALESCE(d.eliminations_count, 0) > 0
   AND NOT EXISTS (SELECT 1 FROM public.tournament_players tp
                    WHERE tp.tournament_day_id = d.id);
