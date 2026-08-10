-- ============================================================================
-- Despesas — Fase 2: pagamento debita o caixa geral (atomicamente)
-- ----------------------------------------------------------------------------
-- Marcar uma despesa como paga passa a debitar `general_cash_register`, como já
-- acontece com prêmios e pagamentos de funcionários — assim o caixa e o DRE
-- contam a mesma história.
--
-- Feito em RPC (e não no app) por dois motivos:
--   1) ATOMICIDADE: o app faz "lê saldo → subtrai → grava", que perde dinheiro
--      se dois pagamentos acontecerem juntos. Aqui o UPDATE usa o próprio valor
--      da coluna, então concorrência não corrompe o saldo.
--   2) IDEMPOTÊNCIA: reenviar "marcar como pago" não debita duas vezes, porque
--      a função compara com o status atual antes de mexer no caixa.
--
-- `paid_from_cash = false` (pago por fora, direto do banco) registra a despesa
-- no DRE sem tocar no caixa.
-- ============================================================================

create or replace function public.expense_set_status(
  p_org uuid,
  p_expense uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  e public.expenses%rowtype;
  v_delta numeric := 0;
  v_balance numeric;
begin
  if p_status not in ('pendente', 'pago') then
    raise exception 'DESPESA: Status invalido.';
  end if;

  -- Trava a linha: dois cliques simultâneos não geram débito duplo.
  select * into e from public.expenses
   where id = p_expense and organization_id = p_org
   for update;

  if not found then
    raise exception 'DESPESA: Despesa nao encontrada.';
  end if;

  -- Já está no estado pedido: não repete o movimento no caixa.
  if e.status = p_status then
    return jsonb_build_object('id', e.id, 'status', e.status, 'changed', false);
  end if;

  -- Só movimenta o caixa quando a despesa é paga POR ELE.
  if e.paid_from_cash then
    v_delta := case when p_status = 'pago' then -e.amount else e.amount end;
  end if;

  update public.expenses
     set status = p_status,
         paid_at = case when p_status = 'pago' then now() else null end,
         updated_at = now()
   where id = p_expense;

  if v_delta <> 0 then
    -- Usa o valor da própria coluna (não um saldo lido antes): à prova de corrida.
    update public.general_cash_register
       set current_balance = current_balance + v_delta,
           updated_at = now()
     where organization_id = p_org
     returning current_balance into v_balance;
  end if;

  return jsonb_build_object(
    'id', e.id,
    'status', p_status,
    'changed', true,
    'cash_delta', v_delta,
    'cash_balance', v_balance
  );
end $function$;
