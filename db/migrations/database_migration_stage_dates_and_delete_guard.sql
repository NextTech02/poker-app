-- Migration: datas da etapa + trava de exclusão de etapa com movimento
--
-- Contexto (teste de aceitação do dono do clube):
--   1) Deu para cadastrar uma etapa de 10/08 a 02/08 — fim antes do início.
--   2) Apagar uma etapa apaga EM CASCATA sangria_transactions,
--      stage_cash_register, expenses, other_revenues, staff_payments,
--      cashboxes, buy_types e chip_consignments. Some a contabilidade inteira
--      daquela etapa, sem desfazer.
--
-- Esta migração é ADITIVA e IDEMPOTENTE. Ela NÃO mexe nas FKs existentes (o
-- CASCADE continua lá, para quando a etapa realmente estiver vazia) e NÃO
-- torna `start_date` NOT NULL — há etapas antigas sem data na base, e elas
-- precisam continuar sendo lidas e operadas. A obrigatoriedade da data de
-- início vive na aplicação (Pydantic + tela), que é onde dá para PEDIR a data
-- em vez de simplesmente quebrar.
--
-- O que entra aqui:
--   a) CHECK de ordem das datas, tolerante ao passado (NOT VALID): vale para
--      linha nova e para linha editada, sem reprovar o que já está gravado.
--   b) Trigger BEFORE DELETE que recusa apagar etapa com movimento
--      financeiro. A regra também existe no backend; ela mora TAMBÉM aqui
--      porque o DELETE pode vir do SQL Editor, de um script ou do cliente
--      Supabase direto do frontend — caminhos que não passam pela API.

-- ─────────────────────────────────────────────────────────────────────────────
-- a) Fim nunca antes do início
-- ─────────────────────────────────────────────────────────────────────────────
-- NOT VALID: linhas já gravadas com data invertida não impedem a migração de
-- rodar (o clube conserta pela tela); toda escrita a partir de agora obedece.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'stages_datas_coerentes' and conrelid = 'public.stages'::regclass
  ) then
    alter table public.stages
      add constraint stages_datas_coerentes
      check (start_date is null or end_date is null or end_date >= start_date)
      not valid;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- b) Trava de exclusão: etapa com dinheiro no meio não se apaga
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.impedir_exclusao_de_etapa_com_movimento()
returns trigger
language plpgsql
as $$
declare
  v_tabela  text;
  v_total   bigint;
  v_achados text[] := '{}';
begin
  -- Cada tabela é conferida por `to_regclass` porque nem toda instalação
  -- rodou todas as migrações (other_revenues e chip_consignments são
  -- recentes). Tabela ausente = nada a proteger nela.
  foreach v_tabela in array array[
    'sangria_transactions', 'expenses', 'other_revenues',
    'staff_payments', 'chip_consignments'
  ] loop
    if to_regclass('public.' || v_tabela) is not null then
      execute format('select count(*) from public.%I where stage_id = $1', v_tabela)
        into v_total using old.id;
      if v_total > 0 then
        v_achados := v_achados || format('%s: %s', v_tabela, v_total);
      end if;
    end if;
  end loop;

  -- Caixa da etapa: `total_received` pega qualquer venda já registrada, mesmo
  -- que o saldo tenha sido zerado por sangria.
  if to_regclass('public.stage_cash_register') is not null then
    execute 'select count(*) from public.stage_cash_register
             where stage_id = $1 and (coalesce(current_balance,0) <> 0 or coalesce(total_received,0) <> 0)'
      into v_total using old.id;
    if v_total > 0 then
      v_achados := v_achados || 'caixa da etapa com movimento';
    end if;
  end if;

  if array_length(v_achados, 1) is not null then
    raise exception
      'Etapa % tem movimento financeiro e nao pode ser excluida (%). Arquive a etapa (status cancelled) em vez de excluir.',
      old.id, array_to_string(v_achados, ', ')
      using errcode = 'restrict_violation';
  end if;

  return old;
end;
$$;

drop trigger if exists trg_impedir_exclusao_etapa_com_movimento on public.stages;
create trigger trg_impedir_exclusao_etapa_com_movimento
  before delete on public.stages
  for each row
  execute function public.impedir_exclusao_de_etapa_com_movimento();

-- Conferência rápida depois de aplicar:
--   select conname, convalidated from pg_constraint
--    where conrelid = 'public.stages'::regclass and conname = 'stages_datas_coerentes';
--   select tgname from pg_trigger where tgrelid = 'public.stages'::regclass;
