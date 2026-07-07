-- Migration: enable Supabase Realtime on the live-screen tables
-- Feeds the always-on screens (Control /control/:dayId and Broadcast
-- /broadcast/:dayId) so operator commands and blind edits push to all clients
-- near-instantly, instead of waiting for the 3s poll. Consumed by
-- frontend/src/hooks/useTimerSync.js (postgres_changes subscriptions).
--
-- Applied to prod on 2026-07-07 via Supabase MCP (name: enable_realtime_timer_blinds).
-- Idempotent — safe to re-run.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_rel pr
    JOIN pg_publication p ON p.oid = pr.prpubid
    JOIN pg_class c ON c.oid = pr.prrelid
    WHERE p.pubname = 'supabase_realtime' AND c.relname = 'tournament_days'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.tournament_days;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_rel pr
    JOIN pg_publication p ON p.oid = pr.prpubid
    JOIN pg_class c ON c.oid = pr.prrelid
    WHERE p.pubname = 'supabase_realtime' AND c.relname = 'blinds'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.blinds;
  END IF;
END $$;

-- blinds is filtered by tournament_day_id (non-PK) in the Realtime subscription;
-- REPLICA IDENTITY FULL puts the filter column in the WAL for UPDATE/DELETE.
-- tournament_days is filtered by id (PK), so its default replica identity is enough.
ALTER TABLE public.blinds REPLICA IDENTITY FULL;
