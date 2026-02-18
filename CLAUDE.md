# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Is Roundtable

Roundtable runs marketing documents through a panel of 9 cybersecurity industry personas (CISO, CTO, CIO, etc.). Each persona provides scored, actionable feedback from their professional perspective. It supports multiple AI backends, council mode (multi-model synthesis), and real-time streaming via WebSocket.

## Architecture

Three independent packages in one monorepo — no shared workspace tooling:

```
frontend/     → Next.js 15 (static export to Cloudflare Pages)
api/          → Cloudflare Workers + Hono (D1 database, R2 storage, Durable Objects)
backend/      → FastAPI (alternative/legacy deployment on Render.com)
mcp/roundtable-mcp/ → MCP server for Claude Code integration
```

**Production stack (Cloudflare path):** Frontend on Pages → Workers API → D1/R2 → CLIBridge (OracleVM) → Claude CLI subprocess. Authentication via Cloudflare Access (`CF-Access-Authenticated-User-Email` header).

**The `backend/` directory is the alternative Python deployment path** (Render.com). The primary production API is `api/` (Cloudflare Workers). Both implement the same endpoints but `api/` is authoritative.

## Build & Dev Commands

### Frontend (`frontend/`)
```bash
npm ci                  # install deps
npm run dev             # local dev server (localhost:3000)
npm run build           # static export to frontend/dist/
npm run lint            # ESLint
```
- Output is `frontend/dist/` (static export, `output: 'export'` in next.config.ts)
- Build writes `.build-meta.json` via `scripts/write-build-meta.js` before Next.js build
- API URL: `NEXT_PUBLIC_API_URL` env var or localStorage `api_url` override, defaults to production Workers URL

### API (Workers) (`api/`)
```bash
npm ci                  # install deps
npm run dev             # wrangler dev (local Workers runtime)
npm run deploy          # deploy to Cloudflare
npm run d1:migrate      # apply D1 migrations
```
- Wrangler bindings: `DB` (D1), `R2` (R2 bucket), `SESSION_ANALYZER` (Durable Object)
- Secrets set via `wrangler secret put`: `CLIBRIDGE_CLIENT_ID`, `CLIBRIDGE_CLIENT_SECRET`, `CLIBRIDGE_API_KEY`

### Backend (Python) (`backend/`)
```bash
python -m venv .venv && source .venv/bin/activate  # or .venv\Scripts\activate on Windows
pip install -r requirements.txt
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```
- Config via `.env` file (see `backend/README.md`)
- Swagger UI at `http://localhost:8000/docs`

### MCP Server (`mcp/roundtable-mcp/`)
```bash
npm ci && npm run build   # compile TypeScript
npm run dev               # stdio mode (for Claude Code)
npm run dev:http          # HTTP mode
```

## API Route Map (Workers — `api/src/`)

| Route prefix | File | Purpose |
|---|---|---|
| `/personas` | `routes/personas.ts` | Persona CRUD + deploy to CLIBridge |
| `/persona-groups` | `routes/persona-groups.ts` | Role-based persona variants, generation |
| `/sessions` | `routes/sessions.ts` | Session CRUD, share, retry |
| `/sessions/:id/analyze` | `index.ts` (WebSocket upgrade) | Streaming analysis via Durable Object |
| `/r2` | `routes/r2.ts` | Document upload to R2 |
| `/settings` | `routes/settings.ts` | Global backend settings |
| `/clibridge` | `routes/clibridge.ts` | Proxy health check |
| `/version` | `index.ts` | Version + build date |

## Key Source Locations

### API (`api/src/`)
- `durable-objects/session-analyzer.ts` — WebSocket handler that orchestrates per-persona analysis streaming
- `lib/d1.ts` — D1 database client (all SQL queries live here)
- `lib/clibridge.ts` — HTTP client for CLIBridge AI execution service
- `lib/skill-generator.ts` — Generates skill manifest + template for CLIBridge deployment
- `lib/analysis-backend.ts` — Analysis backend abstraction
- `lib/document-processor.ts` — PDF/DOCX text extraction (JavaScript-side, using mammoth + pdf-lib)

### Frontend (`frontend/src/`)
- `lib/api.ts` — All API client functions (`personaApi`, `sessionApi`, `r2Api`, `settingsApi`, `clibridgeApi`) + `AnalysisWebSocket` class
- `lib/types.ts` — TypeScript interfaces (`Persona`, `Session`, `Analysis`, `WebSocketMessage`, `AnalysisArtifact`)
- `lib/analysis-presets.ts` — Model preset configurations
- `app/page.tsx` — Upload wizard (drag-drop + persona selection + backend selector + council mode)
- `app/sessions/detail/page.tsx` — Analysis results dashboard
- `app/personas/page.tsx` — Persona management
- `app/settings/page.tsx` — Settings page
- `components/ScannerBar.tsx`, `components/HourglassSpinner.tsx` — Animated UI components

### Personas (`backend/personas/`)
9 JSON files defining cybersecurity personas. Each includes: background, priorities, pet_peeves, evaluation_rubric, convince_me criteria, voice/tone, objections, industry_influences, budget_authority. D1 is the operational store; these JSON files are the golden source, hot-reloadable.

## Database

**D1 (SQLite)** with migrations in `api/migrations/`:
- `001_initial_schema.sql` — personas, sessions, analyses tables
- `002_add_analysis_backend_columns.sql` — provider/model columns on sessions + analyses
- `003_add_workflows_persona_groups_artifacts.sql` — council workflow, persona groups, artifacts

Apply migrations: `cd api && npm run d1:migrate`

Key tables: `personas`, `sessions`, `analyses`, `persona_groups`, `artifacts`, `settings`

## CI/CD (GitHub Actions)

| Workflow | Trigger | What it does |
|---|---|---|
| `deploy.yml` | Push to `main` (api/** changes) | Deploys Workers via wrangler |
| `deploy-pages.yml` | Push to `main` (frontend/** changes) | Builds Next.js, deploys to Cloudflare Pages |
| `cleanup-skills.yml` | Daily cron | Deletes CLIBridge skills older than 60 days |
| `publish-roundtable-mcp.yml` | Push to `main` (mcp/** changes) | Publishes MCP Docker image |

## Production URLs

- Frontend: `https://roundtable.browsium.com` (Cloudflare Pages)
- API: `https://roundtable-api.browsium.workers.dev` (Cloudflare Workers)
- CLIBridge: `https://clibridge.badrobots.net` (OracleVM)

## Key Design Decisions

- **CLI-based AI execution**: Calls Claude Code CLI subprocess via CLIBridge, not direct API — no token cost to Roundtable itself
- **D1 is source of truth** for persona data; skills deployed to CLIBridge are compiled versions
- **WebSocket via Durable Objects** (`SessionAnalyzer`) for real-time streaming; reconnection with exponential backoff (2s, 4s, 8s)
- **Council mode**: Multiple AI models evaluate document, one chairman model synthesizes final verdict
- **R2 document storage**: Private bucket, presigned URLs with 1-hour expiry, auto-cleanup after 30 days
- **Static export frontend**: `output: 'export'` — no server-side rendering, deployed as static files to Pages
- **Session access control**: Owner + explicitly shared emails; enforced both at API layer and WebSocket upgrade

## Version Management

All three packages share a version number (currently 1.2.8), maintained separately in each `package.json`. The frontend version is injected at build time via `next.config.ts` reading `package.json`.

## Path Alias

Frontend uses `@/*` → `./src/*` (configured in `tsconfig.json`). Import as `@/lib/api`, `@/components/ScannerBar`, etc.

## CORS

Workers API allows origins: `https://roundtable.browsium.com` and `http://localhost:3000`. Update the CORS config in `api/src/index.ts` if adding new frontend origins.
