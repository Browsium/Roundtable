export interface Persona {
  id: string;
  name: string;
  role: string;
  profile_json: string;
  version: string;
  skill_name: string;
  skill_path: string;
  is_system: boolean;
  status: 'draft' | 'deployed' | 'failed';
  created_at: string;
  updated_at: string;
  deployed_at?: string;
}

export interface Session {
  id: string;
  user_email: string;
  file_name: string;
  file_r2_key: string;
  file_size_bytes: number;
  file_extension: string;
  selected_persona_ids: string;
  status: 'uploaded' | 'analyzing' | 'completed' | 'failed' | 'partial';
  analysis_provider?: string;
  analysis_model?: string;
  error_message?: string;
  created_at: string;
  updated_at: string;
}

export interface Analysis {
  id: number;
  session_id: string;
  persona_id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  analysis_provider?: string;
  analysis_model?: string;
  score_json?: string;
  top_issues_json?: string;
  rewritten_suggestions_json?: string;
  error_message?: string;
  started_at?: string;
  completed_at?: string;
}

export interface ShareToken {
  id: number;
  token: string;
  session_id: string;
  created_by: string;
  expires_at: string;
  view_count: number;
  created_at: string;
}

export interface SessionShare {
  session_id: string;
  email: string;
  created_at: string;
}

export interface Setting {
  key: string;
  value: string;
  updated_at: string;
}

export interface SessionWithAnalyses extends Session {
  analyses?: Analysis[];
}

export class D1Client {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  private async columnExists(table: string, column: string): Promise<boolean> {
    const result = await this.db.prepare(`PRAGMA table_info('${table}')`).all<{ name: string }>();
    return (result.results || []).some(r => r.name === column);
  }

  private async ensureAnalysisBackendColumns(): Promise<void> {
    const ensureColumn = async (table: 'sessions' | 'analyses', column: 'analysis_provider' | 'analysis_model') => {
      const exists = await this.columnExists(table, column);
      if (exists) return;
      try {
        await this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`).run();
      } catch (e) {
        const msg = String(e);
        // Another request may have added the column concurrently.
        if (msg.toLowerCase().includes('duplicate column')) return;
        throw e;
      }
    };

    await ensureColumn('sessions', 'analysis_provider');
    await ensureColumn('sessions', 'analysis_model');
    await ensureColumn('analyses', 'analysis_provider');
    await ensureColumn('analyses', 'analysis_model');
  }

  private async ensureSessionSharesSchema(): Promise<void> {
    // Idempotent; safe to call from request paths.
    await this.db.prepare(
      `CREATE TABLE IF NOT EXISTS session_shares (
        session_id TEXT NOT NULL,
        email TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, email),
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )`
    ).run();

    await this.db.prepare('CREATE INDEX IF NOT EXISTS idx_session_shares_email ON session_shares(email)').run();
    await this.db.prepare('CREATE INDEX IF NOT EXISTS idx_session_shares_session ON session_shares(session_id)').run();
  }

  private async ensureSettingsSchema(): Promise<void> {
    await this.db.prepare(
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`
    ).run();
  }

  // Persona operations
  async getPersonas(): Promise<Persona[]> {
    const result = await this.db.prepare('SELECT * FROM personas ORDER BY name').all<Persona>();
    return result.results || [];
  }

  async getPersona(id: string): Promise<Persona | null> {
    const result = await this.db.prepare('SELECT * FROM personas WHERE id = ?').bind(id).first<Persona>();
    return result || null;
  }

  async createPersona(persona: Omit<Persona, 'created_at' | 'updated_at'>): Promise<void> {
    const now = new Date().toISOString();
    await this.db.prepare(
      `INSERT INTO personas (id, name, role, profile_json, version, skill_name, skill_path, is_system, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      persona.id,
      persona.name,
      persona.role,
      persona.profile_json,
      persona.version,
      persona.skill_name,
      persona.skill_path,
      persona.is_system ? 1 : 0,
      persona.status,
      now,
      now
    ).run();
  }

  async updatePersona(id: string, updates: Partial<Persona>): Promise<void> {
    const now = new Date().toISOString();
    const fields = Object.keys(updates).filter(k => k !== 'id');
    if (fields.length === 0) return;
    
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => (updates as any)[f]);
    values.push(now, id);
    
    await this.db.prepare(`UPDATE personas SET ${setClause}, updated_at = ? WHERE id = ?`).bind(...values).run();
  }

  async deletePersona(id: string): Promise<void> {
    await this.db.prepare('DELETE FROM personas WHERE id = ?').bind(id).run();
  }

  // Session operations
  async getSessions(userEmail: string, includeShared: boolean = true): Promise<Session[]> {
    if (includeShared) {
      await this.ensureSessionSharesSchema();
      const result = await this.db.prepare(
        `SELECT DISTINCT s.*
         FROM sessions s
         LEFT JOIN session_shares sh ON sh.session_id = s.id
         WHERE s.user_email = ? OR sh.email = ?
         ORDER BY s.created_at DESC`
      ).bind(userEmail, userEmail).all<Session>();
      return result.results || [];
    }

    const result = await this.db.prepare(
      'SELECT * FROM sessions WHERE user_email = ? ORDER BY created_at DESC'
    ).bind(userEmail).all<Session>();
    return result.results || [];
  }

  async getSession(id: string): Promise<Session | null> {
    const result = await this.db.prepare('SELECT * FROM sessions WHERE id = ?').bind(id).first<Session>();
    return result || null;
  }

  async isSessionSharedWith(sessionId: string, email: string): Promise<boolean> {
    await this.ensureSessionSharesSchema();
    const row = await this.db.prepare(
      'SELECT 1 as ok FROM session_shares WHERE session_id = ? AND email = ? LIMIT 1'
    ).bind(sessionId, email).first<{ ok: number }>();
    return !!row;
  }

  async getSessionShareEmails(sessionId: string): Promise<string[]> {
    await this.ensureSessionSharesSchema();
    const result = await this.db.prepare(
      'SELECT email FROM session_shares WHERE session_id = ? ORDER BY email'
    ).bind(sessionId).all<{ email: string }>();
    return (result.results || []).map(r => r.email);
  }

  async addSessionShares(sessionId: string, emails: string[]): Promise<void> {
    await this.ensureSessionSharesSchema();
    const now = new Date().toISOString();
    for (const email of emails) {
      if (!email) continue;
      await this.db.prepare(
        'INSERT OR IGNORE INTO session_shares (session_id, email, created_at) VALUES (?, ?, ?)'
      ).bind(sessionId, email, now).run();
    }
  }

  async deleteSessionShares(sessionId: string): Promise<void> {
    await this.ensureSessionSharesSchema();
    await this.db.prepare('DELETE FROM session_shares WHERE session_id = ?').bind(sessionId).run();
  }

  async createSession(session: Omit<Session, 'created_at' | 'updated_at'>): Promise<void> {
    const now = new Date().toISOString();
    await this.db.prepare(
      `INSERT INTO sessions (id, user_email, file_name, file_r2_key, file_size_bytes, file_extension, selected_persona_ids, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      session.id,
      session.user_email,
      session.file_name,
      session.file_r2_key,
      session.file_size_bytes,
      session.file_extension,
      session.selected_persona_ids,
      session.status,
      now,
      now
    ).run();
  }

  async updateSession(id: string, updates: Partial<Session>): Promise<void> {
    const now = new Date().toISOString();
    const fields = Object.keys(updates).filter(k => k !== 'id');
    if (fields.length === 0) return;

    if (Object.prototype.hasOwnProperty.call(updates, 'analysis_provider') || Object.prototype.hasOwnProperty.call(updates, 'analysis_model')) {
      await this.ensureAnalysisBackendColumns();
    }
    
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => (updates as any)[f]);
    values.push(now, id);
    
    await this.db.prepare(`UPDATE sessions SET ${setClause}, updated_at = ? WHERE id = ?`).bind(...values).run();
  }

  async deleteSession(id: string): Promise<void> {
    // Ensure any shares are removed even if FK enforcement is off.
    await this.deleteSessionShares(id);
    await this.db.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    await this.db.prepare('DELETE FROM analyses WHERE session_id = ?').bind(id).run();
  }

  // Analysis operations
  async getAnalyses(sessionId: string): Promise<Analysis[]> {
    const result = await this.db.prepare('SELECT * FROM analyses WHERE session_id = ?').bind(sessionId).all<Analysis>();
    return result.results || [];
  }

  async createAnalysis(analysis: Omit<Analysis, 'id'>): Promise<number> {
    const result = await this.db.prepare(
      `INSERT INTO analyses (session_id, persona_id, status, score_json, top_issues_json, rewritten_suggestions_json, error_message, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      analysis.session_id,
      analysis.persona_id,
      analysis.status,
      analysis.score_json || null,
      analysis.top_issues_json || null,
      analysis.rewritten_suggestions_json || null,
      analysis.error_message || null,
      analysis.started_at || null,
      analysis.completed_at || null
    ).run();
    return result.meta?.last_row_id || 0;
  }

  async updateAnalysis(id: number, updates: Partial<Analysis>): Promise<void> {
    const fields = Object.keys(updates).filter(k => k !== 'id');
    if (fields.length === 0) return;

    if (Object.prototype.hasOwnProperty.call(updates, 'analysis_provider') || Object.prototype.hasOwnProperty.call(updates, 'analysis_model')) {
      await this.ensureAnalysisBackendColumns();
    }
    
    const setClause = fields.map(f => `${f} = ?`).join(', ');
    const values = fields.map(f => (updates as any)[f]);
    values.push(id);
    
    await this.db.prepare(`UPDATE analyses SET ${setClause} WHERE id = ?`).bind(...values).run();
  }

  // Settings operations
  async getSettings(): Promise<Setting[]> {
    await this.ensureSettingsSchema();
    const result = await this.db.prepare('SELECT * FROM settings ORDER BY key').all<Setting>();
    return result.results || [];
  }

  async getSetting(key: string): Promise<Setting | null> {
    await this.ensureSettingsSchema();
    const result = await this.db.prepare('SELECT * FROM settings WHERE key = ?').bind(key).first<Setting>();
    return result || null;
  }

  async getSettingValue(key: string): Promise<string | null> {
    const s = await this.getSetting(key);
    return s?.value ?? null;
  }

  async upsertSetting(key: string, value: string): Promise<void> {
    await this.ensureSettingsSchema();
    const now = new Date().toISOString();
    await this.db.prepare(
      `INSERT INTO settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).bind(key, value, now).run();
  }

  async upsertSettings(settings: Record<string, string>): Promise<void> {
    const entries = Object.entries(settings);
    for (const [key, value] of entries) {
      await this.upsertSetting(key, value);
    }
  }
}
