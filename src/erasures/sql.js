/**
 * Audit table for subject erasure receipts.
 * schema.sql carries the same statements for Node startup and wrangler d1 execute.
 * Hosted identity tables are not created here. OSS only has identity_map.
 */

export const CREATE_ERASURE_REQUESTS = `
CREATE TABLE IF NOT EXISTS erasure_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  subject_type TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  counts_json TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  requested_by TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  replay_included INTEGER NOT NULL,
  UNIQUE (account_id, idempotency_key)
)
`.trim();

export const CREATE_ERASURE_INDEX = `
CREATE INDEX IF NOT EXISTS idx_erasure_project_created
  ON erasure_requests(project_name, created_at)
`.trim();
