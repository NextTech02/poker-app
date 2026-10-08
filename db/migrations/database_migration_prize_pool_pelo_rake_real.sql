-- ============================================================================
-- Prize pool do dia pelo rake REAL de cada venda
-- ============================================================================
-- O rake é cobrado POR VENDA: cada meio de entrada tem o seu %, e a venda
-- congela `transactions.rake_percentage`/`rake_amount` na hora. Entrada de 100
-- com rake de 20% → 80 vão para a bolsa de prêmios, 20 são o lucro da casa.
-- Premiação (pool = entradas − Σ rake_amount), DRE e sangria já fazem essa conta.
--
-- O que NÃO fazia: o trigger `update_tournament_prize_pool()`, que mantém
-- `tournament_days.prize_pool` (o número da tela do dia, da TV e do avanço de
-- classificados). Ele aplicava o % do DIA sobre o total — e o % do dia é 0
-- desde que o rake passou a morar no meio de entrada (ago/2026). Resultado em
-- produção: um dia com 1.720 de entradas e 344 de rake real mostrava bolsa de
-- 1.720 em vez de 1.376.
--
-- AGORA: pool = Σ (amount − rake_amount) das vendas ativas. O % do dia fica só
-- como reserva para vendas ANTIGAS, anteriores aos meios de entrada, que não
-- têm `rake_amount` gravado. É a mesma conta de `offline/domainRules.js`
-- (bumpStageCashAndPool), que já usava o rake do meio de entrada.
--
-- Mesma assinatura da função: CREATE OR REPLACE basta (não muda a assinatura,
-- então os triggers existentes continuam apontando para ela).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.update_tournament_prize_pool()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
    day_id      UUID;
    rake_do_dia DECIMAL(5, 2);
    pool        DECIMAL(12, 2);
BEGIN
    IF TG_TABLE_NAME = 'tournament_players' THEN
        day_id := COALESCE(NEW.tournament_day_id, OLD.tournament_day_id);
    ELSIF TG_TABLE_NAME = 'transactions' THEN
        SELECT tp.tournament_day_id INTO day_id
          FROM tournament_players tp
         WHERE tp.id = COALESCE(NEW.tournament_player_id, OLD.tournament_player_id);
    END IF;

    IF day_id IS NOT NULL THEN
        SELECT COALESCE(rake_percentage, 0) INTO rake_do_dia
          FROM tournament_days
         WHERE id = day_id;

        -- O rake é o de CADA venda; o % do dia só entra onde a venda antiga
        -- não gravou o seu. Só vendas ativas: a cancelada já devolveu o dinheiro.
        SELECT COALESCE(SUM(t.amount - COALESCE(t.rake_amount, t.amount * rake_do_dia / 100)), 0)
          INTO pool
          FROM transactions t
          JOIN tournament_players tp ON t.tournament_player_id = tp.id
         WHERE tp.tournament_day_id = day_id
           AND t.type IN ('buy_in', 'rebuy', 'addon')
           AND COALESCE(t.status, 'active') = 'active';

        UPDATE tournament_days
           SET prize_pool = pool
         WHERE id = day_id;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$;

-- ── Acerto dos dias que já estão errados ─────────────────────────────────────
-- Só dias que VENDEM entrada. O dia FINAL de torneio classificatório fica de
-- fora: a bolsa dele é a soma das bolsas dos classificatórios, acumulada pelo
-- avanço de classificados (tournament_day_service), não a soma das vendas dele.
UPDATE public.tournament_days d
   SET prize_pool = COALESCE((
         SELECT SUM(t.amount - COALESCE(t.rake_amount, t.amount * COALESCE(d.rake_percentage, 0) / 100))
           FROM public.transactions t
           JOIN public.tournament_players tp ON t.tournament_player_id = tp.id
          WHERE tp.tournament_day_id = d.id
            AND t.type IN ('buy_in', 'rebuy', 'addon')
            AND COALESCE(t.status, 'active') = 'active'), 0)
 WHERE COALESCE(d.day_type, 'regular') <> 'final'
   AND EXISTS (SELECT 1 FROM public.tournament_players tp WHERE tp.tournament_day_id = d.id);

-- ── Verificação ──────────────────────────────────────────────────────────────
-- Nenhum dia (que não seja final) com bolsa diferente de Σ(amount − rake):
--   SELECT d.day_name, d.prize_pool,
--          SUM(t.amount - COALESCE(t.rake_amount, t.amount * d.rake_percentage / 100)) AS certo
--     FROM public.tournament_days d
--     JOIN public.tournament_players tp ON tp.tournament_day_id = d.id
--     JOIN public.transactions t ON t.tournament_player_id = tp.id
--          AND t.type IN ('buy_in','rebuy','addon') AND COALESCE(t.status,'active') = 'active'
--    WHERE COALESCE(d.day_type,'regular') <> 'final'
--    GROUP BY d.id, d.day_name, d.prize_pool, d.rake_percentage
--   HAVING abs(d.prize_pool - SUM(t.amount - COALESCE(t.rake_amount, t.amount * d.rake_percentage / 100))) > 0.01;
--   -- 0 linhas
