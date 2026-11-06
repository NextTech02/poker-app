-- Cenários do pagamento dividido. Rodar DEPOIS de 00_stub.sql e da migração.
-- Termina em "PAGAMENTO DIVIDIDO: TODOS OS TESTES PASSARAM".

-- Tenta uma instrução e exige que o CHECK recuse.
CREATE OR REPLACE FUNCTION pg_temp.recusa(p_sql text, p_motivo text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN check_violation THEN
    RETURN;
  END;
  RAISE EXCEPTION 'deveria recusar: %', p_motivo;
END $$;

DO $t$
DECLARE
  t uuid := '11111111-1111-1111-1111-111111111111';
  v_id uuid;
  r record;
BEGIN
  -- Os CHECKs entraram validados sobre as linhas antigas.
  IF (SELECT count(*) FROM pg_constraint
       WHERE conname IN ('transactions_pagamento_dividido','cash_tx_pagamento_dividido',
                         'payment_methods_codigo_reservado') AND convalidated) <> 3 THEN
    RAISE EXCEPTION 'CHECKs não validados';
  END IF;

  -- ── Função de validação ─────────────────────────────────────────────────
  IF NOT public.pagamento_dividido_valido(
       '[{"payment_method":"cash","amount":300},{"payment_method":"transfer","amount":200}]', 500) THEN
    RAISE EXCEPTION '300 + 200 = 500 deveria valer';
  END IF;
  IF NOT public.pagamento_dividido_valido(
       '[{"payment_method":"cash","amount":0.1},{"payment_method":"pix","amount":0.2}]', 0.30) THEN
    RAISE EXCEPTION 'centavos: 0.1 + 0.2 = 0.30 deveria valer';
  END IF;
  IF public.pagamento_dividido_valido('[{"payment_method":"cash","amount":500}]', 500) THEN
    RAISE EXCEPTION 'uma parte só não é divisão';
  END IF;
  IF public.pagamento_dividido_valido(
       '[{"payment_method":"cash","amount":"300"},{"payment_method":"pix","amount":200}]', 500) THEN
    RAISE EXCEPTION 'valor em texto deveria recusar (sem erro de conversão)';
  END IF;
  IF public.pagamento_dividido_valido(
       '[{"payment_method":"cash","amount":"abc"},{"payment_method":"pix","amount":200}]', 500) THEN
    RAISE EXCEPTION 'valor não numérico deveria recusar';
  END IF;
  IF public.pagamento_dividido_valido(
       '[{"payment_method":"cash","amount":300.001},{"payment_method":"pix","amount":199.999}]', 500) THEN
    RAISE EXCEPTION 'mais de 2 casas deveria recusar';
  END IF;
  IF public.pagamento_dividido_valido(
       '[{"payment_method":"cash","amount":300},{"payment_method":"cash","amount":200}]', 500) THEN
    RAISE EXCEPTION 'meio repetido deveria recusar';
  END IF;
  IF public.pagamento_dividido_valido(
       '[{"payment_method":"split","amount":300},{"payment_method":"pix","amount":200}]', 500) THEN
    RAISE EXCEPTION 'parte com meio split deveria recusar';
  END IF;
  IF public.pagamento_dividido_valido(
       '[{"payment_method":"","amount":300},{"payment_method":"pix","amount":200}]', 500) THEN
    RAISE EXCEPTION 'meio vazio deveria recusar';
  END IF;
  IF public.pagamento_dividido_valido(
       '[{"payment_method":"cash","amount":0},{"payment_method":"pix","amount":500}]', 500) THEN
    RAISE EXCEPTION 'parte zero deveria recusar';
  END IF;
  IF public.pagamento_dividido_valido(
       '[{"payment_method":"cash","amount":300},{"payment_method":"pix","amount":150}]', 500) THEN
    RAISE EXCEPTION 'soma menor que o valor deveria recusar';
  END IF;
  IF public.pagamento_dividido_valido('{"payment_method":"cash"}', 500) THEN
    RAISE EXCEPTION 'objeto no lugar de lista deveria recusar';
  END IF;
  IF public.pagamento_dividido_valido('[1, 2]', 3) THEN
    RAISE EXCEPTION 'lista de números deveria recusar';
  END IF;

  -- ── Torneio: grava venda dividida ───────────────────────────────────────
  INSERT INTO transactions (tournament_id, type, amount, payment_method, payment_source, payment_split)
  VALUES (t, 'buy_in', 500, 'split', 'cash',
          '[{"payment_method":"cash","amount":300},{"payment_method":"transfer","amount":200}]')
  RETURNING id INTO v_id;
  -- payment_source nulo conta como dinheiro.
  INSERT INTO transactions (tournament_id, type, amount, payment_method, payment_source, payment_split)
  VALUES (t, 'addon', 50, 'split', NULL,
          '[{"payment_method":"transfer","amount":30},{"payment_method":"yape","amount":20}]');

  PERFORM pg_temp.recusa(format(
    $$INSERT INTO transactions (tournament_id, type, amount, payment_method) VALUES (%L, 'buy_in', 500, 'split')$$, t),
    'split sem partes');
  PERFORM pg_temp.recusa(format(
    $$INSERT INTO transactions (tournament_id, type, amount, payment_method, payment_split)
      VALUES (%L, 'buy_in', 500, 'cash', '[{"payment_method":"cash","amount":300},{"payment_method":"pix","amount":200}]')$$, t),
    'partes sem payment_method = split');
  PERFORM pg_temp.recusa(format(
    $$INSERT INTO transactions (tournament_id, type, amount, payment_method, payment_split)
      VALUES (%L, 'buy_in', 500, 'split', '[{"payment_method":"cash","amount":300},{"payment_method":"pix","amount":100}]')$$, t),
    'soma errada');
  PERFORM pg_temp.recusa(format(
    $$INSERT INTO transactions (tournament_id, type, amount, payment_method, payment_split)
      VALUES (%L, 'prize', 500, 'split', '[{"payment_method":"cash","amount":300},{"payment_method":"pix","amount":200}]')$$, t),
    'prêmio dividido');
  PERFORM pg_temp.recusa(format(
    $$INSERT INTO transactions (tournament_id, type, amount, payment_method, payment_source, payment_split)
      VALUES (%L, 'buy_in', 500, 'split', 'credit', '[{"payment_method":"cash","amount":300},{"payment_method":"pix","amount":200}]')$$, t),
    'crédito de patrocinador dividido');
  PERFORM pg_temp.recusa(format(
    $$INSERT INTO transactions (tournament_id, type, amount, payment_method, payment_source, payment_split)
      VALUES (%L, 'buy_in', 500, 'split', 'mixed', '[{"payment_method":"cash","amount":300},{"payment_method":"pix","amount":200}]')$$, t),
    'crédito + dinheiro dividido');

  -- Mudar o valor de uma venda dividida sem refazer as partes: recusado.
  PERFORM pg_temp.recusa(format($$UPDATE transactions SET amount = 600 WHERE id = %L$$, v_id),
    'valor alterado sem as partes');
  -- Trocar para um meio só limpa as partes (é o que o backend faz).
  UPDATE transactions SET payment_method = 'pix', payment_split = NULL WHERE id = v_id;
  UPDATE transactions SET payment_method = 'split',
         payment_split = '[{"payment_method":"cash","amount":300},{"payment_method":"transfer","amount":200}]'
   WHERE id = v_id;
  -- Estornar (mudar status) segue livre.
  UPDATE transactions SET status = 'cancelling' WHERE id = v_id;
  UPDATE transactions SET status = 'active' WHERE id = v_id;

  -- ── RPC: soma por meio lendo as partes ──────────────────────────────────
  -- Antigas: cash 500 (1), NULL 500 (1), cash 0 do ticket (1) → cash 500 em 2.
  -- Novas: buy-in 300 cash + 200 transfer; add-on 30 transfer + 20 yape.
  FOR r IN SELECT * FROM public.get_stage_totals_by_payment_method('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') LOOP
    RAISE NOTICE 'meio=% total=% partes=%', r.payment_method, r.total, r.entries;
  END LOOP;
  IF (SELECT total FROM public.get_stage_totals_by_payment_method('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
       WHERE payment_method = 'cash') <> 800 THEN
    RAISE EXCEPTION 'dinheiro deveria somar 800 (500 antigo + 300 da parte)';
  END IF;
  IF (SELECT total FROM public.get_stage_totals_by_payment_method('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
       WHERE payment_method = 'transfer') <> 230 THEN
    RAISE EXCEPTION 'transferência deveria somar 230';
  END IF;
  IF (SELECT total FROM public.get_stage_totals_by_payment_method('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
       WHERE payment_method = 'yape') <> 20 THEN
    RAISE EXCEPTION 'yape deveria somar 20';
  END IF;
  IF (SELECT total FROM public.get_stage_totals_by_payment_method('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
       WHERE payment_method IS NULL) <> 500 THEN
    RAISE EXCEPTION 'balde sem meio deveria continuar com 500';
  END IF;
  IF EXISTS (SELECT 1 FROM public.get_stage_totals_by_payment_method('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
              WHERE payment_method = 'split') THEN
    RAISE EXCEPTION 'a RPC nunca devolve o balde split';
  END IF;
  -- Total por meio = total das vendas ativas (nada some, nada dobra).
  IF (SELECT sum(total) FROM public.get_stage_totals_by_payment_method('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'))
     <> (SELECT sum(amount) FROM transactions WHERE type <> 'prize' AND status = 'active') THEN
    RAISE EXCEPTION 'soma por meio diferente da soma das vendas';
  END IF;

  -- Venda dividida cancelada sai das duas partes.
  UPDATE transactions SET status = 'cancelled' WHERE id = v_id;
  IF (SELECT total FROM public.get_stage_totals_by_payment_method('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
       WHERE payment_method = 'cash') <> 500 THEN
    RAISE EXCEPTION 'cancelada deveria sair do dinheiro';
  END IF;
  IF (SELECT total FROM public.get_stage_totals_by_payment_method('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
       WHERE payment_method = 'transfer') <> 30 THEN
    RAISE EXCEPTION 'cancelada deveria sair da transferência';
  END IF;

  -- ── Cash game ───────────────────────────────────────────────────────────
  INSERT INTO cash_transactions (type, amount, payment_method, payment_source, payment_split)
  VALUES ('buy_in', 1000, 'split', 'cash',
          '[{"payment_method":"cash","amount":600},{"payment_method":"transfer","amount":400}]');
  INSERT INTO cash_transactions (type, amount, payment_method, payment_source, payment_split)
  VALUES ('rebuy', 500.50, 'split', NULL,
          '[{"payment_method":"cash","amount":500},{"payment_method":"yape","amount":0.5}]');
  PERFORM pg_temp.recusa(
    $$INSERT INTO cash_transactions (type, amount, payment_method, payment_split)
      VALUES ('cash_out', 1000, 'split', '[{"payment_method":"cash","amount":600},{"payment_method":"pix","amount":400}]')$$,
    'cash-out dividido');
  PERFORM pg_temp.recusa(
    $$INSERT INTO cash_transactions (type, amount, payment_method, payment_source, payment_split)
      VALUES ('buy_in', 1000, 'split', 'house_credit', '[{"payment_method":"cash","amount":600},{"payment_method":"pix","amount":400}]')$$,
    'fiado dividido');
  PERFORM pg_temp.recusa(
    $$INSERT INTO cash_transactions (type, amount, payment_method) VALUES ('buy_in', 1000, 'split')$$,
    'split sem partes no cash');

  -- ── Meio reservado ──────────────────────────────────────────────────────
  PERFORM pg_temp.recusa($$INSERT INTO payment_methods (code, label) VALUES ('split', 'Split')$$,
    'código reservado');

  RAISE NOTICE 'PAGAMENTO DIVIDIDO: TODOS OS TESTES PASSARAM';
END $t$;
