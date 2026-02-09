-- Agent Analytics Core — Full Schema

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  event TEXT NOT NULL,
  properties TEXT,
  user_id TEXT,
  session_id TEXT,
  timestamp INTEGER NOT NULL,
  date TEXT NOT NULL
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
