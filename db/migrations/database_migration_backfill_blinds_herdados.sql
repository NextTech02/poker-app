-- Materializa a herança de blinds que até agora era IMPLÍCITA.
-- APLICADA EM PRODUÇÃO em 13/08/2026 (86 linhas copiadas, 10 dias resolvidos).
--
-- CONTEXTO
-- Até esta versão, um dia sem estrutura própria caía num fallback
-- (TournamentDayService._get_all_blinds) que buscava os blinds do TORNEIO
-- inteiro. Isso funcionava por acidente quando o torneio tinha um único dia
-- configurado, e produzia lixo quando tinha mais de um: os níveis vinham
-- somados, com números repetidos, e o relógio do dia calculava a duração sobre
-- a estrutura de todos os dias juntos. Um torneio real em produção devolvia 73
-- linhas e 33 níveis distintos para um único dia.
--
-- O fallback passou a considerar apenas as linhas LEGADAS (tournament_day_id
-- nulo). Sem este backfill, 12 dias reais em produção — entre eles "DIA 1B MAIN
-- EVENT" e vários "Dia Final" — perderiam a estrutura e o telão ficaria sem
-- blinds ao iniciar o dia, na frente dos jogadores.
--
-- O QUE ESTE SCRIPT FAZ
-- Copia a estrutura para os dias que dependiam da herança E cujo torneio tem UMA
-- fonte inequívoca (exatamente um dia com blinds). O operador passa a ver o
-- mesmo de antes, agora com o dado explícito no dia.
--
-- O QUE ELE DELIBERADAMENTE NÃO FAZ
-- Torneios com mais de um dia-fonte ficam de fora: não há como saber de qual
-- copiar, e o que esses dias exibiam antes já estava errado (níveis duplicados).
-- Melhor o telão dizer "sem estrutura" do que mostrar uma estrutura inventada —
-- o operador aplica um modelo na tela de Blinds, que é o caminho correto.
-- Sobraram 2 dias nessa situação.
--
-- organization_id vem da linha de ORIGEM: o default `current_org_id()` é nulo
-- fora de uma sessão autenticada (uma migração roda como postgres), e a coluna
-- é NOT NULL.
--
-- Idempotente: só insere onde o dia não tem nenhuma linha.

INSERT INTO public.blinds
  (tournament_id, tournament_day_id, level, small_blind, big_blind, ante, duration,
   is_break, organization_id)
SELECT o.tournament_id, o.dia, b.level, b.small_blind, b.big_blind, b.ante, b.duration,
       b.is_break, b.organization_id
FROM (
  SELECT td.id AS dia, td.tournament_id
  FROM tournament_days td
  WHERE NOT EXISTS (SELECT 1 FROM blinds x WHERE x.tournament_day_id = td.id)
    AND EXISTS (SELECT 1 FROM blinds y WHERE y.tournament_id = td.tournament_id
                                         AND y.tournament_day_id IS NOT NULL)
) o
JOIN (
  SELECT tournament_id, min(tournament_day_id::text)::uuid AS dia_fonte
  FROM blinds WHERE tournament_day_id IS NOT NULL
  GROUP BY tournament_id
  HAVING count(DISTINCT tournament_day_id) = 1
) f ON f.tournament_id = o.tournament_id
JOIN public.blinds b ON b.tournament_day_id = f.dia_fonte;

-- Conferência pós-execução:
--   SELECT count(*) FROM tournament_days td
--    WHERE NOT EXISTS (SELECT 1 FROM blinds b  WHERE b.tournament_day_id = td.id)
--      AND EXISTS     (SELECT 1 FROM blinds b2 WHERE b2.tournament_id = td.tournament_id
--                                                AND b2.tournament_day_id IS NOT NULL);
--   -- esperado: só os dias de fonte ambígua (2 em 13/08/2026)
