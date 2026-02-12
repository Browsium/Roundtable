-- personas table (source of truth)
CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  version TEXT NOT NULL,
  skill_name TEXT NOT NULL,
  skill_path TEXT NOT NULL,
  is_system BOOLEAN DEFAULT 1,
  status TEXT DEFAULT 'draft',
  created_at TEXT,
  updated_at TEXT,
  deployed_at TEXT
);

-- sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_r2_key TEXT NOT NULL,
  file_size_bytes INTEGER,
  file_extension TEXT,
  selected_persona_ids TEXT,
  status TEXT,
  created_at TEXT,
  updated_at TEXT
);

-- analyses table
CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  status TEXT,
  score_json TEXT,
  top_issues_json TEXT,
  rewritten_suggestions_json TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_sessions_user_email ON sessions(user_email);
CREATE INDEX IF NOT EXISTS idx_analyses_session_id ON analyses(session_id);
CREATE INDEX IF NOT EXISTS idx_analyses_persona_id ON analyses(persona_id);
