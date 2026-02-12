# Roundtable + CLIBridge Integration - Implementation Roadmap

## Project Overview

This project integrates Roundtable (persona-based marketing analysis) with CLIBridge (AI backend service) via Cloudflare infrastructure.

**Key Achievement**: Eliminates the need for a custom FastAPI backend by leveraging CLIBridge's skill system for persona management and Cloudflare for infrastructure.

## Architecture Summary

```
┌─────────────────────────────────────────────────────────────┐
│ Cloudflare (Frontend + API + Storage)                      │
├─────────────────────────────────────────────────────────────┤
│ Pages (roundtable.browsium.com)                           │
│ Workers (roundtable-api.browsium.workers.dev)              │
│ D1 (Database) + R2 (Document Storage)                      │
│ Durable Objects (WebSocket streaming)                     │
└────────────────────┬────────────────────────────────────────┘
                     │ CF Access (automatic auth)
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ CLIBridge (OracleVM)                                        │
│ clibridge.badrobots.net                                     │
├─────────────────────────────────────────────────────────────┤
│ Skills: roundtable-{persona}-v{version}                     │
│ Each persona = one skill with manifest + template          │
│ Auto-upload via API, auto-reload after upload              │
└────────────────────┬────────────────────────────────────────┘
                     ▼
              Claude CLI (subprocess)
```

## Documentation Created

1. **roundtable_architecture.md** - Complete system architecture
2. **clibridge_requirements.md** - Changes needed to CLIBridge
3. **sample_skill_ciso.md** - Example of persona-to-skill conversion

## Phase 1: CLIBridge Extensions

**Goal**: Add skill upload endpoint to CLIBridge

### Changes Required

**New Endpoint**: `POST /admin/skills/upload`
- **Purpose**: Upload new persona skills via API
- **Auth**: CF Access (automatic for Workers)
- **Format**: Multipart form data
- **Auto-reload**: Yes (immediate availability)

**New Endpoint**: `POST /admin/skills/cleanup`
- **Purpose**: Delete old skills (60+ days)
- **Auth**: CF Access

### Security Requirements

- **Skill name validation**: `^roundtable-[a-z0-9-]+-v\d+\.\d+\.\d+$`
- **Path traversal prevention**: Reject `..` and `/` in names
- **File size limits**: 10KB manifest, 100KB template
- **Content validation**: Valid YAML, valid Go template, no dangerous functions

### Files to Modify

1. `internal/handler/admin.go` - Add routes
2. `internal/handler/skills_upload.go` - New file (skill upload handler)
3. `internal/config/config.go` - Add security config

### Testing Commands

```bash
# Upload a skill
curl -X POST https://clibridge.badrobots.net/admin/skills/upload \
  -H "CF-Access-Authenticated-User-Email: user@example.com" \
  -F "skill_name=roundtable-ciso-v1.0.0" \
  -F "manifest=@manifest.yaml" \
  -F "template=@analyze.tmpl" \
  -F "template_name=analyze.tmpl"

# Cleanup old skills
curl -X POST https://clibridge.badrobots.net/admin/skills/cleanup \
  -H "CF-Access-Authenticated-User-Email: user@example.com" \
  -H "Content-Type: application/json" \
  -d '{"skill_prefix":"roundtable-","older_than_days":60}'

# Test the skill
curl -X POST https://clibridge.badrobots.net/roundtable/analyze/ciso \
  -H "Content-Type: application/json" \
  -d '{"document_text":"Marketing content to analyze..."}'
```

## Phase 2: Cloudflare Infrastructure

**Goal**: Set up D1, R2, and Workers

### D1 Database Schema

```sql
-- personas table (source of truth)
CREATE TABLE personas (
  id TEXT PRIMARY KEY,              -- ciso_enterprise
  name TEXT NOT NULL,               -- Victoria Chen
  role TEXT NOT NULL,               -- Chief Information Security Officer
  profile_json TEXT NOT NULL,       -- Full persona JSON
  version TEXT NOT NULL,            -- 1.0.0
  skill_name TEXT NOT NULL,         -- roundtable-ciso_enterprise-v1.0.0
  skill_path TEXT NOT NULL,         -- roundtable/roundtable-ciso...
  is_system BOOLEAN DEFAULT 1,      -- True for built-in personas
  status TEXT DEFAULT 'draft',      -- draft | deployed | failed
  created_at TEXT,
  updated_at TEXT,
  deployed_at TEXT
);

-- sessions table
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_r2_key TEXT NOT NULL,
  file_size_bytes INTEGER,
  file_extension TEXT,
  selected_persona_ids TEXT,      -- JSON array
  status TEXT,                      -- uploaded | analyzing | completed | failed
  created_at TEXT,
  updated_at TEXT
);

-- analyses table
CREATE TABLE analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  persona_id TEXT NOT NULL,
  status TEXT,                      -- pending | running | completed | failed
  score_json TEXT,
  top_issues_json TEXT,
  rewritten_suggestions_json TEXT,
  error_message TEXT,
  started_at TEXT,
  completed_at TEXT
);
```

### R2 Configuration

- **Bucket name**: `roundtable-documents`
- **Privacy**: Private (no public access)
- **CORS**: Enabled for presigned URLs
- **Lifecycle**: Auto-delete after 30 days

### Workers Structure

```
roundtable-workers/
├── src/
│   ├── index.ts                    # Worker entry
│   ├── routes/
│   │   ├── sessions.ts            # Session CRUD + WebSocket
│   │   ├── personas.ts            # Persona CRUD + skill generation
│   │   └── r2.ts                  # Presigned URL generation
│   ├── durable-objects/
│   │   └── session-analyzer.ts    # WebSocket + streaming
│   └── lib/
│       ├── clibridge.ts           # CLIBridge API client
│       ├── d1.ts                 # Database helpers
│       ├── r2.ts                 # R2 helpers
│       ├── document-processor.ts # PDF/DOCX/PPTX extraction
│       └── skill-generator.ts    # Generate skill files
├── tests/
├── wrangler.toml
└── package.json
```

## Phase 3: Persona Migration

**Goal**: Convert existing 9 personas to CLIBridge skills

### Persona List

1. CISO (`ciso_enterprise`) - Victoria Chen
2. CIO (`cio_enterprise`) - Jennifer Martinez
3. CTO (`cto_enterprise`) - Raj Patel
4. Compliance Officer (`compliance_officer`) - Amanda Thompson
5. IT Administrator (`it_administrator`) - Marcus Rodriguez
6. IT Auditor (`it_auditor`) - Michael Brooks
7. IT Security Administrator (`it_security_administrator`) - Sarah Kim
8. IT Security Director (`it_security_director`) - David Park
9. Security Consulting Leader (`security_consulting_leader`) - Elena Vasquez

### Conversion Process

1. **Read JSON** from `/Users/matteller/Projects/Roundtable/backend/personas/{id}.json`
2. **Generate skill files**:
   - `manifest.yaml` - Endpoint configuration
   - `analyze.tmpl` - Prompt template with embedded persona
3. **Upload to CLIBridge** via `/admin/skills/upload`
4. **Insert into D1** with skill mappings

### Skill Structure

Each skill creates two files:

```yaml
# manifest.yaml
name: roundtable-ciso_enterprise-v1.0.0
version: "1.0.0"
description: "Victoria Chen - Chief Information Security Officer evaluation"
provider: claude
model: sonnet
endpoints:
  - path: /roundtable/analyze/ciso_enterprise
    method: POST
    template: analyze.tmpl
    response_format: json
    timeout_seconds: 180
```

```gotemplate
# analyze.tmpl
{{- $persona := `
[Full persona profile here]
` -}}

{{- $document := .document_text -}}

{{- $prompt := printf `
%s

Evaluate this marketing content:
%s

[Response format JSON]
` $persona $document -}}

{{- $prompt -}}
```

## Phase 4: Frontend Migration

**Goal**: Replace FastAPI backend with Workers API

### API Changes

**Old (FastAPI)**:
- `POST /api/sessions/` - Create session with file upload
- `POST /api/sessions/{id}/analyze` - Start analysis (polling)
- `GET /api/sessions/{id}` - Get results

**New (Workers + WebSocket)**:
- `POST /sessions` - Create session with R2 presigned upload
- `WebSocket /sessions/{id}/analyze` - Real-time streaming analysis
- `GET /sessions/{id}` - Get results from D1

### WebSocket Protocol

**Messages from Server to Client**:

```json
// Chunk received
{
  "type": "chunk",
  "persona_id": "ciso_enterprise",
  "text": "Analyzing from a CISO perspective..."
}

// Analysis complete
{
  "type": "complete",
  "persona_id": "ciso_enterprise",
  "result": {
    "persona_role": "Chief Information Security Officer",
    "overall_score": 7,
    "dimension_scores": {...},
    "top_3_issues": [...],
    "what_works_well": [...],
    "overall_verdict": "...",
    "rewritten_headline_suggestion": "..."
  }
}

// All personas complete
{
  "type": "all_complete",
  "session_id": "..."
}

// Error
{
  "type": "error",
  "persona_id": "ciso_enterprise",
  "error": "Analysis failed: timeout"
}
```

**Reconnection Strategy**:
- 3 attempts with exponential backoff: 2s, 4s, 8s
- Native WebSocket with custom reconnection logic

### Document Processing

**Libraries**:
- PDF: `pdf-parse`
- DOCX: `mammoth`
- PPTX: `pptx-parser`

**Process**:
1. Frontend uploads to R2 presigned URL
2. Workers fetches from R2
3. Workers extracts text
4. Store extracted text in D1
5. Analysis reads text from D1

## Implementation Sequence

### Phase 1: CLIBridge (Days 1-2)
- [ ] Add skill upload endpoint
- [ ] Add cleanup endpoint
- [ ] Add security config
- [ ] Write tests
- [ ] Deploy to OracleVM
- [ ] Verify upload works

### Phase 2: Cloudflare Infrastructure (Day 3)
- [ ] Create D1 database
- [ ] Create R2 bucket
- [ ] Create Workers project
- [ ] Set up wrangler
- [ ] Deploy skeleton

### Phase 3: Workers Backend (Days 4-6)
- [ ] D1 schema migration
- [ ] Session CRUD endpoints
- [ ] Persona CRUD endpoints
- [ ] R2 presigned URL generation
- [ ] Document processing (PDF/DOCX/PPTX)
- [ ] Skill generator
- [ ] CLIBridge client
- [ ] Durable Object WebSocket handler
- [ ] Tests

### Phase 4: Persona Migration (Day 7)
- [ ] Convert 9 personas to skills
- [ ] Upload to CLIBridge
- [ ] Insert into D1
- [ ] Test all skills

### Phase 5: Frontend (Days 8-10)
- [ ] Replace API client
- [ ] Add WebSocket connection
- [ ] Update file upload (R2)
- [ ] Add streaming display
- [ ] Update persona management
- [ ] Tests

### Phase 6: Integration & Testing (Days 11-12)
- [ ] End-to-end test
- [ ] Concurrent analysis test
- [ ] Error handling test
- [ ] Security audit
- [ ] Performance test
- [ ] Deploy to production

## Key Design Decisions

### 1. D1 as Authoritative Source
- **Rationale**: D1 stores persona JSON (easier queries, backups, versioning)
- **Skills**: Compiled/deployed versions for execution only
- **Flow**: D1 → Skill files → CLIBridge

### 2. Concurrent Analysis
- **Approach**: All personas analyzed simultaneously
- **Benefit**: Faster overall completion
- **Resource**: 9 concurrent Claude processes on OracleVM

### 3. WebSocket vs SSE
- **Choice**: WebSocket via Durable Objects
- **Rationale**: Better reconnection control, multiple concurrent analyses
- **Reconnection**: Native + custom (3 attempts, exponential backoff)

### 4. Skill Versioning
- **Pattern**: `roundtable-{id}-v{major}.{minor}.{patch}`
- **Auto-cleanup**: Delete after 60 days
- **Rollback**: Change active_version in D1

### 5. Document Processing in Workers
- **Libraries**: JavaScript (pdf-parse, mammoth, pptx-parser)
- **Rationale**: Single runtime, no Python service
- **Alternative**: Could use Python if needed, but JS is sufficient

## Testing Strategy

### Unit Tests
- Document processing (PDF/DOCX/PPTX)
- Skill generation
- D1 operations
- CLIBridge API client

### Integration Tests
- End-to-end analysis flow
- WebSocket reconnection
- Skill upload → execution
- Error scenarios

### Manual Tests
```bash
# CLIBridge
./test-clibridge.sh

# Workers
./test-workers.sh

# Frontend
./test-e2e.sh
```

## Security Checklist

- [ ] CF Access on all Cloudflare endpoints
- [ ] R2 objects private (presigned URLs only)
- [ ] Skill name validation (path traversal prevention)
- [ ] File size limits (10KB manifest, 100KB template)
- [ ] Template validation (no dangerous functions)
- [ ] Rate limiting (10 uploads/min, 100 analyses/hour)
- [ ] Auto-cleanup (documents 30 days, skills 60 days)

## Monitoring

### Metrics
- Analysis completion rate
- Average analysis duration per persona
- WebSocket connection success/failure
- Document upload success rate
- Skill deployment success rate

### Logs
- Structured logging in Workers
- Request correlation IDs
- Error tracking

## Rollback Plan

If deployment fails:
1. Revert Workers deployment
2. CLIBridge skills remain (no data loss)
3. Frontend can fall back to showing error
4. Debug and retry

## Documentation

- [ ] API documentation (auto-generated)
- [ ] Architecture diagram
- [ ] Deployment guide
- [ ] Troubleshooting guide

## Success Criteria

- [ ] All 9 personas respond correctly
- [ ] Analysis streams in real-time via WebSocket
- [ ] New personas can be added via web UI
- [ ] Skills deploy automatically
- [ ] No data loss
- [ ] Security audit passed

## Questions for Next Steps

1. **Should I proceed with Phase 1 (CLIBridge extensions)?**
2. **Any changes needed to the skill upload endpoint design?**
3. **Should the skill cleanup be automatic (cron) or manual?**
4. **Do you want a test endpoint for skill upload (without CF Access)?**

---

**Status**: Ready for implementation  
**Last Updated**: 2025-02-11
