\set ON_ERROR_STOP 1
-- Fase 3: prêmio de torneio desconta o fiado. Rodar DEPOIS de 02_cenarios.sql
-- e de database_migration_fiado_fase3_premio.sql (usa os helpers t.* e os dados).
\set OP 'SET ROLE authenticated; SELECT set_config(''request.jwt.claims'', json_build_object(''sub'', t.id(''uOp''), ''organization_id'', t.id(''orgA''))::text, false);'
\set SR 'SET ROLE service_role; SELECT set_config(''request.jwt.claims'', '''', false);'
\set ROOT 'RESET ROLE; SELECT set_config(''request.jwt.claims'', '''', false);'

-- p1 deve 100 (fim dos cenários). Prêmio de 300 com abatimento de 100.
:OP
SELECT t.igual('P0 p1 deve 100', (SELECT balance FROM house_credit_accounts WHERE player_id=t.id('p1')), 100);
INSERT INTO transactions (organization_id, player_id, type, prize_kind, amount, payment_source, house_debt_offset, house_debt_offset_expected, created_by, notes)
VALUES (t.id('orgA'), t.id('p1'), 'prize', 'position', 300, 'cash', 100, 100, t.id('uOp'), 'premio-1');
SELECT t.igual('P1 prêmio continua BRUTO', (SELECT amount FROM transactions WHERE notes='premio-1'), 300);
SELECT t.igual('P1 dívida quitada pelo prêmio', (SELECT balance FROM house_credit_accounts WHERE player_id=t.id('p1')), 0);
SELECT t.igual('P1 lançamento do tipo prize_offset, módulo torneio',
  (SELECT count(*) FROM house_credit_entries WHERE type='prize_offset' AND module='tournament'
     AND transaction_id = (SELECT id FROM transactions WHERE notes='premio-1')), 1);

-- Abater mais do que deve: o prêmio inteiro é recusado (corrida com recebimento).
SELECT t.erro($$INSERT INTO transactions (organization_id, player_id, type, prize_kind, amount, payment_source, house_debt_offset, created_by)
  VALUES (t.id('orgA'), t.id('p1'), 'prize', 'position', 300, 'cash', 50, t.id('uOp'))$$, 'valor_maior_que_a_divida');
-- Abatimento só em prêmio, e nunca acima do bruto.
SELECT t.erro($$INSERT INTO transactions (organization_id, player_id, type, amount, house_debt_offset, created_by)
  VALUES (t.id('orgA'), t.id('p1'), 'buy_in', 300, 10, t.id('uOp'))$$, 'transactions_abatimento_fiado');
SELECT t.erro($$INSERT INTO transactions (organization_id, player_id, type, amount, house_debt_offset, created_by)
  VALUES (t.id('orgA'), t.id('p1'), 'prize', 10, 20, t.id('uOp'))$$, 'transactions_abatimento_fiado');
-- prize_offset solto pelo navegador: recusado.
SELECT t.erro($$INSERT INTO house_credit_entries (organization_id, player_id, type, amount, transaction_id)
  VALUES (t.id('orgA'), t.id('p1'), 'prize_offset', 100, (SELECT id FROM transactions WHERE notes='premio-1'))$$, 'lancamento_so_pelo_caixa');
-- Prêmio que abateu é imutável e não se estorna.
SELECT t.erro($$UPDATE transactions SET amount = 1 WHERE notes='premio-1'$$, 'lancamento_imutavel');
SELECT t.erro($$UPDATE transactions SET status = 'cancelling' WHERE notes='premio-1'$$, 'lancamento_imutavel');
-- Prêmio sem fiado segue livre (nada muda para o torneio comum).
INSERT INTO transactions (organization_id, player_id, type, prize_kind, amount, payment_source, created_by, notes)
VALUES (t.id('orgA'), t.id('p2'), 'prize', 'knockout', 50, 'cash', t.id('uOp'), 'ko-1');
UPDATE transactions SET notes = 'ko-1b' WHERE notes = 'ko-1';
SELECT t.igual('P2 prêmio comum não gera lançamento', (SELECT count(*) FROM house_credit_entries WHERE type='prize_offset'), 1);

:ROOT
SELECT t.igual('P3 saldo = Σ extrato (p1)', (SELECT SUM(signed_amount) FROM house_credit_entries WHERE player_id=t.id('p1')), (SELECT balance FROM house_credit_accounts WHERE player_id=t.id('p1')));
SELECT 'FASE 3: TODOS OS TESTES PASSARAM' AS resultado;
