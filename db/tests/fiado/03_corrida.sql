SET ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', t.id('uOp'), 'organization_id', t.id('orgA'))::text, false);
BEGIN;
INSERT INTO cash_transactions (organization_id, cash_day_id, table_id, player_session_id, player_id, type, amount, payment_source, created_by, notes)
VALUES (t.id('orgA'), t.id('d1'), t.id('mesa'), t.id('s3'), t.id('p3'), 'rebuy', 300, 'house_credit', t.id('uOp'), :'quem');
SELECT pg_sleep(:espera);
COMMIT;
