-- Multi-tenant: projects + usage tables

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  project_token TEXT UNIQUE NOT NULL,   -- public, for /track (aat_xxx)
  api_key TEXT UNIQUE NOT NULL,         -- private, for reads (aak_xxx)
  allowed_origins TEXT DEFAULT '*',     -- comma-separated origins for CORS
  tier TEXT DEFAULT 'free',             -- free | pro | enterprise
  rate_limit_events INTEGER DEFAULT 10000,   -- per day
  rate_limit_reads INTEGER DEFAULT 100,      -- per day
  data_retention_days INTEGER DEFAULT 30,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_token ON projects(project_token);
CREATE INDEX IF NOT EXISTS idx_projects_api_key ON projects(api_key);
CREATE INDEX IF NOT EXISTS idx_projects_email ON projects(owner_email);

CREATE TABLE IF NOT EXISTS usage (
  project_id TEXT NOT NULL,
  date TEXT NOT NULL,
  event_count INTEGER DEFAULT 0,
  read_count INTEGER DEFAULT 0,
  PRIMARY KEY (project_id, date),
  FOREIGN KEY (project_id) REFERENCES projects(id)
);
