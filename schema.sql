-- Agent Analytics Core — Full Schema

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  event TEXT NOT NULL,
  properties TEXT,
  user_id TEXT,
  session_id TEXT,
  timestamp INTEGER NOT NULL,
  date TEXT NOT NULL,
  country TEXT
);

CREATE INDEX IF NOT EXISTS idx_events_project_date ON events(project_id, date);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  user_id TEXT,
  project_id TEXT NOT NULL,
  start_time INTEGER NOT NULL,
  end_time INTEGER NOT NULL,
  duration INTEGER DEFAULT 0,
  entry_page TEXT,
  exit_page TEXT,
  event_count INTEGER DEFAULT 1,
  is_bounce INTEGER DEFAULT 1,
  date TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_project_date ON sessions(project_id, date);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(project_id, user_id);

CREATE TABLE IF NOT EXISTS identity_map (
  previous_id TEXT NOT NULL,
  canonical_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (previous_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_identity_canonical ON identity_map(canonical_id, project_id);

CREATE TABLE IF NOT EXISTS erasure_requests (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  project_name TEXT NOT NULL,
  idempotency_key_hash TEXT NOT NULL,
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
  UNIQUE (account_id, idempotency_key_hash)
);

CREATE INDEX IF NOT EXISTS idx_erasure_project_created
  ON erasure_requests(project_name, created_at);
