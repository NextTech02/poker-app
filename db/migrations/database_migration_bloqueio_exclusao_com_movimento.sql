-- ============================================================================
-- Exclusão de torneio / dia: recusa no BANCO quando há dinheiro em cima.
--
-- POR QUE NO BANCO, se a API já recusa: porque nem tudo passa pela API. O
-- frontend fala direto com o PostgREST em várias telas, e um script com a
-- chave da service_role atravessa o FastAPI inteiro. A cascata é definida
-- aqui, então a guarda também precisa morar aqui.
--
-- O QUE A CASCATA FAZ HOJE: todas as FKs que apontam para `tournaments` (e
-- para `tournament_days`) são ON DELETE CASCADE. Apagar um torneio leva junto
-- `transactions`, `tournament_players`, `prize_allocations`, `tournament_days`,
-- `blinds`, `seat_allocations` e `tournament_tables`. Some a venda, o dinheiro
-- recebido e o registro de quem pagou — em silêncio.
--
-- E O CAIXA NÃO ACOMPANHA: os gatilhos de caixa da etapa são de INSERT. Apagar
-- a venda não devolve nada; o saldo continua apontando dinheiro cuja origem
-- foi apagada. Resultado prático: a etapa deixa de fechar e ninguém descobre
-- por quê. O conserto certo é CANCELAR a venda (estorno), que devolve o
-- dinheiro ao jogador e acerta o caixa — e só então excluir.
--
-- O QUE CONTA COMO "DINHEIRO EM CIMA": venda com status <> 'cancelled'.
-- 'cancelling' entra de propósito: é um estorno que começou e não terminou;
-- apagar a linha no meio do caminho congela o caixa torto para sempre, porque
-- some justamente o registro que a retomada consulta.
--
-- O QUE ESTA MIGRAÇÃO NÃO QUEBRA:
--   * excluir ETAPA — `tournaments.stage_id` é ON DELETE SET NULL, não cascata;
--   * `delete_organization()` — ela apaga `transactions` ANTES de
--     `tournament_days`/`tournaments`, então quando o gatilho roda já não há
--     venda viva para segurar;
--   * apagar torneio/dia realmente vazio, ou com todas as vendas já estornadas.
--
-- ADITIVA e IDEMPOTENTE: pode rodar mais de uma vez.
-- ============================================================================

-- Rede de segurança: em base onde a migração de cancelamento ainda não rodou,
-- a coluna não existe e a função abaixo estouraria. No-op onde já existe.
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS status VARCHAR(12) NOT NULL DEFAULT 'active';

-- ============================================================
-- 1) Torneio
-- ============================================================
CREATE OR REPLACE FUNCTION public.impedir_exclusao_de_torneio_com_movimento()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_vendas   bigint;
    v_valor    numeric;
    v_pagantes bigint;
BEGIN
    SELECT count(*), COALESCE(sum(amount), 0)
      INTO v_vendas, v_valor
      FROM public.transactions
     WHERE tournament_id = OLD.id
       AND COALESCE(status, 'active') <> 'cancelled';

    -- Nem todo dinheiro deixa rastro em `transactions`: importação, ajuste
    -- manual e base antiga gravam o valor direto na inscrição.
    SELECT count(*)
      INTO v_pagantes
      FROM public.tournament_players
     WHERE tournament_id = OLD.id
       AND COALESCE(status, '') <> 'cancelled'
       AND COALESCE(total_spent, 0) > 0;

    IF v_vendas > 0 OR v_pagantes > 0 THEN
        RAISE EXCEPTION
            'Torneio "%" tem movimento financeiro e não pode ser excluído: % venda(s) somando %, % jogador(es) pago(s). Cancele as vendas no Caixa (o estorno devolve o dinheiro e acerta o caixa da etapa) antes de excluir.',
            OLD.name, v_vendas, v_valor, v_pagantes
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_impedir_exclusao_de_torneio_com_movimento ON public.tournaments;
CREATE TRIGGER trg_impedir_exclusao_de_torneio_com_movimento
    BEFORE DELETE ON public.tournaments
    FOR EACH ROW
    EXECUTE FUNCTION public.impedir_exclusao_de_torneio_com_movimento();

-- ============================================================
-- 2) Dia do torneio — mesmo buraco, uma camada abaixo
-- ============================================================
-- `transactions` não guarda o dia: a venda aponta para a INSCRIÇÃO
-- (`tournament_player_id`), e é ela que sabe o dia. Por isso o caminho é
-- inscrições do dia -> vendas dessas inscrições.
CREATE OR REPLACE FUNCTION public.impedir_exclusao_de_dia_com_movimento()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_vendas   bigint;
    v_valor    numeric;
    v_pagantes bigint;
    v_premios  bigint;
BEGIN
    SELECT count(*), COALESCE(sum(t.amount), 0)
      INTO v_vendas, v_valor
      FROM public.transactions t
      JOIN public.tournament_players tp ON tp.id = t.tournament_player_id
     WHERE tp.tournament_day_id = OLD.id
       AND COALESCE(t.status, 'active') <> 'cancelled';

    SELECT count(*)
      INTO v_pagantes
      FROM public.tournament_players
     WHERE tournament_day_id = OLD.id
       AND COALESCE(status, '') <> 'cancelled'
       AND COALESCE(total_spent, 0) > 0;

    -- Premiação PAGA vale para o torneio inteiro. O pagamento de prêmio não tem
    -- inscrição vinculada, e no dia final os classificados entram sem pagar
    -- (total_spent zero): pelas contas do dia ele pareceria vazio, quando é
    -- justamente o dia em que o dinheiro saiu do caixa geral.
    SELECT count(*)
      INTO v_premios
      FROM public.transactions
     WHERE tournament_id = OLD.tournament_id
       AND type = 'prize'
       AND COALESCE(status, 'active') <> 'cancelled';

    IF v_vendas > 0 OR v_pagantes > 0 OR v_premios > 0 THEN
        RAISE EXCEPTION
            'O dia "%" tem movimento financeiro e não pode ser excluído: % venda(s) somando %, % jogador(es) pago(s), % prêmio(s) pago(s) no torneio. Cancele as vendas no Caixa antes de excluir.',
            OLD.day_name, v_vendas, v_valor, v_pagantes, v_premios
            USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_impedir_exclusao_de_dia_com_movimento ON public.tournament_days;
CREATE TRIGGER trg_impedir_exclusao_de_dia_com_movimento
    BEFORE DELETE ON public.tournament_days
    FOR EACH ROW
    EXECUTE FUNCTION public.impedir_exclusao_de_dia_com_movimento();

-- ============================================================
-- 3) Índices que a guarda usa
-- ============================================================
-- Sem eles cada exclusão vira varredura completa de `transactions`.
CREATE INDEX IF NOT EXISTS idx_transactions_tournament_player
    ON public.transactions(tournament_player_id);
CREATE INDEX IF NOT EXISTS idx_tournament_players_day
    ON public.tournament_players(tournament_day_id);

COMMENT ON FUNCTION public.impedir_exclusao_de_torneio_com_movimento() IS
  'Recusa DELETE de torneio com venda viva ou jogador pago. A cascata apagaria a venda e o registro de quem pagou sem estornar o caixa da etapa (os gatilhos de caixa são só de INSERT), deixando o saldo apontando dinheiro sem origem.';
COMMENT ON FUNCTION public.impedir_exclusao_de_dia_com_movimento() IS
  'Mesma recusa da exclusão de torneio, aplicada ao dia: o dia também é pai de inscrição e, por ela, de venda.';
