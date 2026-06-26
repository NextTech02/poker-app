-- Migration: player_statistics view -> security_invoker
-- Description: Resolves the Supabase security advisor ERROR
--   `security_definer_view` (0010) on public.player_statistics. The view ran
--   with the owner's permissions (definer), bypassing the querying role's RLS.
--   Switching to security_invoker makes it run with the caller's permissions +
--   RLS of the underlying tables.
--
-- Safe: the view is consumed only by the backend (player_service.py /
-- routers/players.py) via the Supabase service role, which bypasses RLS. The
-- underlying tables (players, tournament_players) already expose SELECT
-- policies to the authenticated role, and anon has none (so anon access is now
-- correctly denied — the point of the advisory).

ALTER VIEW public.player_statistics SET (security_invoker = on);
