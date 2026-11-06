-- Recorte do schema de prod (2026-10-26) para testar a migração do pagamento
-- dividido num cluster descartável: só as colunas e CHECKs que ela toca.
CREATE TABLE public.tournaments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), stage_id uuid);

CREATE TABLE public.transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tournament_id uuid REFERENCES tournaments(id),
  type varchar(20) NOT NULL CHECK (type IN ('buy_in','rebuy','addon','prize')),
  amount numeric NOT NULL,
  payment_method varchar(50),
  payment_source varchar(20) DEFAULT 'cash' CHECK (payment_source IN ('cash','credit','mixed','ticket')),
  status varchar(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelling','cancelled'))
);

CREATE TABLE public.cash_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type varchar(20) NOT NULL CHECK (type IN ('buy_in','rebuy','cash_out','jackpot_payout')),
  amount numeric(10,2) NOT NULL CHECK (amount > 0),
  payment_method varchar(50),
  payment_source varchar(50),
  status varchar(16) NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelling','cancelled'))
);

CREATE TABLE public.payment_methods (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code varchar(40) NOT NULL,
  label varchar(60) NOT NULL
);

-- Linhas antigas (sem divisão) têm de continuar válidas quando o CHECK entra.
INSERT INTO tournaments (id, stage_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
INSERT INTO transactions (tournament_id, type, amount, payment_method, payment_source) VALUES
  ('11111111-1111-1111-1111-111111111111', 'buy_in', 500, 'cash', 'cash'),
  ('11111111-1111-1111-1111-111111111111', 'buy_in', 500, NULL, 'cash'),
  ('11111111-1111-1111-1111-111111111111', 'buy_in', 0, 'cash', 'ticket'),
  ('11111111-1111-1111-1111-111111111111', 'prize', 900, NULL, NULL);
INSERT INTO cash_transactions (type, amount, payment_method, payment_source) VALUES
  ('buy_in', 1000, 'cash', NULL), ('cash_out', 400, 'cash', NULL), ('buy_in', 1000, NULL, 'house_credit');
INSERT INTO payment_methods (code, label) VALUES ('cash', 'Dinheiro'), ('yape', 'Yape');
