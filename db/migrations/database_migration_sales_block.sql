-- ============================================================================
-- Bloqueio explícito de vendas (por DIA e por ETAPA)
-- ----------------------------------------------------------------------------
-- Por que o clube precisa disso: encerrado o registro tardio, o diretor quer
-- que o Caixa PARE de vender aquele dia — hoje não existe nenhuma trava, e um
-- operador distraído registra um jogador depois do fechamento das inscrições.
-- Desfazer essa venda é justamente o trabalho caro (estorno de caixa, prize
-- pool e fidelidade); barrar antes é muito mais barato.
--
-- Duas camadas, de propósito:
--   * tournament_days.sales_blocked  -> trava fina; encerrou o Dia 1A e o 1B da
--     mesma etapa continua vendendo normalmente.
--   * stages.sales_blocked           -> chave-mestra do diretor ("fecha tudo
--     agora"), e a única que o Caixa consegue enxergar ANTES de o operador
--     escolher o dia dentro do modal.
-- O bloqueio efetivo é o OU das duas.
--
-- Espelha a forma já usada por tournament_days.tables_locked
-- (database_migration_table_management_per_day.sql).
--
-- ADITIVA e IDEMPOTENTE: pode rodar de novo sem efeito colateral. O código
-- tolera a ausência das colunas (sem coluna => nada bloqueado => comportamento
-- de hoje), porque o deploy do backend não é atômico com esta migração.
-- ============================================================================

ALTER TABLE tournament_days
  ADD COLUMN IF NOT EXISTS sales_blocked        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sales_blocked_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sales_blocked_by     UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS sales_blocked_reason TEXT;

ALTER TABLE stages
  ADD COLUMN IF NOT EXISTS sales_blocked        BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sales_blocked_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sales_blocked_by     UUID REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS sales_blocked_reason TEXT;

COMMENT ON COLUMN tournament_days.sales_blocked IS
  'Quando true, o Caixa recusa novas entradas (buy_in/rebuy/addon) deste dia. Ligado/desligado por admin.';
COMMENT ON COLUMN tournament_days.sales_blocked_reason IS
  'Motivo mostrado ao operador no Caixa ("registro tardio encerrado", "mesas fechadas").';
COMMENT ON COLUMN stages.sales_blocked IS
  'Chave-mestra: quando true, bloqueia vendas em TODOS os dias da etapa.';

-- Índice parcial: as consultas só se interessam pelos bloqueados, que são
-- poucos — indexar a coluna inteira gastaria espaço à toa.
CREATE INDEX IF NOT EXISTS idx_tournament_days_sales_blocked
  ON tournament_days(id) WHERE sales_blocked;
CREATE INDEX IF NOT EXISTS idx_stages_sales_blocked
  ON stages(id) WHERE sales_blocked;

-- OBS: as duas tabelas já têm organization_id NOT NULL + RLS
-- (database_migration_saas_phase1_organizations.sql), então nenhuma política
-- nova é necessária: quem enxerga a etapa/dia enxerga o flag.
