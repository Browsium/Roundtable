# Roundtable Handoff (Current)

**Date**: 2026-02-14  
**Repo**: `C:\Users\Matt\Documents\Projects\Roundtable`  
**App Version**: `1.2.0` (frontend + api + `roundtable-mcp`)  
**Status**: Web app is live; analysis, sharing, and export are implemented; local STDIO MCP workflow exists. Remaining work is mostly auth hardening and integrations.

## What Roundtable Does

Roundtable takes a marketing document and runs it through a panel of personas (CISO, CIO, etc.). Each persona returns structured feedback (scores + issues + rewrites). Results are streamed live to the UI and stored for later viewing/export.

## As-Built Architecture

- `frontend/`: Next.js (static export) deployed to Cloudflare Pages (site UI).
- `api/`: Cloudflare Worker (Hono) + Durable Object `SessionAnalyzer` for WebSocket streaming orchestration.
- D1: metadata and results (`personas`, `sessions`, `analyses`, `session_shares`).
- R2: uploaded source documents.
- CLIBridge: upstream LLM bridge (Roundtable calls `/v1/stream`, falls back to `/v1/complete`).
- `mcp/roundtable-mcp/`: local STDIO MCP server for running Roundtable from Claude Code/Codex without using the website.

## Key URLs (Current)

- Frontend (Pages): `https://roundtable.browsium.com`
- API (Worker): `https://roundtable-api.browsium.workers.dev`
- CLIBridge (via bypass): configured in `api/wrangler.toml` as `CLIBRIDGE_URL`

## Core Flows

### Web App

1. Frontend creates a session: `POST /sessions` (includes selected personas; can include per-session model/provider override).
2. Frontend uploads the document bytes to: `PUT /r2/upload/:sessionId/:filename`.
3. Analysis starts via WebSocket (preferred) or HTTP fallback: `POST /sessions/:id/analyze`.
4. Durable Object fans out persona analyses (batched concurrency), streams SSE chunks from CLIBridge to the browser, then stores results in D1.

### Local MCP Workflow (STDIO)

Implemented in `mcp/roundtable-mcp/`:

- `roundtable.focus_group`: creates a session + uploads file + triggers analysis + polls for completion, returning:
  - executive summary (themes, averages, recommendations)
  - full per-persona details
- `roundtable.export_session`: writes `pdf/docx/csv/md` to disk with:
  - Executive Summary first
  - Persona Details second (sorted by persona)

Install helper: `scripts/install-roundtable-mcp.ps1` (builds + registers in `C:\Users\Matt\.claude\settings.json`).

## Model/Provider Selection (Important)

Model/provider is now recorded per session and included in reports/exports.

- Global default: Settings page writes to Worker `settings` table.
- Per-session override: `POST /sessions` accepts `analysis_provider` + `analysis_model` (must be provided together).
- Durable Object resolution order:
  1. Session-scoped provider/model (preferred)
  2. Global settings
  3. Hard-coded defaults (`claude` / `sonnet`)

Supported presets live in `frontend/src/lib/analysis-presets.ts`:
`claude`, `codex`, `gemini`, `kimi 2.5`, `deepseek 3.1`, `minimax 2.1`, `deepseek r1`, `nemotron`, plus `custom`.

## Export + Share

### Export

Export works from the UI session detail page and in MCP.

- Formats: `pdf`, `docx`, `csv`, `md`
- Structure:
  1. Executive summary: common themes/highlights + dimension averages + recommendations
  2. Persona-by-persona details
- Provider/model is embedded in exports and shown in the UI session detail header.

Export logic:
- Browser exports: `frontend/src/lib/export.ts` (Blob-based)
- MCP exports: `mcp/roundtable-mcp/src/export.ts` (Node-friendly bytes)

### Share

Sharing is email-based (intended to map to CF Access identities):

- Owner can share with a list of emails: `POST /sessions/:id/share`
- API enforces access control for `GET /sessions` and `GET /sessions/:id`

## Personas + “Skills” (CLIBridge)

- Personas are stored in D1 (`personas.profile_json` is the source of truth).
- The API can deploy a persona to CLIBridge as a generated “skill”:
  - `POST /personas/:id/deploy` uploads manifest/template to CLIBridge `/admin/skills/upload`.
- Editing a persona bumps the patch version and marks it `draft` until redeployed.

Note: Runtime analysis does not execute CLIBridge skills; it builds a system prompt from persona JSON and calls `/v1/stream`.

## Auth + Security (Current vs Intended)

**Intended**: Put `roundtable.browsium.com` and the API hostname behind Cloudflare Access (`@browsium.com` only).

**Current reality**:
- The Worker accepts requests without CF Access headers and falls back to `CF-Access-Authenticated-User-Email || 'anonymous'`.
- This means the public `*.workers.dev` URL is effectively unauthenticated and can create/read sessions as “anonymous”.

Recommended hardening (pick one):
1. Put the API behind an Access-protected custom domain and disable `workers.dev` for the Worker.
2. Verify `CF-Access-Jwt-Assertion` in the Worker and reject unauthenticated traffic.
3. Add explicit API-key auth for the Worker.

Local MCP auth plan:
- Use Access Service Token headers via env vars:
  - `ROUNDTABLE_CF_ACCESS_CLIENT_ID`
  - `ROUNDTABLE_CF_ACCESS_CLIENT_SECRET`
- Optional: pin ownership:
  - `ROUNDTABLE_USER_EMAIL=matt@browsium.com`

## Local Dev Commands

Frontend:
```powershell
cd frontend
npm install
npm run dev
```

API (Worker):
```powershell
cd api
npm install
npm run dev
```

MCP:
```powershell
cd mcp/roundtable-mcp
npm install
npm run dev
```

## Troubleshooting Notes

- “Frontend still shows old version”: Cloudflare Pages is serving an older build. Redeploy Pages (the UI reads version from build-time env injected in `frontend/next.config.ts`).
- “No response data received from CLIBridge”: `SessionAnalyzer` now has SSE idle/total timeouts and falls back to `/v1/complete`. If this still happens, inspect Worker logs (`wrangler tail`) and CLIBridge availability.
- “One persona never completes”: batching is `maxConcurrency=2`; an upstream hang would block a batch. Timeouts + complete fallback should prevent indefinite hangs; if it reappears, capture Worker logs and the problematic session id.

## Next Steps (High Priority)

1. Enforce real auth on the API (stop relying on `anonymous` fallback).
2. Package/automation for MCP install/update (CI artifact or Claude plugin-style manifest).
3. Workforce integration: create a “marketing worker” workflow that calls `roundtable.focus_group`, iterates, then exports a final report.
4. (Optional) “Single source of truth” for version across `frontend/`, `api/`, and `mcp/`.

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
CF-Access-Client-Id: $CLIBRIDGE_CLIENT_ID
CF-Access-Client-Secret: $CLIBRIDGE_CLIENT_SECRET
X-API-Key: $CLIBRIDGE_API_KEY
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
  -H "CF-Access-Client-Id: ..." \
  -H "CF-Access-Client-Secret: ..." \
  -H "X-API-Key: ..." \
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
