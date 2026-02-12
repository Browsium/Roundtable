# New Session Prompt - Roundtable + CLIBridge Integration

**Copy and paste this into a new Claude Code session to continue the project:**

---

## Context

I need you to continue implementing the Roundtable + CLIBridge integration project. This is a redesign of the Roundtable application to use CLIBridge as the AI backend via Cloudflare infrastructure.

**Current Status**: Documentation is complete. Phase 1 (Cloudflare setup) may or may not be done - check with the user.

**Repository**: `/Users/matteller/Projects/Roundtable/`

**Key Documents** (read these first):
1. `docs/HANDOFF.md` - Complete project handoff document
2. `docs/ARCHITECTURE.md` - System architecture
3. `docs/IMPLEMENTATION_PLAN.md` - Detailed roadmap
4. `docs/CLOUDFLARE_SETUP.md` - Cloudflare configuration steps
5. `docs/CLIBRIDGE_INTEGRATION.md` - CLIBridge API requirements

---

## What You Need To Do

### Phase 1 Check: Verify Cloudflare Setup

**Ask the user**: "Has Cloudflare setup been completed? (D1 database, R2 bucket, Workers project created?)"

**If NO**: Guide them through `docs/CLOUDFLARE_SETUP.md` first.

**If YES**: Proceed to Phase 2.

### Phase 2: Build Workers Backend

**Location**: `/Users/matteller/Projects/Roundtable/api/`

**Create the following structure**:

```
api/
├── src/
│   ├── index.ts
│   ├── routes/
│   │   ├── sessions.ts
│   │   ├── personas.ts
│   │   └── r2.ts
│   ├── durable-objects/
│   │   └── session-analyzer.ts
│   └── lib/
│       ├── clibridge.ts
│       ├── d1.ts
│       ├── r2.ts
│       ├── document-processor.ts
│       └── skill-generator.ts
├── wrangler.toml
├── package.json
└── tsconfig.json
```

**Key Implementation Requirements**:

1. **CLIBridge Client** (`lib/clibridge.ts`):
   - Base URL: `https://bypass.badrobots.net/clibridge`
   - Required headers on ALL requests:
     ```
     CF-Access-Client-Id: 72895a2b904f0cf918b46bcbaad7778f.access
     CF-Access-Client-Secret: 4ba474883c884225479cf644be7942d6ce5fc747834fe5c3c2ae70a34df39a2d
     X-API-Key: pmk_0a1e0e1016ab47238cc343a40dcab913
     ```

2. **Durable Object** (`durable-objects/session-analyzer.ts`):
   - Handle WebSocket connections from frontend
   - Call CLIBridge `/v1/stream` for each persona concurrently
   - Forward SSE chunks to WebSocket
   - Save final results to D1

3. **Document Processing** (`lib/document-processor.ts`):
   - Libraries: `pdf-parse`, `mammoth`, `pptx-parser`
   - Extract text from uploaded documents in R2

4. **Skill Generator** (`lib/skill-generator.ts`):
   - Read persona JSON from D1
   - Generate manifest.yaml and analyze.tmpl
   - Upload to CLIBridge via `POST /admin/skills/upload`

### Phase 3: Persona Migration

Convert existing 9 personas in `backend/personas/` to CLIBridge skills:

1. Read JSON files
2. Generate skill files
3. Upload via API
4. Insert into D1

See `docs/SAMPLE_SKILL.md` for the conversion format.

### Phase 4: Frontend Migration

Update the Next.js frontend in `/Users/matteller/Projects/Roundtable/frontend/`:

1. Replace API client (`src/lib/api.ts`)
2. Add WebSocket connection
3. Update file upload to use R2 presigned URLs
4. Add streaming analysis display
5. Update persona management

### Phase 5: GitHub Actions

Create workflows:
- `.github/workflows/deploy.yml` - Deploy Workers on push
- `.github/workflows/cleanup-skills.yml` - Daily cron for skill cleanup

---

## Critical Information

### Technology Stack
- **Frontend**: Next.js 14, TypeScript, Tailwind
- **Backend**: Cloudflare Workers (TypeScript)
- **Database**: Cloudflare D1 (SQLite)
- **Storage**: Cloudflare R2
- **AI**: CLIBridge + Claude CLI
- **WebSocket**: Durable Objects

### CLIBridge Endpoints to Use
- `POST /v1/stream` - Streaming analysis (returns SSE)
- `POST /admin/skills/upload` - Upload skill (multipart form)
- `POST /admin/skills/cleanup` - Delete old skills
- `GET /admin/skills` - List skills

### Personas to Convert (9 total)
1. CISO (`ciso_enterprise`) - Victoria Chen
2. CIO (`cio_enterprise`) - Jennifer Martinez
3. CTO (`cto_enterprise`) - Raj Patel
4. Compliance Officer (`compliance_officer`) - Amanda Thompson
5. IT Administrator (`it_administrator`) - Marcus Rodriguez
6. IT Auditor (`it_auditor`) - Michael Brooks
7. IT Security Administrator (`it_security_administrator`) - Sarah Kim
8. IT Security Director (`it_security_director`) - David Park
9. Security Consulting Leader (`security_consulting_leader`) - Elena Vasquez

### Naming Conventions
- **Skill name**: `roundtable-{persona_id}-v{version}`
  - Example: `roundtable-ciso_enterprise-v1.0.0`
- **D1 tables**: `personas`, `sessions`, `analyses`
- **R2 bucket**: `roundtable-documents`

---

## Testing Strategy

### Unit Tests
- Document processing
- Skill generation
- D1 operations
- CLIBridge client

### Integration Tests
- End-to-end analysis
- WebSocket reconnection (3 attempts: 2s, 4s, 8s)
- Skill upload → execution

### Manual Test Commands

```bash
# Test CLIBridge skill upload
curl -X POST https://bypass.badrobots.net/clibridge/admin/skills/upload \
  -H "CF-Access-Client-Id: 72895a2b904f0cf918b46bcbaad7778f.access" \
  -H "CF-Access-Client-Secret: 4ba474883c884225479cf644be7942d6ce5fc747834fe5c3c2ae70a34df39a2d" \
  -H "X-API-Key: pmk_0a1e0e1016ab47238cc343a40dcab913" \
  -F "skill_name=roundtable-test-v1.0.0" \
  -F "manifest=@test-manifest.yaml" \
  -F "template=@test-template.tmpl"
```

---

## Dependencies

1. **CLIBridge Skill Upload Endpoint** (being built by separate team)
   - Must be ready before Phase 3
   - Status: Ask user

2. **Cloudflare Infrastructure** (user must set up Phase 1)
   - D1, R2, Workers
   - Status: Ask user

---

## Success Criteria

- [ ] All 9 personas converted to CLIBridge skills
- [ ] Analysis streams via WebSocket
- [ ] New personas addable via web UI
- [ ] Document upload with R2
- [ ] No data loss
- [ ] Security audit passed

---

## Important Notes

- This is a **redesign**, not a migration (no production system to break)
- CLIBridge is on OracleVM at `clibridge.badrobots.net`
- CLIBridge bypass URL: `bypass.badrobots.net/clibridge`
- WebSocket: Native + custom reconnection (3 attempts, exponential backoff)
- Analysis: Concurrent (all 9 personas simultaneously)
- Authoritative source: D1 (skills are compiled versions)

---

## Questions to Ask User

1. Has Cloudflare setup been completed? (Phase 1)
2. Is the CLIBridge skill upload endpoint ready?
3. Do you want me to start with a specific phase?
4. Any changes to the documented architecture?

---

**Ready to begin implementation!**
