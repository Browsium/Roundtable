# Decisions And Next Steps (2026-02-14)

This document captures what was decided/implemented recently, why, and what remains.

## Decisions Made

### 1) Session-Scoped Model/Provider (Not Global-Only)

**Decision**: The analysis backend selection (`analysis_provider` + `analysis_model`) is stored per-session and included in the report/export.

**Why**:
- Global-only settings are race-prone (changing settings mid-run can corrupt attribution).
- Reports need to say which backend produced the results.

**Implementation**:
- `POST /sessions` accepts optional `analysis_provider` + `analysis_model` (must be provided together).
- D1 schema includes backend columns on both `sessions` and `analyses`.
- Exports include backend provider/model in headers and CSV columns.

### 2) Streaming Robustness: Timeouts + Complete Fallback

**Decision**: Treat CLIBridge SSE streams as unreliable and enforce time bounds.

**Why**:
- The observed failure mode was “No response data received from CLIBridge” after SSE stalls or returns no usable content.
- A single persona hang can block its concurrency batch.

**Implementation**:
- `SessionAnalyzer` enforces an idle timeout and a total timeout for SSE reads.
- If streaming yields nothing usable, it falls back to `/v1/complete` and continues.

### 3) Concurrency Limited To Avoid Cloudflare Subrequest Limits

**Decision**: Run persona analyses in small batches (`maxConcurrency=2`) via `Promise.all` per batch.

**Why**:
- Workers have subrequest limits and upstream calls can be heavy.
- Smaller batches are slower but more stable.

### 4) Export Is MVP: PDF/DOCX/CSV/MD With A Consistent Structure

**Decision**: Export formats are included as a core feature.

**Structure**:
1. Executive Summary: themes + averages + recommendations.
2. Persona Details: full feedback by persona.

**Notes**:
- UI exports are browser-native (Blob-based) in `frontend/src/lib/export.ts`.
- MCP exports are Node-friendly (bytes written to disk) in `mcp/roundtable-mcp/src/export.ts`.

### 5) Local STDIO MCP Server Lives In This Repo

**Decision**: Implement the “Roundtable from Claude/Codex” workflow as a local STDIO MCP server in this codebase.

**Why**:
- Keeps the CLI workflow simple and does not require deploying another service.
- Lets Claude Code/Codex call Roundtable via tools without using the website.

**Implementation**:
- Package: `mcp/roundtable-mcp/`
- Tools:
  - `roundtable.list_personas`
  - `roundtable.focus_group`
  - `roundtable.get_session`
  - `roundtable.export_session`
- Installer: `scripts/install-roundtable-mcp.ps1` (build + register in Claude settings).

### 6) Persona “Deploy” Treated As A Build Artifact

**Decision**: Editing a persona bumps patch version and marks it `draft` until redeployed.

**Why**:
- Deployed skill is a compiled artifact of the persona definition.
- Avoids ambiguity about which skill version is currently active.

### 7) Auth Posture: Cloudflare Access Intended, Not Yet Enforced

**Decision**: The app is intended to sit behind Cloudflare Access, but the current public `*.workers.dev` API is effectively unauthenticated.

**Why it matters**:
- The API falls back to `anonymous` if Access headers are missing.
- Without Access enforced, session isolation is not real.

## Next Steps

### A) Auth Hardening (Do This First)

Pick one and implement end-to-end:

1. **Custom API hostname behind Access + disable `workers.dev`**
   - Best default: simplest mental model, least footguns.
2. **Verify Access JWT in Worker**
   - More engineering; strongest guarantee even if `workers.dev` remains enabled.
3. **API key auth**
   - Quickest; separate from Access; still needs an identity model for sharing.

### B) MCP “Deployment” Automation

Even though MCP is local, you still want repeatable installs/updates:

- Add a CI build that produces a zip/release artifact for `mcp/roundtable-mcp/dist`.
- Optionally add a Claude plugin-style manifest and `.mcp.json` to avoid manual config edits.

### C) Workforce Integration (Marketing Worker)

Target behavior:

1. `roundtable.focus_group` with `panel: "fast"` for iterative feedback.
2. Synthesize top themes and a prioritized fix list.
3. Rewrite the draft.
4. Optional: rerun with `panel: "full"` as the “final gate”.
5. `roundtable.export_session` to attach a shareable report.

### D) Version Single Source Of Truth (Optional)

Right now `frontend/`, `api/`, and `mcp/` each have their own `package.json` version.

If you want one value:
- Add a root `VERSION` file (or root package/workspace) and have builds read from it.

### E) MCP Tooling Enhancements (Optional)

- Add `roundtable.share_session` tool.
- Add persona tools (`create_persona`, `update_persona`, `deploy_persona`) if you want persona iteration entirely via CLI/agents.

