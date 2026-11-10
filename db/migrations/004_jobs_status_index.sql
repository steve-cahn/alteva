-- History can be filtered by status and is always listed newest first. For a RARE status this lets
-- Postgres read just that status's jobs, already in (created_at, id) order, instead of scanning the
-- whole table and discarding the rest. Measured on 200,000 jobs with 24 Canceled: 14.5 ms (parallel
-- sequential scan) down to 0.3 ms (index-only scan), and the gap grows with the table. Common
-- statuses were already fast through jobs_created_at_idx, and the planner keeps using that for them.
-- It does not speed up the per-status counts (about 19 ms at that size either way).
CREATE INDEX jobs_status_created_idx ON jobs (status, created_at DESC, id DESC);
