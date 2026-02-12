# Roundtable + CLIBridge Integration - Project Handoff

**Date**: 2025-02-11  
**Status**: Documentation Complete, Ready for Implementation  
**Branch**: main  
**Last Commit**: `d2cfcde` - docs: Add comprehensive architecture and implementation documentation

---

## Executive Summary

This project redesigns Roundtable to use CLIBridge as the AI backend service via Cloudflare infrastructure. The existing FastAPI backend will be eliminated in favor of:

- **Cloudflare Workers** (API + WebSocket streaming)
- **Cloudflare D1** (database for personas, sessions, analyses)
- **Cloudflare R2** (document storage)
- **CLIBridge** (AI execution via Claude CLI with persona skills)

**Key Achievement**: Personas become CLIBridge "skills" - auto-generated, versioned, and deployed via API.

---

## What Has Been Completed

### ✅ Documentation (Phase 0)

Five comprehensive documentation files created in `docs/`:

1. **ARCHITECTURE.md** (398 lines)
   - Complete system architecture diagrams
   - Component interactions (Pages, Workers, D1, R2, CLIBridge)
   - Data flows (upload, analysis, persona creation)
   - Security considerations
   - Technology stack decisions

2. **CLOUDFLARE_SETUP.md** (275 lines)
   - Step-by-step Cloudflare configuration
   - Commands for: wrangler login, d1 create, r2 bucket create
   - GitHub secrets configuration
   - wrangler.toml template
   - Database schema
   - GitHub Actions workflows

3. **CLIBRIDGE_INTEGRATION.md** (455 lines)
   - Skill upload endpoint requirements (being built by separate team)
   - Authentication details (CF Access + API keys)
   - Validation rules and security requirements
   - Testing commands

4. **SAMPLE_SKILL.md** (359 lines)
   - Example persona-to-skill conversion (CISO)
   - Generated manifest.yaml and analyze.tmpl
   - Skill generation TypeScript code
   - All 9 personas to convert

5. **IMPLEMENTATION_PLAN.md** (475 lines)
   - 12-day implementation roadmap
   - Phase-by-phase breakdown
   - Success criteria and testing strategy

### ✅ Key Decisions Made

| Decision | Choice | Rationale |
|----------|--------|-----------|
| **WebSocket** | Native + custom reconnection | No dependencies, full control |
| **Document Processing** | JavaScript libraries in Workers | Single runtime, no Python service |
| **Analysis** | Concurrent (all personas simultaneously) | Faster completion, CLIBridge handles concurrency |
| **Partial Results** | Memory only | Final results saved to D1 |
| **Auth** | CF Access email magic link | Automatic, secure, no passwords |
| **Skill Versioning** | Semantic versioning | Auto-cleanup after 60 days |
| **Authoritative Source** | D1 | Skills are compiled/deployed versions |

---

## Current State

### Existing Assets

**Roundtable Repo**: `/Users/matteller/Projects/Roundtable/`
- Frontend: Next.js 14 with TypeScript (in `frontend/`)
- Personas: 9 JSON files in `backend/personas/`
- Documentation: 5 files in `docs/`

**CLIBridge**: `https://clibridge.badrobots.net`
- Location: OracleVM
- Being extended by separate team to add skill upload endpoint
- Will provide: `POST /admin/skills/upload` and `POST /admin/skills/cleanup`

### Access Credentials (For Implementation)

**CLIBridge Bypass** (for Workers to call CLIBridge):
- Base URL: `https://bypass.badrobots.net/clibridge`
- Client ID: `72895a2b904f0cf918b46bcbaad7778f.access`
- Client Secret: `4ba474883c884225479cf644be7942d6ce5fc747834fe5c3c2ae70a34df39a2d`
- API Key: `pmk_0a1e0e1016ab47238cc343a40dcab913`

**Cloudflare** (to be configured):
- Account ID: [User to provide]
- D1 Database ID: [User to provide after setup]
- R2 Bucket: `roundtable-documents`
- Workers Project: `roundtable-api`

---

## What Needs to Be Done

### Phase 1: Cloudflare Setup (User Action Required)

**Before implementation can begin, the user must:**

1. Run Cloudflare setup commands (see CLOUDFLARE_SETUP.md)
   ```bash
   npx wrangler login
   npx wrangler d1 create roundtable-db
   npx wrangler r2 bucket create roundtable-documents
   mkdir api && cd api && npx wrangler init
   ```

2. Create GitHub Secrets (5 total):
   - `CF_ACCOUNT_ID`
   - `CF_API_TOKEN`
   - `CLIBRIDGE_CLIENT_ID`
   - `CLIBRIDGE_CLIENT_SECRET`
   - `CLIBRIDGE_API_KEY`

3. Configure wrangler.toml with Database ID

4. Run D1 schema migration

**Status**: ⏳ Waiting for user

### Phase 2: Workers Backend Implementation

**Directory**: `/Users/matteller/Projects/Roundtable/api/`

**Files to Create**:

```
api/
├── src/
│   ├── index.ts                    # Worker entry point
│   ├── routes/
│   │   ├── sessions.ts            # Session CRUD + WebSocket upgrade
│   │   ├── personas.ts            # Persona CRUD + skill deployment
│   │   └── r2.ts                  # Presigned URL generation
│   ├── durable-objects/
│   │   └── session-analyzer.ts    # WebSocket + CLIBridge streaming
│   └── lib/
│       ├── clibridge.ts           # CLIBridge API client
│       ├── d1.ts                  # Database helpers
│       ├── r2.ts                  # R2 helpers
│       ├── document-processor.ts  # PDF/DOCX/PPTX text extraction
│       └── skill-generator.ts     # Generate skill files from persona
├── wrangler.toml
├── package.json
└── tsconfig.json
```

**Key Implementation Details**:

1. **CLIBridge Client** (`lib/clibridge.ts`):
   ```typescript
   const CLIBRIDGE_URL = 'https://bypass.badrobots.net/clibridge';
   const headers = {
     'CF-Access-Client-Id': '72895a2b904f0cf918b46bcbaad7778f.access',
     'CF-Access-Client-Secret': '4ba474883c884225479cf644be7942d6ce5fc747834fe5c3c2ae70a34df39a2d',
     'X-API-Key': 'pmk_0a1e0e1016ab47238cc343a40dcab913',
   };
   ```

2. **Durable Object** (`durable-objects/session-analyzer.ts`):
   - Handle WebSocket connections from frontend
   - Call CLIBridge `/v1/stream` for each persona concurrently
   - Forward SSE chunks to WebSocket
   - Save final results to D1

3. **Document Processing** (`lib/document-processor.ts`):
   - Libraries: `pdf-parse`, `mammoth`, `pptx-parser`
   - Extract text from uploaded documents
   - Store extracted text in D1

4. **Skill Generator** (`lib/skill-generator.ts`):
   - Read persona JSON from D1
   - Generate manifest.yaml
   - Generate analyze.tmpl with embedded persona data
   - Upload to CLIBridge via `/admin/skills/upload`

**Status**: ⏳ Blocked until Phase 1 complete

### Phase 3: Persona Migration

**Script**: Convert existing 9 personas to CLIBridge skills

**Process**:
1. Read `/Users/matteller/Projects/Roundtable/backend/personas/*.json`
2. Generate skill files (manifest.yaml + analyze.tmpl)
3. Upload to CLIBridge via API
4. Insert into D1 with mappings

**Status**: ⏳ Blocked until Phase 2 complete

### Phase 4: Frontend Migration

**Directory**: `/Users/matteller/Projects/Roundtable/frontend/`

**Changes**:
1. Replace API client (`src/lib/api.ts`)
   - Remove FastAPI calls
   - Add Workers API calls
   - Add WebSocket client

2. Update pages:
   - `/` (upload page): Use R2 presigned URLs
   - `/sessions/[id]` (results): WebSocket streaming display
   - `/personas` (management): CRUD + deploy to CLIBridge

**Status**: ⏳ Blocked until Phase 3 complete

### Phase 5: GitHub Actions

**Files to Create**:
- `.github/workflows/deploy.yml` - Deploy Workers on push
- `.github/workflows/cleanup-skills.yml` - Daily cron to cleanup old skills

**Status**: ⏳ Blocked until Phase 1 complete

---

## Critical Information

### Architecture Overview

```
Frontend (roundtable.browsium.com)
    ↓
Cloudflare Workers (roundtable-api.browsium.workers.dev)
    ↓ WebSocket (Durable Objects)
CLIBridge (bypass.badrobots.net/clibridge)
    ↓
Claude CLI
```

### CLIBridge Integration

**Base URL**: `https://bypass.badrobots.net/clibridge`

**Required Headers for ALL requests**:
```
CF-Access-Client-Id: 72895a2b904f0cf918b46bcbaad7778f.access
CF-Access-Client-Secret: 4ba474883c884225479cf644be7942d6ce5fc747834fe5c3c2ae70a34df39a2d
X-API-Key: pmk_0a1e0e1016ab47238cc343a40dcab913
```

**Endpoints to Use**:
- `POST /v1/stream` - Stream analysis (returns SSE)
- `POST /admin/skills/upload` - Upload new persona skill (multipart form)
- `POST /admin/skills/cleanup` - Delete old skills
- `GET /admin/skills` - List loaded skills

### Persona to Skill Mapping

Each persona JSON becomes a CLIBridge skill:

**Naming Pattern**: `roundtable-{persona_id}-v{version}`

Examples:
- `ciso.json` → `roundtable-ciso_enterprise-v1.0.0`
- `cto.json` → `roundtable-cto_enterprise-v1.0.0`
- etc.

**Skill Files**:
1. `manifest.yaml` - Endpoint configuration
2. `analyze.tmpl` - Go template with embedded persona JSON

**Storage**:
- CLIBridge: `skills/roundtable/{skill_name}/`
- D1: `personas` table with `skill_name` and `skill_path` columns

---

## Dependencies and Blockers

### External Dependencies

1. **CLIBridge Skill Upload Endpoint** (Critical)
   - Being built by separate team
   - Must be ready before Phase 3
   - Status: ⏳ Unknown (ask user)

2. **Cloudflare Infrastructure** (Critical)
   - D1, R2, Workers must be created by user
   - Status: ⏳ Waiting for user action

### Internal Dependencies

Phase 2 → Phase 3 → Phase 4 (sequential)

---

## Testing Strategy

### Unit Tests
- Document processing (PDF/DOCX/PPTX)
- Skill generation
- D1 operations
- CLIBridge API client

### Integration Tests
- End-to-end analysis flow
- WebSocket reconnection (3 attempts: 2s, 4s, 8s)
- Skill upload → execution
- Error scenarios

### Manual Tests

```bash
# Test CLIBridge skill upload
curl -X POST https://bypass.badrobots.net/clibridge/admin/skills/upload \
  -H "CF-Access-Client-Id: 72895a2b904f0cf918b46bcbaad7778f.access" \
  -H "CF-Access-Client-Secret: 4ba474883c884225479cf644be7942d6ce5fc747834fe5c3c2ae70a34df39a2d" \
  -H "X-API-Key: pmk_0a1e0e1016ab47238cc343a40dcab913" \
  -F "skill_name=roundtable-test-v1.0.0" \
  -F "manifest=@test-manifest.yaml" \
  -F "template=@test-template.tmpl"

# Test streaming analysis
curl -X POST https://bypass.badrobots.net/clibridge/v1/stream \
  -H "CF-Access-Client-Id: ..." \
  -H "CF-Access-Client-Secret: ..." \
  -H "X-API-Key: ..." \
  -H "Content-Type: application/json" \
  -d '{
    "provider": "claude",
    "model": "sonnet",
    "system_prompt": "You are a CISO...",
    "messages": [{"role": "user", "content": "Test content"}]
  }'
```

---

## Success Criteria

- [ ] All 9 personas converted to CLIBridge skills
- [ ] Analysis streams in real-time via WebSocket
- [ ] New personas can be added via web UI and auto-deploy
- [ ] Document upload works with R2 presigned URLs
- [ ] No data loss from existing personas
- [ ] Security audit passed (CF Access on all endpoints)
- [ ] GitHub Actions auto-deploy on push
- [ ] Daily cron cleans up skills older than 60 days

---

## Known Issues / Risks

1. **CLIBridge Endpoint Not Ready**
   - Risk: Phase 3 blocked
   - Mitigation: Can mock/test with existing CLIBridge endpoints first

2. **Document Processing in Workers**
   - Risk: Libraries may have limitations with complex documents
   - Mitigation: Test with various PDF/DOCX/PPTX formats

3. **Concurrent Claude Processes**
   - Risk: 9 concurrent analyses may strain OracleVM
   - Mitigation: Monitor resource usage, may need sequential fallback

4. **WebSocket Reconnection**
   - Risk: Network interruptions during long analyses
   - Mitigation: 3 reconnection attempts with exponential backoff

---

## Resources

### Documentation
- `docs/ARCHITECTURE.md` - System architecture
- `docs/CLOUDFLARE_SETUP.md` - Cloudflare configuration
- `docs/CLIBRIDGE_INTEGRATION.md` - CLIBridge requirements
- `docs/SAMPLE_SKILL.md` - Persona-to-skill example
- `docs/IMPLEMENTATION_PLAN.md` - Detailed roadmap

### Code
- Frontend: `/Users/matteller/Projects/Roundtable/frontend/`
- Personas: `/Users/matteller/Projects/Roundtable/backend/personas/`
- API (to create): `/Users/matteller/Projects/Roundtable/api/`

### External Services
- CLIBridge: `https://clibridge.badrobots.net`
- CLIBridge Bypass: `https://bypass.badrobots.net/clibridge`

---

## Next Immediate Action

**User must complete Phase 1 (Cloudflare Setup) before implementation can begin.**

See `docs/CLOUDFLARE_SETUP.md` for complete instructions.

Estimated time: 30 minutes

---

## Contact / Context

**Project**: Roundtable + CLIBridge Integration  
**Previous Agent**: opencode (Claude Code)  
**Date Handed Off**: 2025-02-11  
**Status**: Documentation complete, ready for implementation

**Key Context**:
- This is a redesign, not a migration (no production system to break)
- CLIBridge extensions being built by separate team
- User will handle Cloudflare setup
- Implementation phases are sequential

---

**END OF HANDOFF DOCUMENT**
