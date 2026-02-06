-- Agent Analytics Schema

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL,
  event TEXT NOT NULL,
  properties TEXT,
  user_id TEXT,
  timestamp INTEGER NOT NULL,
  date TEXT NOT NULL,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for fast queries
CREATE INDEX IF NOT EXISTS idx_project_date ON events(project_id, date);
CREATE INDEX IF NOT EXISTS idx_project_event ON events(project_id, event);
CREATE INDEX IF NOT EXISTS idx_project_user ON events(project_id, user_id);
CREATE INDEX IF NOT EXISTS idx_timestamp ON events(timestamp DESC);
