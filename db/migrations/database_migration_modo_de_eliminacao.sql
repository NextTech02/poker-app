-- ============================================================================
-- Modo de eliminação do torneio: por posição nas mesas ou em massa
-- ============================================================================
-- Já APLICADA em produção (Supabase, projeto App Poker) em 08/10/2026, como a
-- migração `modo_de_eliminacao`. Os 30 torneios existentes ficaram em 'bulk' e
-- nenhum contador de eliminações mudou.
--
-- APLICAR NO SUPABASE ANTES DO DEPLOY DO BACKEND: `create_tournament` grava o
-- modelo inteiro, e um backend novo contra um banco sem a coluna recusaria a
-- criação de torneios.
--
-- ORDEM DE APLICAÇÃO: depois de database_migration_estorno_fichas_da_venda.sql
-- (esta é a nova versão VIGENTE de `undo_entry_counters_once`, que parte
-- daquela e mantém as fichas da venda) e de
-- database_migration_summary_torneio_jogadores.sql (idem para
-- `get_tournament_summary`).
--
-- A REGRA, nas palavras do diretor:
--   * toda ENTRADA (buy-in) soma um jogador;
--   * toda REENTRADA (rebuy) traz de volta UM jogador eliminado;
--   * ADD-ON não conta para nada além de fichas e dinheiro;
--   * na tela aparecem só ENTRADAS e REENTRADAS.
--
--   ENTRADAS   = Σ buy_in_count + classificados vindos de outro dia
--   REENTRADAS = Σ rebuy_count            (add-on NÃO entra)
--   ATIVOS     = ENTRADAS − eliminations_count
--
-- Os DOIS MODOS seguem a mesma conta; muda só QUEM mexe no contador:
--   * 'bulk'  (em massa)  — o diretor clica "Eliminar 1 / Eliminar N" no
--     Controle. O contador não sabe QUEM saiu, então a reentrada exige apenas
--     que haja alguém eliminado (contador > 0).
--   * 'table' (por mesa)  — o diretor elimina o jogador no assento. O contador
--     passa a ser SEMPRE a contagem de inscritos com status 'eliminated'
--     (`recontar_eliminacoes`), e a reentrada exige que AQUELE jogador esteja
--     eliminado.
--
-- Torneios que já existem ficam em 'bulk': é o único modo que a tela oferecia.
-- ============================================================================


-- ── 1) A escolha do diretor ─────────────────────────────────────────────────
ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS elimination_mode VARCHAR(10) NOT NULL DEFAULT 'bulk';

DO $$
BEGIN
  ALTER TABLE public.tournaments
    ADD CONSTRAINT chk_tournaments_elimination_mode
    CHECK (elimination_mode IN ('table', 'bulk'));
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

COMMENT ON COLUMN public.tournaments.elimination_mode IS
  'Como o diretor elimina jogadores: ''table'' (no assento, jogador a jogador) ou ''bulk'' (contador em massa no Controle).';


-- ── 2) ENTRADAS do dia: o teto de toda eliminação ───────────────────────────
-- Buy-ins MAIS os classificados: quem chega ao dia final vem com
-- buy_in_count = 0 (a entrada foi cobrada no classificatório), e sem contá-los
-- o dia final mostrava ~0 jogadores ativos e não aceitava nenhuma eliminação.
--
-- No dia final avançado pelo CONTADOR não há linha de classificado nenhuma —
-- só `registered_players` somado à mão. Por isso, no final, vale o maior dos
-- dois.
CREATE OR REPLACE FUNCTION public.entradas_do_dia(p_day_id uuid)
RETURNS int
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT GREATEST(
    COALESCE((
      SELECT SUM(COALESCE(tp.buy_in_count, 0))
           + COUNT(*) FILTER (WHERE tp.is_qualified_entry
                                AND COALESCE(tp.status, '') <> 'cancelled')
        FROM public.tournament_players tp
       WHERE tp.tournament_day_id = p_day_id
    ), 0),
    COALESCE((
      SELECT CASE WHEN d.day_type = 'final'
                  THEN COALESCE(d.registered_players, 0) ELSE 0 END
        FROM public.tournament_days d
       WHERE d.id = p_day_id
    ), 0)
  )::int;
$$;

COMMENT ON FUNCTION public.entradas_do_dia(uuid) IS
  'ENTRADAS do dia (buy-ins + classificados; no dia final, nunca menos que registered_players). Teto do contador de eliminações.';


-- ── 3) Reentrada em massa: consome UMA eliminação, ou recusa ────────────────
-- A trava e a baixa são a MESMA instrução: duas caixas vendendo reentrada com
-- o contador em 1 não passam as duas — a segunda recebe false e a venda é
-- recusada antes de cobrar.
CREATE OR REPLACE FUNCTION public.consumir_eliminacao(p_day_id uuid)
RETURNS boolean
LANGUAGE sql
SET search_path = pg_catalog, public
AS $$
  WITH baixa AS (
    UPDATE public.tournament_days
       SET eliminations_count = eliminations_count - 1
     WHERE id = p_day_id
       AND COALESCE(eliminations_count, 0) > 0
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM baixa);
$$;

COMMENT ON FUNCTION public.consumir_eliminacao(uuid) IS
  'Reentrada no modo em massa: baixa uma eliminação do dia se houver alguma; false quando não há eliminado para voltar.';


-- ── 4) Eliminação em massa: soma (ou desfaz) N, entre 0 e as ENTRADAS ───────
-- Substitui o "lê, soma no Python, grava" de adjust_eliminations, que perdia
-- um clique quando dois operadores eliminavam ao mesmo tempo.
CREATE OR REPLACE FUNCTION public.registrar_eliminacao(p_day_id uuid, p_qtd int)
RETURNS int
LANGUAGE sql
SET search_path = pg_catalog, public
AS $$
  UPDATE public.tournament_days d
     SET eliminations_count = LEAST(
           GREATEST(COALESCE(d.eliminations_count, 0) + COALESCE(p_qtd, 0), 0),
           public.entradas_do_dia(d.id)
         )
   WHERE d.id = p_day_id
  RETURNING eliminations_count;
$$;

COMMENT ON FUNCTION public.registrar_eliminacao(uuid, int) IS
  'Soma (ou, negativo, desfaz) eliminações do dia, com piso 0 e teto nas ENTRADAS do dia.';


-- ── 5) Modo mesa: o contador É a contagem de eliminados ─────────────────────
-- Recontar, e não somar 1: um clique duplo, um replay offline ou um estorno
-- nunca deixam o número descolado da lista de eliminados.
--
-- plpgsql de propósito: a trava da linha do dia vem ANTES da contagem, e cada
-- instrução tira um retrato novo — duas eliminações simultâneas terminam com
-- a contagem que inclui as duas.
CREATE OR REPLACE FUNCTION public.recontar_eliminacoes(p_day_id uuid)
RETURNS int
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_total int;
BEGIN
  PERFORM 1 FROM public.tournament_days WHERE id = p_day_id FOR UPDATE;

  SELECT COUNT(*) INTO v_total
    FROM public.tournament_players
   WHERE tournament_day_id = p_day_id
     AND status = 'eliminated';

  UPDATE public.tournament_days
     SET eliminations_count = v_total
   WHERE id = p_day_id;

  RETURN v_total;
END $$;

COMMENT ON FUNCTION public.recontar_eliminacoes(uuid) IS
  'Modo mesa: grava no dia a contagem de inscritos com status eliminated.';


-- ── 6) Estorno: cada reentrada cancelada devolve UMA eliminação ─────────────
-- Parte da versão de database_migration_estorno_fichas_da_venda.sql (fichas
-- da VENDA, recibo em transaction_counter_refunds). O que muda:
--
--   * REENTRADA, modo em massa: +1 por reentrada estornada (antes só quando
--     sumia a ÚLTIMA recompra do jogador — com a regra "toda reentrada traz um
--     eliminado de volta", cada uma devolve a sua). Exceção: as linhas 1..N
--     de um lote antigo (`quantity`), gravadas como `cmid:1`, `cmid:2`... —
--     aquela venda trouxe UM jogador de volta, então só a linha `:0` devolve.
--   * REENTRADA, modo mesa: o jogador volta a 'eliminated' (se estava na mesa)
--     e o contador é recontado. O assento é liberado pelo backend.
--   * ENTRADA estornada, modo mesa: recontar (a linha virou 'cancelled' e sai
--     da contagem de eliminados, se estava nela).
--   * ENTRADA estornada, modo em massa: aparar o contador às ENTRADAS.
CREATE OR REPLACE FUNCTION public.undo_entry_counters_once(p_transaction_id uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
  v_tx        public.transactions%rowtype;
  v_dia_id    uuid;
  v_modo      text;
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

  SELECT tp.tournament_day_id, COALESCE(t.elimination_mode, 'bulk')
    INTO v_dia_id, v_modo
    FROM public.tournament_players tp
    LEFT JOIN public.tournaments t ON t.id = tp.tournament_id
   WHERE tp.id = v_tx.tournament_player_id;

  IF v_tx.type = 'rebuy' THEN
    -- Fichas da VENDA; o campo do dia só para as vendas antigas, sem o retrato.
    SELECT COALESCE(v_tx.chips, rebuy_chips, 0) INTO v_fichas
      FROM public.tournament_days WHERE id = v_dia_id;
    v_fichas := COALESCE(v_fichas, COALESCE(v_tx.chips, 0));
    UPDATE public.tournament_players
       SET rebuy_count        = GREATEST(COALESCE(rebuy_count, 0) - 1, 0),
           total_rebuy_amount = GREATEST(COALESCE(total_rebuy_amount, 0) - COALESCE(v_tx.amount, 0), 0),
           total_chips        = GREATEST(COALESCE(total_chips, 0) - COALESCE(v_fichas, 0), 0)
     WHERE id = v_tx.tournament_player_id;

    IF v_dia_id IS NOT NULL THEN
      IF v_modo = 'table' THEN
        -- A reentrada é que o tinha trazido de volta: sem ela, ele está fora.
        -- Se já foi eliminado de novo depois, nada muda — ele continua fora
        -- uma vez só.
        UPDATE public.tournament_players
           SET status        = 'eliminated',
               eliminated_at = COALESCE(eliminated_at, now())
         WHERE id = v_tx.tournament_player_id
           AND status IN ('active', 'registered');
        PERFORM public.recontar_eliminacoes(v_dia_id);
      ELSIF COALESCE(v_tx.client_id, '') !~ ':[1-9][0-9]*$' THEN
        PERFORM public.registrar_eliminacao(v_dia_id, 1);
      END IF;
    END IF;
  ELSIF v_tx.type = 'addon' THEN
    -- Add-on não mexe em jogador nem em eliminação: só fichas e dinheiro.
    SELECT COALESCE(v_tx.chips, addon_chips, 0) INTO v_fichas
      FROM public.tournament_days WHERE id = v_dia_id;
    v_fichas := COALESCE(v_fichas, COALESCE(v_tx.chips, 0));
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

      IF v_modo = 'table' THEN
        PERFORM public.recontar_eliminacoes(v_dia_id);
      ELSE
        -- Uma entrada a menos pode deixar o contador acima do novo total. Sem
        -- este aparo, "entradas − eliminações" viraria negativo.
        UPDATE public.tournament_days d
           SET eliminations_count = LEAST(COALESCE(d.eliminations_count, 0),
                                          public.entradas_do_dia(d.id))
         WHERE d.id = v_dia_id;
      END IF;
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


-- ── 7) Lista de torneios: reentrada é só a recompra ─────────────────────────
-- Mesmo corpo de database_migration_summary_torneio_jogadores.sql, com
-- `reentradas` sem o add-on. O fallback em Python
-- (`TournamentService._get_tournament_summary_batched`) muda junto.
CREATE OR REPLACE FUNCTION public.get_tournament_summary(p_stage_id uuid DEFAULT NULL::uuid, p_tournament_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
DECLARE
    result jsonb;
BEGIN
    UPDATE tournaments t
    SET status = der.derived
    FROM (
        SELECT td.tournament_id AS id,
               CASE
                   WHEN bool_or(td.status = 'active') THEN 'active'
                   WHEN bool_or(td.status = 'completed')
                        AND bool_and(td.status IN ('completed', 'cancelled')) THEN 'completed'
                   ELSE 'pending'
               END AS derived
        FROM tournament_days td
        GROUP BY td.tournament_id
    ) der
    WHERE t.id = der.id
      AND t.status IS DISTINCT FROM der.derived
      AND (p_stage_id IS NULL OR t.stage_id = p_stage_id)
      AND (p_tournament_id IS NULL OR t.id = p_tournament_id);

    SELECT coalesce(jsonb_agg(row_obj ORDER BY created_at DESC), '[]'::jsonb)
    INTO result
    FROM (
        SELECT
            to_jsonb(t)
            || jsonb_build_object(
                   'sponsor_name',    s.name,
                   'total_entries',   coalesce(da.total_entries, 0),
                   'total_players',   coalesce(da.total_players, 0),
                   'total_reentries', coalesce(da.total_reentries, 0),
                   'total_days',      coalesce(da.total_days, 0)
               ) AS row_obj,
            t.created_at AS created_at
        FROM tournaments t
        LEFT JOIN sponsors s ON s.id = t.sponsor_id
        LEFT JOIN (
            SELECT td.tournament_id,
                   count(*) AS total_days,
                   -- O dia FINAL não entra: quem chega lá veio classificado do
                   -- dia anterior, e contá-lo somaria a mesma pessoa duas vezes.
                   coalesce(sum(CASE WHEN td.day_type <> 'final' THEN dp.entries    ELSE 0 END), 0) AS total_entries,
                   coalesce(sum(CASE WHEN td.day_type <> 'final' THEN dp.jogadores  ELSE 0 END), 0) AS total_players,
                   coalesce(sum(CASE WHEN td.day_type <> 'final' THEN dp.reentradas ELSE 0 END), 0) AS total_reentries
            FROM tournament_days td
            LEFT JOIN (
                SELECT tournament_day_id,
                       sum(coalesce(buy_in_count, 0))                              AS entries,
                       count(*) FILTER (WHERE coalesce(status, '') <> 'cancelled')  AS jogadores,
                       sum(coalesce(rebuy_count, 0))                                AS reentradas
                FROM tournament_players
                GROUP BY tournament_day_id
            ) dp ON dp.tournament_day_id = td.id
            GROUP BY td.tournament_id
        ) da ON da.tournament_id = t.id
        WHERE (p_stage_id IS NULL OR t.stage_id = p_stage_id)
          AND (p_tournament_id IS NULL OR t.id = p_tournament_id)
    ) sub;

    RETURN result;
END;
$function$;


-- ── 8) Resumo por dia: ENTRADA é buy-in ─────────────────────────────────────
-- O fallback em Python (`_get_tournament_day_summary_batched`) já contava só
-- buy-ins; a função somava as recompras. Agora os dois caminhos concordam.
-- `search_path` fixo, como a migração summary_rpcs_pin_search_path deixou.
CREATE OR REPLACE FUNCTION public.get_tournament_day_summaries(
    p_tournament_id uuid DEFAULT NULL,
    p_day_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
    SELECT coalesce(
        jsonb_agg(
            to_jsonb(td) || jsonb_build_object(
                'total_buy_ins', coalesce(a.buy_ins, 0),
                'total_rebuys', coalesce(a.rebuys, 0),
                'total_addons', coalesce(a.addons, 0),
                'total_entries', coalesce(a.buy_ins, 0)
            )
            ORDER BY td.day_number ASC
        ),
        '[]'::jsonb
    )
    FROM tournament_days td
    LEFT JOIN (
        SELECT tournament_day_id,
               sum(coalesce(buy_in_count, 0)) AS buy_ins,
               sum(coalesce(rebuy_count, 0)) AS rebuys,
               sum(coalesce(addon_count, 0)) AS addons
        FROM tournament_players
        GROUP BY tournament_day_id
    ) a ON a.tournament_day_id = td.id
    WHERE (p_tournament_id IS NULL OR td.tournament_id = p_tournament_id)
      AND (p_day_id IS NULL OR td.id = p_day_id);
$$;
