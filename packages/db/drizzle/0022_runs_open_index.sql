-- Only unfinished runs (at most the fleet cap): submit admission counts them and
-- the stuck-run cleanup scans them, so neither reads the whole runs table.
-- Not CONCURRENTLY: drizzle runs each migration in a transaction, and runs is
-- small enough that the brief write lock during the build is unnoticeable.
CREATE INDEX IF NOT EXISTS "runs_open_idx" ON "runs" ("status") WHERE "status" IN ('queued', 'running');
