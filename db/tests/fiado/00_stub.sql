-- Stub mínimo e fiel ao prod (colunas/triggers/políticas vigentes em 2026-10-22)
-- para testar a migração do fiado num cluster descartável.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE TABLE auth.mfa_factors (user_id uuid, status text);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULLIF(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub', '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS
$$ SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
CREATE PUBLICATION supabase_realtime;

CREATE TABLE public.organizations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL, slug text NOT NULL, status text NOT NULL DEFAULT 'active');

CREATE FUNCTION public.current_org_id() RETURNS uuid LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $function$
DECLARE raw text; v_org uuid;
BEGIN
    raw := current_setting('request.jwt.claims', true);
    IF raw IS NULL OR raw = '' THEN RETURN NULL; END IF;
    BEGIN v_org := NULLIF(raw::jsonb ->> 'organization_id', '')::uuid;
    EXCEPTION WHEN OTHERS THEN RETURN NULL; END;
    IF v_org IS NULL THEN RETURN NULL; END IF;
    RETURN (SELECT o.id FROM public.organizations o WHERE o.id = v_org AND o.status = 'active');
END $function$;
CREATE FUNCTION public.is_platform_admin() RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE FUNCTION public.mfa_satisfeito() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','auth','pg_temp' AS $$
  SELECT NOT EXISTS (SELECT 1 FROM auth.mfa_factors f WHERE f.user_id = auth.uid() AND f.status = 'verified')
         OR COALESCE(auth.jwt() ->> 'aal', 'aal1') = 'aal2'; $$;
CREATE FUNCTION public.log_activity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN COALESCE(NEW, OLD); END $$;
CREATE FUNCTION public.update_updated_at_column() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

CREATE TABLE public.players (id uuid PRIMARY KEY DEFAULT uuid_generate_v4(), name varchar(255) NOT NULL, phone varchar(50), nickname varchar(100), document_type varchar(50) NOT NULL DEFAULT 'cpf', document_number varchar(100) NOT NULL DEFAULT '0', organization_id uuid NOT NULL DEFAULT current_org_id());
CREATE TABLE public.staff (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), auth_user_id uuid NOT NULL, name varchar(255) NOT NULL, email varchar(255) NOT NULL DEFAULT 'x@x', permission_group_id uuid, active boolean NOT NULL DEFAULT true, organization_id uuid NOT NULL DEFAULT current_org_id());
CREATE TABLE public.permission_groups (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(100) NOT NULL, permissions text[] NOT NULL DEFAULT '{}', updated_at timestamptz DEFAULT CURRENT_TIMESTAMP, organization_id uuid NOT NULL DEFAULT current_org_id());
CREATE TABLE public.cash_days (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL DEFAULT current_org_id(), business_date date NOT NULL, status varchar(16) NOT NULL DEFAULT 'open');
CREATE TABLE public.cash_tables (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL DEFAULT current_org_id(), cash_day_id uuid NOT NULL REFERENCES cash_days(id), table_number smallint NOT NULL DEFAULT 1);
CREATE TABLE public.cash_player_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL DEFAULT current_org_id(), cash_day_id uuid NOT NULL, table_id uuid NOT NULL, player_id uuid NOT NULL, seat_number smallint NOT NULL DEFAULT 1, status varchar(16) NOT NULL DEFAULT 'active', total_buy_in numeric(12,2) NOT NULL DEFAULT 0, total_cash_out numeric(12,2) NOT NULL DEFAULT 0, result numeric(12,2) NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE public.bar_shifts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL DEFAULT current_org_id(), business_date date NOT NULL DEFAULT current_date, status varchar(16) NOT NULL DEFAULT 'open');
CREATE TABLE public.cashbox_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cashbox_id uuid NOT NULL, initial_balance numeric(10,2) NOT NULL DEFAULT 0, organization_id uuid NOT NULL DEFAULT current_org_id());
CREATE TABLE public.cashboxes (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), staff_id uuid NOT NULL, stage_id uuid, status varchar(16) NOT NULL DEFAULT 'closed', current_balance numeric(10,2) NOT NULL DEFAULT 0, current_session_id uuid, updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP, organization_id uuid NOT NULL DEFAULT current_org_id(), cash_day_id uuid, bar_shift_id uuid);
CREATE TABLE public.chip_consignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE public.cash_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL DEFAULT current_org_id(),
  cash_day_id uuid NOT NULL REFERENCES cash_days(id), table_id uuid, player_session_id uuid REFERENCES cash_player_sessions(id) ON DELETE SET NULL,
  player_id uuid REFERENCES players(id), type varchar(20) NOT NULL CHECK (type IN ('buy_in','rebuy','cash_out','jackpot_payout')),
  amount numeric NOT NULL CHECK (amount > 0), payment_method varchar(50), payment_source varchar(50),
  cashbox_id uuid REFERENCES cashboxes(id) ON DELETE SET NULL, client_mutation_id text,
  status varchar(16) DEFAULT 'active' CHECK (status IN ('active','cancelling','cancelled')),
  cancelled_at timestamptz, cancelled_by uuid REFERENCES auth.users(id), cancel_reason text, cancel_steps text[], notes text,
  created_by uuid REFERENCES auth.users(id), created_at timestamptz DEFAULT now(), consignment_id uuid REFERENCES chip_consignments(id));
CREATE TABLE public.cashbox_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cashbox_id uuid NOT NULL REFERENCES cashboxes(id), session_id uuid,
  type varchar(20) NOT NULL, amount numeric(10,2) NOT NULL CHECK (amount >= 0), signed_amount numeric(10,2) NOT NULL,
  transaction_id uuid, performed_by uuid, notes text, created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  organization_id uuid NOT NULL DEFAULT current_org_id(), cash_transaction_id uuid REFERENCES cash_transactions(id) ON DELETE SET NULL, bar_payment_id uuid,
  CONSTRAINT cashbox_transactions_type_check CHECK (type IN ('buy_in','rebuy','addon','prize','supply','sangria','refund','adjustment','cash_buy_in','cash_out','bar_sale')));

-- Torneio (fase 3: prêmio desconta fiado)
CREATE TABLE public.transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL DEFAULT current_org_id(),
  tournament_id uuid NOT NULL DEFAULT gen_random_uuid(), player_id uuid NOT NULL REFERENCES players(id),
  type varchar(20) NOT NULL CHECK (type IN ('buy_in','rebuy','addon','prize')), amount numeric NOT NULL,
  payment_method varchar(50), payment_source varchar(50), prize_kind varchar(20), notes text,
  created_by uuid REFERENCES auth.users(id), created_at timestamptz DEFAULT now(), cashbox_id uuid,
  status varchar(16) NOT NULL DEFAULT 'active');
CREATE TABLE public.prize_allocations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL DEFAULT current_org_id(),
  tournament_id uuid NOT NULL, position int NOT NULL, prize_amount numeric NOT NULL, paid boolean DEFAULT false);
CREATE TABLE public.tournament_knockout_payouts (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL DEFAULT current_org_id(),
  tournament_id uuid NOT NULL, knockout_id uuid NOT NULL DEFAULT gen_random_uuid(), cash_amount numeric NOT NULL, paid boolean NOT NULL DEFAULT false);

-- Triggers vigentes em prod
CREATE FUNCTION public.update_cashbox_balance_on_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN UPDATE cashboxes SET current_balance = current_balance + NEW.signed_amount, updated_at = CURRENT_TIMESTAMP WHERE id = NEW.cashbox_id; RETURN NEW; END $$;
CREATE TRIGGER trg_update_cashbox_balance AFTER INSERT ON public.cashbox_transactions FOR EACH ROW EXECUTE FUNCTION update_cashbox_balance_on_transaction();

CREATE FUNCTION public.cash_touch_player_session() RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $function$
DECLARE v_ps UUID;
BEGIN
    FOREACH v_ps IN ARRAY ARRAY[CASE WHEN TG_OP <> 'DELETE' THEN NEW.player_session_id END, CASE WHEN TG_OP <> 'INSERT' THEN OLD.player_session_id END] LOOP
        CONTINUE WHEN v_ps IS NULL;
        UPDATE public.cash_player_sessions ps
           SET total_buy_in = COALESCE(t.entradas, 0), total_cash_out = COALESCE(t.saidas, 0),
               result = COALESCE(t.saidas, 0) - COALESCE(t.entradas, 0), updated_at = now()
          FROM (SELECT SUM(CASE WHEN type IN ('buy_in','rebuy') THEN amount ELSE 0 END) AS entradas,
                       SUM(CASE WHEN type = 'cash_out' THEN amount ELSE 0 END) AS saidas
                  FROM public.cash_transactions WHERE player_session_id = v_ps AND COALESCE(status,'active') = 'active') t
         WHERE ps.id = v_ps;
    END LOOP;
    RETURN COALESCE(NEW, OLD);
END $function$;
CREATE TRIGGER trg_cash_touch_player_session AFTER INSERT OR DELETE OR UPDATE ON public.cash_transactions FOR EACH ROW EXECUTE FUNCTION cash_touch_player_session();

-- Versões ANTIGAS (a migração substitui)
CREATE FUNCTION public.resolve_cash_transaction_cashbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE FUNCTION public.mirror_cash_transaction_to_cashbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE TRIGGER trg_resolve_cash_tx_cashbox BEFORE INSERT ON public.cash_transactions FOR EACH ROW EXECUTE FUNCTION resolve_cash_transaction_cashbox();
CREATE TRIGGER trg_mirror_cash_tx AFTER INSERT ON public.cash_transactions FOR EACH ROW EXECUTE FUNCTION mirror_cash_transaction_to_cashbox();

-- RLS como em prod: FOR ALL por org + 2FA restritiva
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['players','staff','cash_days','cash_tables','cash_player_sessions','bar_shifts','cashbox_sessions','cashboxes','cash_transactions','cashbox_transactions','permission_groups','transactions','prize_allocations','tournament_knockout_payouts'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (organization_id = (SELECT public.current_org_id()) OR (SELECT public.is_platform_admin())) WITH CHECK (organization_id = (SELECT public.current_org_id()) OR (SELECT public.is_platform_admin()))', t||'_org_isolation', t);
    EXECUTE format('CREATE POLICY %I ON public.%I AS RESTRICTIVE TO authenticated USING ((SELECT public.mfa_satisfeito()))', t||'_exige_mfa', t);
  END LOOP;
END $$;

GRANT USAGE ON SCHEMA public, auth TO authenticated, service_role, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated, service_role, anon;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, service_role, anon;
GRANT SELECT ON auth.users, auth.mfa_factors TO authenticated, service_role;
