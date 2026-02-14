# New Session Prompt (After Reboot) - Roundtable

Copy/paste this into a new Claude Code/Codex session.

---

## Context

You are continuing work on the Roundtable repo:

- Repo path: `C:\Users\Matt\Documents\Projects\Roundtable`
- Current app version: `1.2.0`
- Stack:
  - `frontend/`: Next.js static export (Cloudflare Pages)
  - `api/`: Cloudflare Worker + Durable Object `SessionAnalyzer` + D1 + R2
  - Upstream: CLIBridge (`/v1/stream` with `/v1/complete` fallback)
  - `mcp/roundtable-mcp/`: local STDIO MCP server for calling Roundtable without the website

## Read These First

1. `docs/HANDOFF.md`
2. `docs/DECISIONS_AND_NEXT_STEPS.md`
3. `docs/ARCHITECTURE.md` (background, may be slightly idealized vs current auth reality)

## What’s Already Implemented (Do Not Rebuild)

- Export (PDF/DOCX/CSV/MD) with exec summary first, persona details second.
- Share (email-based sharing) enforced in the Worker API.
- Session-scoped analysis backend selection:
  - `analysis_provider` + `analysis_model` stored per session and per analysis.
  - Included in UI and exports.
- Persona deploy UI + API route (uploads persona skill files to CLIBridge).
- Local MCP server (`roundtable-mcp`) with:
  - `roundtable.list_personas`
  - `roundtable.focus_group`
  - `roundtable.get_session`
  - `roundtable.export_session`

## Immediate Priority

Auth hardening for the Worker API. Right now it falls back to `anonymous` if CF Access headers are missing, which means the public `*.workers.dev` hostname is not safe for multi-user isolation.

## Quick Commands (Re-orient)

```powershell
cd C:\Users\Matt\Documents\Projects\Roundtable
git status -sb
git log -n 10 --oneline --decorate
```

Worker dev:
```powershell
cd api
npm install
npm run dev
```

Frontend dev:
```powershell
cd frontend
npm install
npm run dev
```

MCP install (registers with Claude settings):
```powershell
pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\install-roundtable-mcp.ps1
```

## MCP Environment Variables

The local MCP server can send Access headers if you set these in your shell environment:

- `ROUNDTABLE_API_URL` (default is the current workers.dev URL)
- `ROUNDTABLE_CF_ACCESS_CLIENT_ID`
- `ROUNDTABLE_CF_ACCESS_CLIENT_SECRET`
- `ROUNDTABLE_USER_EMAIL` (optional, pins session ownership when using a service token)

## Guardrails

- There are many untracked local debug scripts in the repo root; don’t commit them unless explicitly requested.
- Don’t add secrets/tokens into docs or source control. Use Wrangler secrets and/or GitHub secrets.
