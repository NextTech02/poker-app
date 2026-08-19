-- ============================================================================
-- MIGRAÇÃO: nome e sobrenome separados no cadastro de jogador
-- ============================================================================
-- POR QUE: o dono do clube pediu um campo para o nome e outro para o
-- sobrenome. Chamar em voz alta na mesa, ordenar a lista por sobrenome e
-- conferir o documento no pagamento do prêmio são operações que precisam das
-- duas partes separadas — hoje tudo mora numa string só.
--
-- O RISCO QUE DEFINE ESTA MIGRAÇÃO: 93 arquivos do sistema leem `players.name`
-- e 32 consultas do backend pedem `players(name)` em embed (recibo de prêmio,
-- alocação de mesa, ranking, relatório, tela de TV...). Se `name` sumisse ou
-- parasse de ser preenchido, o sistema inteiro quebrava de uma vez.
-- ENTÃO: as colunas novas são ADICIONADAS e `name` CONTINUA existindo, sempre
-- preenchido com "first_name last_name". Nenhum dos 93 lugares precisa mudar.
--
-- POR QUE TRIGGER E NÃO COLUNA GERADA (GENERATED ALWAYS AS ... STORED):
--   1) Coluna gerada é SOMENTE LEITURA no Postgres: qualquer INSERT/UPDATE que
--      mande `name` passa a estourar com "cannot insert into column name".
--      E hoje MUITA gente escreve só `name`: a importação de jogadores
--      (player_import_service), o replay da fila do modo offline, o cadastro
--      rápido do balcão e o frontend antigo — que continua no ar por um tempo,
--      porque o deploy não é atômico. O clube travaria no balcão.
--   2) Coluna gerada não aceita ser preenchida no backfill nem tolera as 11
--      linhas atuais mudando de forma independente.
--   O trigger resolve os DOIS sentidos: quem manda só `name` ganha
--   first_name/last_name divididos; quem manda first_name/last_name ganha
--   `name` remontado. Ninguém precisa saber do outro lado.
--
-- ADITIVA E IDEMPOTENTE: pode rodar mais de uma vez, não apaga nada e não
-- muda nenhum nome existente (só divide o que já está lá).
--
-- APLICAR ANTES do deploy: sem as colunas, o backend novo cai no caminho de
-- compatibilidade (regrava só `name`) e o sobrenome não seria guardado.
-- ============================================================================

BEGIN;

-- --- colunas ---------------------------------------------------------------
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS first_name VARCHAR(120);
ALTER TABLE public.players ADD COLUMN IF NOT EXISTS last_name  VARCHAR(160);

COMMENT ON COLUMN public.players.first_name IS
  'Nome (primeira parte). Preenchido pelo trigger a partir de `name` quando o '
  'gravador só conhece o nome completo.';
COMMENT ON COLUMN public.players.last_name IS
  'Sobrenome (o resto do nome, após o primeiro espaço). NULL para quem tem '
  'nome de uma palavra só.';
COMMENT ON COLUMN public.players.name IS
  'Nome completo — MANTIDO por compatibilidade e sempre igual a '
  '"first_name last_name" (trigger trg_players_sincroniza_nome). 93 arquivos '
  'do sistema leem esta coluna; não remover.';

-- --- divisão do nome: uma regra só, usada no backfill E no trigger ----------
-- A divisão é no PRIMEIRO espaço: "José Felipe Pinto Faria" -> "José" +
-- "Felipe Pinto Faria". Quem não tem espaço fica só com first_name (é o caso
-- de 1 dos 11 jogadores de hoje).

CREATE OR REPLACE FUNCTION public.player_nome_limpo(p_nome text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  -- Espaço duplicado no cadastro ("Adam  Louis") faria a divisão devolver
  -- sobrenome começando com espaço, e a busca por sobrenome nunca acharia.
  SELECT btrim(regexp_replace(coalesce(p_nome, ''), '\s+', ' ', 'g'))
$$;

CREATE OR REPLACE FUNCTION public.player_primeiro_nome(p_nome text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
           WHEN position(' ' in public.player_nome_limpo(p_nome)) > 0
             THEN left(public.player_nome_limpo(p_nome),
                       position(' ' in public.player_nome_limpo(p_nome)) - 1)
           ELSE nullif(public.player_nome_limpo(p_nome), '')
         END
$$;

CREATE OR REPLACE FUNCTION public.player_sobrenome(p_nome text)
RETURNS text
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
           WHEN position(' ' in public.player_nome_limpo(p_nome)) > 0
             THEN substr(public.player_nome_limpo(p_nome),
                         position(' ' in public.player_nome_limpo(p_nome)) + 1)
           ELSE NULL
         END
$$;

-- --- trigger: mantém os dois lados de acordo -------------------------------
CREATE OR REPLACE FUNCTION public.players_sincroniza_nome()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_primeiro text := nullif(btrim(coalesce(NEW.first_name, '')), '');
  v_ultimo   text := nullif(btrim(coalesce(NEW.last_name, '')), '');
  v_partes_mudaram boolean;
  v_nome_mudou     boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    v_partes_mudaram := (NEW.first_name IS DISTINCT FROM OLD.first_name)
                     OR (NEW.last_name  IS DISTINCT FROM OLD.last_name);
    v_nome_mudou     := (NEW.name IS DISTINCT FROM OLD.name);
  ELSE
    v_partes_mudaram := (v_primeiro IS NOT NULL) OR (v_ultimo IS NOT NULL);
    v_nome_mudou     := TRUE;
  END IF;

  IF v_partes_mudaram AND v_primeiro IS NOT NULL THEN
    -- Quem sabe do sobrenome manda: `name` é remontado a partir das partes.
    NEW.first_name := v_primeiro;
    NEW.last_name  := v_ultimo;
    NEW.name       := btrim(v_primeiro || ' ' || coalesce(v_ultimo, ''));
  ELSIF v_nome_mudou OR v_primeiro IS NULL THEN
    -- Gravador antigo (importação, fila offline, frontend anterior ao deploy)
    -- ou linha ainda sem as partes: conhece só `name`. Divide para que o
    -- sobrenome não fique vazio.
    NEW.first_name := public.player_primeiro_nome(NEW.name);
    NEW.last_name  := public.player_sobrenome(NEW.name);
    NEW.name       := public.player_nome_limpo(NEW.name);
  ELSE
    -- Nada de nome mudou neste UPDATE (é o caso de gravar só o telefone, ou do
    -- pagamento de prêmio regravando o documento). Preserva a divisão que o
    -- cadastro escolheu: sem este ramo, "Maria Clara" + "Souza" viraria
    -- "Maria" + "Clara Souza" no primeiro UPDATE de qualquer outro campo.
    NEW.first_name := v_primeiro;
    NEW.last_name  := v_ultimo;
    NEW.name       := btrim(v_primeiro || ' ' || coalesce(v_ultimo, ''));
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS trg_players_sincroniza_nome ON public.players;
CREATE TRIGGER trg_players_sincroniza_nome
  BEFORE INSERT OR UPDATE ON public.players
  FOR EACH ROW EXECUTE FUNCTION public.players_sincroniza_nome();

-- --- backfill dos cadastros que já existem ---------------------------------
-- Só toca em quem ainda não tem first_name (roda de novo sem estragar nada).
UPDATE public.players
   SET first_name = public.player_primeiro_nome(name),
       last_name  = public.player_sobrenome(name)
 WHERE first_name IS NULL
   AND name IS NOT NULL;

COMMIT;

-- ============================================================================
-- CONFERÊNCIA (rodar depois; só leitura)
-- ============================================================================
-- 1) Ninguém pode ficar sem nome, e `name` tem de continuar batendo com as
--    partes (é o que os 93 leitores mostram na tela):
--
--   SELECT count(*) FILTER (WHERE first_name IS NULL)                    AS sem_primeiro_nome,
--          count(*) FILTER (WHERE last_name IS NULL)                     AS sem_sobrenome,
--          count(*) FILTER (
--            WHERE name IS DISTINCT FROM
--                  btrim(first_name || ' ' || coalesce(last_name, ''))
--          )                                                             AS fora_de_sincronia,
--          count(*)                                                      AS total
--     FROM public.players;
--
--   Esperado hoje: sem_primeiro_nome = 0, fora_de_sincronia = 0,
--   sem_sobrenome = 1 (o jogador cadastrado com uma palavra só), total = 11.
--
-- 2) Conferir a divisão a olho:
--
--   SELECT name, first_name, last_name FROM public.players ORDER BY first_name;
-- ============================================================================
