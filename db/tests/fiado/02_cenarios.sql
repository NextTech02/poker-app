\set ON_ERROR_STOP 1
-- ===== helpers ==============================================================
CREATE SCHEMA t;
GRANT USAGE ON SCHEMA t TO authenticated, service_role;
CREATE TABLE t.ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON t.ids TO authenticated, service_role;
CREATE FUNCTION t.id(k text) RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT v FROM t.ids WHERE ids.k = $1 $$;
-- Executa e exige erro com o padrão.
CREATE FUNCTION t.erro(p_sql text, p_padrao text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM !~ p_padrao THEN
      RAISE EXCEPTION 'FALHOU: esperado /%/ e veio: %  [%]', p_padrao, SQLERRM, p_sql;
    END IF;
    RAISE NOTICE 'ok (recusou): % -> %', p_padrao, left(SQLERRM, 90);
    RETURN;
  END;
  RAISE EXCEPTION 'FALHOU: deveria recusar /%/ mas passou: %', p_padrao, p_sql;
END $$;
CREATE FUNCTION t.igual(p_desc text, p_got numeric, p_exp numeric) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_exp THEN RAISE EXCEPTION 'FALHOU: % = % (esperado %)', p_desc, p_got, p_exp; END IF;
  RAISE NOTICE 'ok: % = %', p_desc, p_got;
END $$;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA t TO authenticated, service_role;

-- ===== dados ================================================================
INSERT INTO t.ids VALUES ('orgA', gen_random_uuid()), ('orgB', gen_random_uuid()),
  ('uOp', gen_random_uuid()), ('uMgr', gen_random_uuid()), ('uB', gen_random_uuid()),
  ('p1', gen_random_uuid()), ('p2', gen_random_uuid()), ('pB', gen_random_uuid()),
  ('d1', gen_random_uuid()), ('mesa', gen_random_uuid()), ('s1', gen_random_uuid()), ('s2', gen_random_uuid()),
  ('stOp', gen_random_uuid()), ('cb1', gen_random_uuid()), ('cs1', gen_random_uuid()),
  ('bar', gen_random_uuid()), ('cbBar', gen_random_uuid()), ('csBar', gen_random_uuid()),
  ('cbStage', gen_random_uuid()), ('cbFechada', gen_random_uuid());
INSERT INTO public.organizations (id, name, slug) VALUES (t.id('orgA'),'A','a'), (t.id('orgB'),'B','b');
INSERT INTO auth.users VALUES (t.id('uOp')), (t.id('uMgr')), (t.id('uB'));
INSERT INTO public.permission_groups (name, permissions, organization_id) VALUES ('Admin', ARRAY['employees','cash.operate'], t.id('orgA')), ('Caixa', ARRAY['cash.operate'], t.id('orgA'));
INSERT INTO public.players (id, name, organization_id) VALUES (t.id('p1'),'Ana',t.id('orgA')), (t.id('p2'),'Beto',t.id('orgA')), (t.id('pB'),'Zé',t.id('orgB'));
INSERT INTO public.staff (id, auth_user_id, name, organization_id) VALUES (t.id('stOp'), t.id('uOp'), 'Op', t.id('orgA'));
INSERT INTO public.cash_days (id, organization_id, business_date) VALUES (t.id('d1'), t.id('orgA'), current_date);
INSERT INTO public.cash_tables (id, organization_id, cash_day_id) VALUES (t.id('mesa'), t.id('orgA'), t.id('d1'));
INSERT INTO public.cash_player_sessions (id, organization_id, cash_day_id, table_id, player_id) VALUES
  (t.id('s1'), t.id('orgA'), t.id('d1'), t.id('mesa'), t.id('p1')), (t.id('s2'), t.id('orgA'), t.id('d1'), t.id('mesa'), t.id('p2'));
INSERT INTO public.bar_shifts (id, organization_id) VALUES (t.id('bar'), t.id('orgA'));
INSERT INTO public.cashboxes (id, staff_id, status, current_balance, current_session_id, organization_id, cash_day_id) VALUES
  (t.id('cb1'), t.id('stOp'), 'open', 1000, t.id('cs1'), t.id('orgA'), t.id('d1'));
INSERT INTO public.cashboxes (id, staff_id, status, current_balance, current_session_id, organization_id, bar_shift_id) VALUES
  (t.id('cbBar'), t.id('stOp'), 'open', 0, t.id('csBar'), t.id('orgA'), t.id('bar'));
INSERT INTO public.cashboxes (id, staff_id, status, current_balance, organization_id, stage_id) VALUES
  (t.id('cbStage'), t.id('stOp'), 'open', 0, t.id('orgA'), gen_random_uuid());
INSERT INTO public.cashboxes (id, staff_id, status, current_balance, organization_id, cash_day_id) VALUES
  (t.id('cbFechada'), t.id('stOp'), 'closed', 0, t.id('orgA'), t.id('d1'));

-- Atalhos de papel
\set OP 'SET ROLE authenticated; SELECT set_config(''request.jwt.claims'', json_build_object(''sub'', t.id(''uOp''), ''organization_id'', t.id(''orgA''))::text, false);'
\set SR 'SET ROLE service_role; SELECT set_config(''request.jwt.claims'', '''', false);'
\set ROOT 'RESET ROLE; SELECT set_config(''request.jwt.claims'', '''', false);'

-- ===== T1 sem conta: venda fiada recusada ===================================
:OP
SELECT t.erro($$INSERT INTO cash_transactions (organization_id, cash_day_id, table_id, player_session_id, player_id, type, amount, payment_source, created_by)
  VALUES (t.id('orgA'), t.id('d1'), t.id('mesa'), t.id('s1'), t.id('p1'), 'buy_in', 300, 'house_credit', t.id('uOp'))$$, 'fiado_nao_habilitado');
-- operador não cria conta nem a habilita
SELECT t.erro($$INSERT INTO house_credit_accounts (organization_id, player_id, enabled, credit_limit) VALUES (t.id('orgA'), t.id('p1'), true, 9999)$$, 'row-level security');

-- ===== T2 gerente (service role) habilita ===================================
:SR
INSERT INTO house_credit_accounts (organization_id, player_id, enabled, credit_limit, enabled_at, updated_by)
VALUES (t.id('orgA'), t.id('p1'), true, 500, now(), t.id('uMgr'));
SELECT t.erro($$INSERT INTO house_credit_accounts (organization_id, player_id, enabled, credit_limit, balance) VALUES (t.id('orgA'), t.id('p2'), true, 1, 50)$$, 'saldo_so_pelo_extrato');

-- ===== T3 buy-in fiado: fora da gaveta, dívida lançada ======================
:OP
INSERT INTO cash_transactions (organization_id, cash_day_id, table_id, player_session_id, player_id, type, amount, payment_source, payment_method, cashbox_id, created_by, client_mutation_id)
VALUES (t.id('orgA'), t.id('d1'), t.id('mesa'), t.id('s1'), t.id('p1'), 'buy_in', 300, 'house_credit', 'cash', t.id('cb1'), t.id('uOp'), 'bi-1');
SELECT t.igual('T3 venda fiada sem gaveta', (SELECT count(*) FROM cash_transactions WHERE client_mutation_id='bi-1' AND cashbox_id IS NULL), 1);
SELECT t.igual('T3 nada na gaveta', (SELECT count(*) FROM cashbox_transactions), 0);
SELECT t.igual('T3 saldo da gaveta intacto', (SELECT current_balance FROM cashboxes WHERE id=t.id('cb1')), 1000);
SELECT t.igual('T3 dívida', (SELECT balance FROM house_credit_accounts WHERE player_id=t.id('p1')), 300);
SELECT t.igual('T3 balance_after', (SELECT balance_after FROM house_credit_entries WHERE type='charge'), 300);
SELECT t.igual('T3 sessão conta as fichas', (SELECT total_buy_in FROM cash_player_sessions WHERE id=t.id('s1')), 300);

-- ===== T4 limite (300+300 > 500) — e a venda não fica =======================
SELECT t.erro($$INSERT INTO cash_transactions (organization_id, cash_day_id, table_id, player_session_id, player_id, type, amount, payment_source, created_by, client_mutation_id)
  VALUES (t.id('orgA'), t.id('d1'), t.id('mesa'), t.id('s1'), t.id('p1'), 'rebuy', 300, 'house_credit', t.id('uOp'), 'rb-x')$$, 'limite_de_fiado_excedido disponivel=200');
SELECT t.igual('T4 venda recusada não existe', (SELECT count(*) FROM cash_transactions WHERE client_mutation_id='rb-x'), 0);
SELECT t.igual('T4 sessão intacta', (SELECT total_buy_in FROM cash_player_sessions WHERE id=t.id('s1')), 300);

-- ===== T5 até o limite ======================================================
INSERT INTO cash_transactions (organization_id, cash_day_id, table_id, player_session_id, player_id, type, amount, payment_source, created_by)
VALUES (t.id('orgA'), t.id('d1'), t.id('mesa'), t.id('s1'), t.id('p1'), 'rebuy', 200, 'house_credit', t.id('uOp'));
SELECT t.igual('T5 dívida no limite', (SELECT balance FROM house_credit_accounts WHERE player_id=t.id('p1')), 500);
SELECT t.erro($$INSERT INTO cash_transactions (organization_id, cash_day_id, table_id, player_session_id, player_id, type, amount, payment_source, created_by)
  VALUES (t.id('orgA'), t.id('d1'), t.id('mesa'), t.id('s1'), t.id('p1'), 'cash_out', 50, 'house_credit', t.id('uOp'))$$, 'cash_tx_fiado_so_compra');

-- ===== T6/T7/T8 ataques diretos do navegador ================================
SELECT t.erro($$INSERT INTO house_credit_entries (organization_id, player_id, type, amount, reason) VALUES (t.id('orgA'), t.id('p1'), 'write_off', 500, 'amigo')$$, 'operacao_restrita_ao_gerente');
SELECT t.erro($$INSERT INTO house_credit_entries (organization_id, player_id, type, amount, cash_transaction_id) VALUES (t.id('orgA'), t.id('p1'), 'cashout_offset', 500, (SELECT id FROM cash_transactions LIMIT 1))$$, 'lancamento_so_pelo_caixa');
SELECT t.erro($$INSERT INTO house_credit_entries (organization_id, player_id, type, amount, cash_transaction_id) VALUES (t.id('orgA'), t.id('p1'), 'charge_reversal', 300, (SELECT id FROM cash_transactions WHERE client_mutation_id='bi-1'))$$, 'lancamento_so_pelo_caixa');
SELECT t.erro($$INSERT INTO house_credit_entries (organization_id, player_id, type, amount) VALUES (t.id('orgA'), t.id('p1'), 'prize_offset', 500)$$, 'lancamento_so_pelo_caixa');
UPDATE house_credit_accounts SET balance = 0, credit_limit = 99999 WHERE player_id = t.id('p1');
DELETE FROM house_credit_entries;
UPDATE house_credit_entries SET amount = 1;
SELECT t.igual('T8 UPDATE/DELETE do navegador sem efeito (saldo)', (SELECT balance FROM house_credit_accounts WHERE player_id=t.id('p1')), 500);
SELECT t.igual('T8 limite intacto', (SELECT credit_limit FROM house_credit_accounts WHERE player_id=t.id('p1')), 500);
SELECT t.igual('T8 extrato intacto', (SELECT count(*) FROM house_credit_entries), 2);
-- Sem gaveta de propósito, nem para disfarçar
SELECT t.erro($$UPDATE cash_transactions SET amount = 1 WHERE client_mutation_id='bi-1'$$, 'lancamento_imutavel');
SELECT t.erro($$UPDATE cash_transactions SET payment_source = 'cash' WHERE client_mutation_id='bi-1'$$, 'lancamento_imutavel');

-- ===== T9 nem o service role mexe no saldo direto ===========================
:SR
SELECT t.erro($$UPDATE house_credit_accounts SET balance = 0 WHERE player_id = t.id('p1')$$, 'saldo_so_pelo_extrato');
SELECT t.erro($$DELETE FROM house_credit_entries$$, 'extrato_imutavel');

-- ===== T10 cash-out com abatimento: gaveta paga só o líquido ================
:OP
INSERT INTO cash_transactions (organization_id, cash_day_id, table_id, player_session_id, player_id, type, amount, debt_settled_amount, debt_offset_expected, cashbox_id, created_by, client_mutation_id)
VALUES (t.id('orgA'), t.id('d1'), t.id('mesa'), t.id('s1'), t.id('p1'), 'cash_out', 800, 500, 500, t.id('cb1'), t.id('uOp'), 'co-1');
SELECT t.igual('T10 gaveta pagou 300', (SELECT -signed_amount FROM cashbox_transactions WHERE type='cash_out'), 300);
SELECT t.igual('T10 saldo da gaveta 700', (SELECT current_balance FROM cashboxes WHERE id=t.id('cb1')), 700);
SELECT t.igual('T10 dívida zerada', (SELECT balance FROM house_credit_accounts WHERE player_id=t.id('p1')), 0);
SELECT t.igual('T10 open_since limpo', (SELECT count(*) FROM house_credit_accounts WHERE player_id=t.id('p1') AND open_since IS NULL), 1);
SELECT t.igual('T10 sessão: cash-out de fichas 800', (SELECT total_cash_out FROM cash_player_sessions WHERE id=t.id('s1')), 800);
SELECT t.igual('T10 sessão: resultado +300 (800 − 500)', (SELECT result FROM cash_player_sessions WHERE id=t.id('s1')), 300);
SELECT t.erro($$INSERT INTO cash_transactions (organization_id, cash_day_id, table_id, player_session_id, player_id, type, amount, debt_settled_amount, cashbox_id, created_by)
  VALUES (t.id('orgA'), t.id('d1'), t.id('mesa'), t.id('s1'), t.id('p1'), 'cash_out', 100, 150, t.id('cb1'), t.id('uOp'))$$, 'cash_tx_abatimento_valido');
SELECT t.erro($$INSERT INTO cash_transactions (organization_id, cash_day_id, table_id, player_session_id, player_id, type, amount, debt_settled_amount, cashbox_id, created_by)
  VALUES (t.id('orgA'), t.id('d1'), t.id('mesa'), t.id('s1'), t.id('p1'), 'cash_out', 100, 50, t.id('cb1'), t.id('uOp'))$$, 'valor_maior_que_a_divida');
-- Gaveta com 700: cash-out de 900 com 0 de dívida estoura; sem fiado no meio, regra antiga intacta
SELECT t.erro($$INSERT INTO cash_transactions (organization_id, cash_day_id, table_id, player_session_id, player_id, type, amount, cashbox_id, created_by)
  VALUES (t.id('orgA'), t.id('d1'), t.id('mesa'), t.id('s2'), t.id('p2'), 'cash_out', 900, t.id('cb1'), t.id('uOp'))$$, 'saldo_insuficiente_no_caixa disponivel=700.00 solicitado=900');
SELECT t.erro($$UPDATE cash_transactions SET status='cancelling' WHERE client_mutation_id='co-1'$$, 'cash_out_com_abatimento_nao_cancelavel');

-- ===== T11 regressão: venda normal continua entrando na gaveta ==============
INSERT INTO cash_transactions (organization_id, cash_day_id, table_id, player_session_id, player_id, type, amount, payment_method, cashbox_id, created_by)
VALUES (t.id('orgA'), t.id('d1'), t.id('mesa'), t.id('s2'), t.id('p2'), 'buy_in', 100, 'pix', t.id('cb1'), t.id('uOp'));
SELECT t.igual('T11 buy-in normal espelhado', (SELECT current_balance FROM cashboxes WHERE id=t.id('cb1')), 800);

-- ===== T12 jogador 2: fiado de 400 =========================================
:SR
INSERT INTO house_credit_accounts (organization_id, player_id, enabled, credit_limit, updated_by) VALUES (t.id('orgA'), t.id('p2'), true, 1000, t.id('uMgr'));
:OP
INSERT INTO cash_transactions (organization_id, cash_day_id, table_id, player_session_id, player_id, type, amount, payment_source, created_by, client_mutation_id)
VALUES (t.id('orgA'), t.id('d1'), t.id('mesa'), t.id('s2'), t.id('p2'), 'rebuy', 400, 'house_credit', t.id('uOp'), 'rb-p2');

-- ===== T13/T14 recebimento ==================================================
INSERT INTO house_credit_entries (organization_id, player_id, type, amount, payment_method, cashbox_id, client_mutation_id)
VALUES (t.id('orgA'), t.id('p2'), 'payment', 100, 'pix', t.id('cb1'), 'pg-1');
SELECT t.igual('T13 dívida 300', (SELECT balance FROM house_credit_accounts WHERE player_id=t.id('p2')), 300);
SELECT t.igual('T13 debt_payment na gaveta', (SELECT signed_amount FROM cashbox_transactions WHERE type='debt_payment'), 100);
SELECT t.igual('T13 gaveta 900', (SELECT current_balance FROM cashboxes WHERE id=t.id('cb1')), 900);
SELECT t.igual('T13 created_by forçado ao usuário', (SELECT count(*) FROM house_credit_entries WHERE client_mutation_id='pg-1' AND created_by = t.id('uOp') AND module='cash' AND cash_day_id = t.id('d1')), 1);
SELECT t.erro($$INSERT INTO house_credit_entries (organization_id, player_id, type, amount, cashbox_id) VALUES (t.id('orgA'), t.id('p2'), 'payment', 10, t.id('cbFechada'))$$, 'caixa_fechado');
SELECT t.erro($$INSERT INTO house_credit_entries (organization_id, player_id, type, amount, cashbox_id) VALUES (t.id('orgA'), t.id('p2'), 'payment', 10, t.id('cbStage'))$$, 'recebimento_so_no_cash_ou_bar');
SELECT t.erro($$INSERT INTO house_credit_entries (organization_id, player_id, type, amount, cashbox_id) VALUES (t.id('orgA'), t.id('p2'), 'payment', 10, NULL)$$, 'caixa_fechado');
SELECT t.erro($$INSERT INTO house_credit_entries (organization_id, player_id, type, amount, cashbox_id) VALUES (t.id('orgA'), t.id('p2'), 'payment', 301, t.id('cb1'))$$, 'valor_maior_que_a_divida');
SELECT t.erro($$INSERT INTO house_credit_entries (organization_id, player_id, type, amount, payment_method, cashbox_id, client_mutation_id) VALUES (t.id('orgA'), t.id('p2'), 'payment', 100, 'pix', t.id('cb1'), 'pg-1')$$, 'uq_house_credit_entries_cmid');

-- ===== T15/T16 estorno de recebimento =======================================
SELECT t.erro($$INSERT INTO house_credit_entries (organization_id, player_id, type, amount, reverses_entry_id, cashbox_id) VALUES (t.id('orgA'), t.id('p2'), 'payment_reversal', 100, (SELECT id FROM house_credit_entries WHERE client_mutation_id='pg-1'), t.id('cb1'))$$, 'operacao_restrita_ao_gerente');
:SR
SELECT t.erro($$INSERT INTO house_credit_entries (organization_id, player_id, type, amount, reverses_entry_id, cashbox_id, created_by) VALUES (t.id('orgA'), t.id('p2'), 'payment_reversal', 50, (SELECT id FROM house_credit_entries WHERE client_mutation_id='pg-1'), t.id('cb1'), t.id('uMgr'))$$, 'estorno_deve_ser_do_valor_inteiro');
INSERT INTO house_credit_entries (organization_id, player_id, type, amount, reverses_entry_id, cashbox_id, created_by, reason)
VALUES (t.id('orgA'), t.id('p2'), 'payment_reversal', 100, (SELECT id FROM house_credit_entries WHERE client_mutation_id='pg-1'), t.id('cbBar'), t.id('uMgr'), 'digitou errado');
SELECT t.igual('T15 dívida volta a 400', (SELECT balance FROM house_credit_accounts WHERE player_id=t.id('p2')), 400);
SELECT t.igual('T15 refund na MESMA gaveta (cb1, não a enviada)', (SELECT count(*) FROM cashbox_transactions WHERE type='refund' AND cashbox_id=t.id('cb1') AND signed_amount=-100), 1);
SELECT t.igual('T15 gaveta 800', (SELECT current_balance FROM cashboxes WHERE id=t.id('cb1')), 800);
SELECT t.erro($$INSERT INTO house_credit_entries (organization_id, player_id, type, amount, reverses_entry_id, cashbox_id) VALUES (t.id('orgA'), t.id('p2'), 'payment_reversal', 100, (SELECT id FROM house_credit_entries WHERE client_mutation_id='pg-1'), t.id('cb1'))$$, 'uq_house_credit_entries_estorno');

-- ===== T17 estorno da venda fiada ==========================================
:OP
UPDATE cash_transactions SET status = 'cancelling', cancel_reason = 'erro', cancelled_by = t.id('uOp') WHERE client_mutation_id = 'rb-p2';
SELECT t.igual('T17 reverso lançado (dívida 0)', (SELECT balance FROM house_credit_accounts WHERE player_id=t.id('p2')), 0);
SELECT t.igual('T17 sessão sem a recompra', (SELECT total_buy_in FROM cash_player_sessions WHERE id=t.id('s2')), 100);
UPDATE cash_transactions SET status = 'cancelled' WHERE client_mutation_id = 'rb-p2';
SELECT t.igual('T17 um só reverso', (SELECT count(*) FROM house_credit_entries WHERE type='charge_reversal'), 1);
SELECT t.erro($$UPDATE cash_transactions SET status = 'active' WHERE client_mutation_id = 'rb-p2'$$, 'estorno_nao_se_desfaz');

-- ===== T18 estorno recusado depois de quitado: venda segue ativa ============
INSERT INTO cash_transactions (organization_id, cash_day_id, table_id, player_session_id, player_id, type, amount, payment_source, created_by, client_mutation_id)
VALUES (t.id('orgA'), t.id('d1'), t.id('mesa'), t.id('s2'), t.id('p2'), 'rebuy', 200, 'house_credit', t.id('uOp'), 'rb-p2b');
INSERT INTO house_credit_entries (organization_id, player_id, type, amount, payment_method, cashbox_id)
VALUES (t.id('orgA'), t.id('p2'), 'payment', 150, 'cash', t.id('cbBar'));
SELECT t.igual('T18 recebido no bar (módulo bar)', (SELECT count(*) FROM house_credit_entries WHERE module='bar' AND bar_shift_id=t.id('bar')), 1);
SELECT t.erro($$UPDATE cash_transactions SET status = 'cancelling' WHERE client_mutation_id = 'rb-p2b'$$, 'estorno_de_fiado_ja_quitado devido=50.00 solicitado=200');
SELECT t.igual('T18 venda continua ativa', (SELECT count(*) FROM cash_transactions WHERE client_mutation_id='rb-p2b' AND status='active'), 1);

-- ===== T19 cash-out com abatimento TOTAL: nada sai da gaveta ===============
SELECT t.igual('antes', (SELECT current_balance FROM cashboxes WHERE id=t.id('cb1')), 800);
INSERT INTO cash_transactions (organization_id, cash_day_id, table_id, player_session_id, player_id, type, amount, debt_settled_amount, cashbox_id, created_by)
VALUES (t.id('orgA'), t.id('d1'), t.id('mesa'), t.id('s2'), t.id('p2'), 'cash_out', 50, 50, t.id('cb1'), t.id('uOp'));
SELECT t.igual('T19 gaveta intacta', (SELECT current_balance FROM cashboxes WHERE id=t.id('cb1')), 800);
SELECT t.igual('T19 dívida 0', (SELECT balance FROM house_credit_accounts WHERE player_id=t.id('p2')), 0);

-- ===== T20 vencido bloqueia; com bloqueio desligado passa ===================
INSERT INTO cash_transactions (organization_id, cash_day_id, table_id, player_session_id, player_id, type, amount, payment_source, created_by)
VALUES (t.id('orgA'), t.id('d1'), t.id('mesa'), t.id('s1'), t.id('p1'), 'buy_in', 100, 'house_credit', t.id('uOp'));
:ROOT
-- Recua o histórico INTEIRO (preserva a ordem): pelo FIFO, o abatimento de 500
-- quitou as cargas de 300+200 e a de 100 é a que está em aberto há 40 dias.
UPDATE house_credit_entries SET created_at = created_at - interval '40 days' WHERE player_id = t.id('p1');
:OP
SELECT t.erro($$INSERT INTO cash_transactions (organization_id, cash_day_id, table_id, player_session_id, player_id, type, amount, payment_source, created_by)
  VALUES (t.id('orgA'), t.id('d1'), t.id('mesa'), t.id('s1'), t.id('p1'), 'rebuy', 50, 'house_credit', t.id('uOp'))$$, 'fiado_vencido');
SELECT t.igual('T20 FIFO: mais antiga em aberto tem 40 dias', (SELECT extract(day FROM now() - house_credit_oldest_open(id))::int FROM house_credit_accounts WHERE player_id=t.id('p1')), 40);
:SR
INSERT INTO house_credit_settings (organization_id, block_overdue, updated_by) VALUES (t.id('orgA'), false, t.id('uMgr'));
:OP
INSERT INTO cash_transactions (organization_id, cash_day_id, table_id, player_session_id, player_id, type, amount, payment_source, created_by)
VALUES (t.id('orgA'), t.id('d1'), t.id('mesa'), t.id('s1'), t.id('p1'), 'rebuy', 50, 'house_credit', t.id('uOp'));
SELECT t.igual('T20 sem bloqueio passa (dívida 150)', (SELECT balance FROM house_credit_accounts WHERE player_id=t.id('p1')), 150);
-- operador não muda config
SELECT t.erro($$INSERT INTO house_credit_settings (organization_id, block_overdue) VALUES (t.id('orgA'), false)$$, 'row-level security|duplicate');
UPDATE house_credit_settings SET due_days = 9999;
SELECT t.igual('T20 config intacta', (SELECT due_days FROM house_credit_settings), 30);

-- ===== T21 baixa ===========================================================
:SR
SELECT t.erro($$INSERT INTO house_credit_entries (organization_id, player_id, type, amount, created_by) VALUES (t.id('orgA'), t.id('p1'), 'write_off', 50, t.id('uMgr'))$$, 'hce_baixa_com_motivo');
INSERT INTO house_credit_entries (organization_id, player_id, type, amount, reason, created_by) VALUES (t.id('orgA'), t.id('p1'), 'write_off', 50, 'acordo', t.id('uMgr'));
SELECT t.igual('T21 baixa: dívida 100', (SELECT balance FROM house_credit_accounts WHERE player_id=t.id('p1')), 100);
SELECT t.igual('T21 baixa é do clube, sem gaveta', (SELECT count(*) FROM house_credit_entries WHERE type='write_off' AND module='club' AND cashbox_id IS NULL), 1);

-- ===== T22 isolamento entre organizações ====================================
RESET ROLE;
SET ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', t.id('uB'), 'organization_id', t.id('orgB'))::text, false);
SELECT t.igual('T22 org B não vê contas de A', (SELECT count(*) FROM house_credit_accounts), 0);
SELECT t.igual('T22 org B não vê extrato de A', (SELECT count(*) FROM house_credit_entries), 0);
SELECT t.erro($$INSERT INTO house_credit_entries (organization_id, player_id, type, amount, cashbox_id) VALUES (t.id('orgA'), t.id('p1'), 'payment', 10, t.id('cb1'))$$, 'row-level security|caixa');
SELECT t.erro($$INSERT INTO house_credit_entries (organization_id, player_id, type, amount, cashbox_id) VALUES (t.id('orgB'), t.id('p1'), 'payment', 10, t.id('cb1'))$$, 'caixa_de_outra_organizacao|caixa_fechado|fiado_nao_habilitado');

-- ===== T23 conferência final dos totais ====================================
:ROOT
SELECT t.igual('T23 saldo = soma do extrato (p1)', (SELECT SUM(signed_amount) FROM house_credit_entries WHERE player_id=t.id('p1')), (SELECT balance FROM house_credit_accounts WHERE player_id=t.id('p1')));
SELECT t.igual('T23 saldo = soma do extrato (p2)', (SELECT SUM(signed_amount) FROM house_credit_entries WHERE player_id=t.id('p2')), (SELECT balance FROM house_credit_accounts WHERE player_id=t.id('p2')));
SELECT t.igual('T23 gaveta = abertura + Σ ledger', (SELECT 1000 + SUM(signed_amount) FROM cashbox_transactions WHERE cashbox_id=t.id('cb1')), (SELECT current_balance FROM cashboxes WHERE id=t.id('cb1')));
SELECT t.igual('T23 balance_after encadeado', (SELECT count(*) FROM (SELECT balance_after, SUM(signed_amount) OVER (PARTITION BY account_id ORDER BY created_at, id) acum FROM house_credit_entries WHERE player_id=t.id('p2')) x WHERE balance_after <> acum), 0);
-- dono apaga (delete_organization roda como ele) — desfeito em seguida para
-- não desalinhar o extrato dos próximos roteiros
BEGIN;
DELETE FROM house_credit_entries WHERE player_id = t.id('p1') AND type = 'write_off';
ROLLBACK;
SELECT 'TODOS OS TESTES PASSARAM' AS resultado;
