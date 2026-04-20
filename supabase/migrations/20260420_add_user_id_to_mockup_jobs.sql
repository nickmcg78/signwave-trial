-- Add user_id column to mockup_jobs to track ownership.
--
-- Why: the edge function authenticates the user via JWT but never stored
-- the resulting user.id alongside the mockup. Without this, we cannot
-- build per-user history ("My Mockups") or admin views that show who
-- created what.
--
-- Backwards-compatible: column is nullable, so existing rows (created
-- before this migration) keep user_id = NULL. They simply won't appear
-- in any per-user history view, which is acceptable for trial data.
--
-- New rows inserted by the edge function (after the matching code
-- change is deployed) will populate user_id.
--
-- Index: speeds up the "my mockups newest-first" query the franchisee
-- dashboard runs.
--
-- RLS not added in this migration. The trial has 6 trusted users; the
-- result page polls by job_id (always known) and the history page filters
-- by user_id at the application layer. RLS can be added as a separate
-- hardening step before broader rollout.

ALTER TABLE mockup_jobs
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS mockup_jobs_user_id_created_at_idx
  ON mockup_jobs (user_id, created_at DESC);
