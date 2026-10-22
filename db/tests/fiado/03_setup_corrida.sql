INSERT INTO t.ids VALUES ('p3', gen_random_uuid()), ('s3', gen_random_uuid());
INSERT INTO public.players (id, name, organization_id) VALUES (t.id('p3'),'Corrida',t.id('orgA'));
INSERT INTO public.cash_player_sessions (id, organization_id, cash_day_id, table_id, player_id) VALUES (t.id('s3'), t.id('orgA'), t.id('d1'), t.id('mesa'), t.id('p3'));
SET ROLE service_role;
INSERT INTO house_credit_accounts (organization_id, player_id, enabled, credit_limit) VALUES (t.id('orgA'), t.id('p3'), true, 500);
