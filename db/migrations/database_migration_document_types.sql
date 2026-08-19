-- ============================================================================
-- MIGRAÇÃO: tipos de documento por país (CPF / DNI / Cédula)
-- ============================================================================
-- POR QUE: o documento é o comprovante de quem recebeu prêmio em dinheiro.
-- O tipo 'national_id' era genérico demais — cobria CPF (Brasil), DNI (Peru) e
-- cédula (Colômbia), que têm formatos diferentes — e por isso nada podia ser
-- validado de verdade. Agora o cadastro escolhe o tipo do país e o backend
-- valida (backend/app/utils/documentos.py).
--
-- ADITIVA E IDEMPOTENTE: pode rodar mais de uma vez. Os tipos antigos
-- ('passport', 'national_id', 'driver_license') CONTINUAM aceitos:
--   1) existem 11 jogadores gravados com 'national_id' (um deles com documento
--      inválido) e eles não podem quebrar — o clube travaria no balcão;
--   2) o deploy não é atômico: por um tempo o frontend antigo ainda envia
--      'national_id'.
--
-- APLICAR ANTES do deploy: é aqui que os tipos por país passam a ser gravados.
-- O código NÃO depende dessa ordem para continuar funcionando — o formulário
-- abre com 'cpf' e, se o CHECK antigo recusar, o backend regrava o cadastro com
-- 'national_id' (app/utils/documentos.py: tipo_para_banco_antigo). O cadastro
-- no balcão entra de qualquer jeito; o que se perde até a migração rodar é só o
-- tipo do país, que a própria tela convida a corrigir depois.
--
-- Esta migração NÃO altera nenhum dado existente e NÃO apaga cadastro nenhum.
-- ============================================================================

BEGIN;

-- --- players ---------------------------------------------------------------
ALTER TABLE public.players
  DROP CONSTRAINT IF EXISTS players_document_type_check;

ALTER TABLE public.players
  ADD CONSTRAINT players_document_type_check
  CHECK (document_type IN (
    -- tipos novos, validados por país
    'cpf', 'dni', 'cedula', 'passport', 'driver_license',
    -- legado: cadastros antigos e frontend ainda não atualizado
    'national_id'
  ));

COMMENT ON COLUMN public.players.document_type IS
  'Tipo do documento: cpf (BR), dni (PE), cedula (CO), passport, driver_license. '
  'national_id = legado (cadastros antigos, sem validação estrita).';

-- --- prize_payouts ---------------------------------------------------------
-- O recibo do prêmio copia o tipo do jogador; a coluna é VARCHAR(30) sem CHECK,
-- então só precisa caber. 'driver_license' (14) já cabia; os novos são menores.
-- Nada a alterar — o comentário fica registrado para quem for auditar.
COMMENT ON COLUMN public.prize_payouts.document_type IS
  'Copiado do jogador no momento do pagamento: cpf, dni, cedula, passport, '
  'driver_license ou national_id (legado).';

COMMIT;

-- ============================================================================
-- CONFERÊNCIA (rodar depois; só leitura)
-- ============================================================================
-- Quantos cadastros ficaram no tipo legado, e quantos têm documento suspeito
-- (dígitos todos iguais) — é o caso que o dono do clube encontrou:
--
--   SELECT document_type,
--          COUNT(*) AS total,
--          COUNT(*) FILTER (
--            WHERE regexp_replace(document_number, '\D', '', 'g') ~ '^(\d)\1+$'
--          ) AS suspeitos
--     FROM public.players
--    GROUP BY document_type
--    ORDER BY total DESC;
-- ============================================================================
