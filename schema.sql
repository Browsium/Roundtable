-- Roundtable D1 Schema (Workers)
-- Idempotent: safe to re-run via `wrangler d1 execute ... --file=../schema.sql`

-- Personas table - stores persona definitions for analysis
CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  profile_json TEXT NOT NULL,
  version TEXT,
  skill_name TEXT,
  skill_path TEXT,
  is_system INTEGER DEFAULT 0,
  status TEXT DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deployed_at TEXT
);

-- Sessions table - stores document analysis sessions
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_r2_key TEXT NOT NULL,
  file_size_bytes INTEGER NOT NULL,
  file_extension TEXT NOT NULL,
  selected_persona_ids TEXT NOT NULL,
  status TEXT DEFAULT 'uploaded',
  analysis_provider TEXT,
  analysis_model TEXT,
  workflow TEXT,
  analysis_config_json TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Analyses table - stores individual persona analysis results
CREATE TABLE IF NOT EXISTS analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  analysis_provider TEXT,
  analysis_model TEXT,
  score_json TEXT,
  top_issues_json TEXT,
  rewritten_suggestions_json TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Persona groups (role variants, etc.)
CREATE TABLE IF NOT EXISTS persona_groups (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  group_type TEXT NOT NULL,
  role_key TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  base_persona_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS persona_group_members (
  group_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (group_id, persona_id),
  FOREIGN KEY (group_id) REFERENCES persona_groups(id) ON DELETE CASCADE,
  FOREIGN KEY (persona_id) REFERENCES personas(id) ON DELETE CASCADE
);

-- Analysis artifacts (council member outputs, peer reviews, critiques, chair finals, etc.)
CREATE TABLE IF NOT EXISTS analysis_artifacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL,
  backend_provider TEXT,
  backend_model TEXT,
  content_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Session shares table - for sharing sessions to other Access-authenticated emails
CREATE TABLE IF NOT EXISTS session_shares (
  session_id TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, email),
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Share tokens table - for public share links
CREATE TABLE IF NOT EXISTS share_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,
  session_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  view_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Settings table (for global settings like share expiry default)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Default settings
INSERT INTO settings (key, value, updated_at)
VALUES ('share_expiry_days', '30', datetime('now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now');

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_analyses_session ON analyses(session_id);
CREATE INDEX IF NOT EXISTS idx_analyses_persona ON analyses(persona_id);
CREATE INDEX IF NOT EXISTS idx_persona_groups_owner ON persona_groups(owner_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_persona_group_members_group ON persona_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_persona_group_members_persona ON persona_group_members(persona_id);
CREATE INDEX IF NOT EXISTS idx_analysis_artifacts_session ON analysis_artifacts(session_id);
CREATE INDEX IF NOT EXISTS idx_analysis_artifacts_session_persona ON analysis_artifacts(session_id, persona_id);
CREATE INDEX IF NOT EXISTS idx_analysis_artifacts_type ON analysis_artifacts(artifact_type);
CREATE INDEX IF NOT EXISTS idx_session_shares_email ON session_shares(email);
CREATE INDEX IF NOT EXISTS idx_session_shares_session ON session_shares(session_id);
CREATE INDEX IF NOT EXISTS idx_share_tokens_token ON share_tokens(token);
CREATE INDEX IF NOT EXISTS idx_share_tokens_expires ON share_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_share_tokens_session ON share_tokens(session_id);
