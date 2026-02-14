-- D1 Schema Migration: 003_add_workflows_persona_groups_artifacts
-- Adds:
-- - session workflow + config fields
-- - persona variant groups
-- - analysis artifacts storage (for council + discussion internals)

ALTER TABLE sessions ADD COLUMN workflow TEXT;
ALTER TABLE sessions ADD COLUMN analysis_config_json TEXT;

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

CREATE INDEX IF NOT EXISTS idx_persona_groups_owner ON persona_groups(owner_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_persona_group_members_group ON persona_group_members(group_id);
CREATE INDEX IF NOT EXISTS idx_persona_group_members_persona ON persona_group_members(persona_id);

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

CREATE INDEX IF NOT EXISTS idx_analysis_artifacts_session ON analysis_artifacts(session_id);
CREATE INDEX IF NOT EXISTS idx_analysis_artifacts_session_persona ON analysis_artifacts(session_id, persona_id);
CREATE INDEX IF NOT EXISTS idx_analysis_artifacts_type ON analysis_artifacts(artifact_type);

