# Roundtable MCP Deployment (Remote HTTP)

Roundtable includes an MCP server in `mcp/roundtable-mcp/`.

You have two ways to use it:

1. **Local (STDIO)**: each machine runs the MCP server locally (best for dev; already supported via `scripts/install-roundtable-mcp.ps1`).
2. **Remote (HTTP)**: host one MCP server and point multiple machines/users at it (recommended for your “multiple machines/users” requirement).

## Remote HTTP (Docker)

The MCP server supports Streamable HTTP on `MCP_PATH` (default `/mcp`) and a simple health check on `/healthz`.

### 1) Build/Publish

This repo includes a Dockerfile at `mcp/roundtable-mcp/Dockerfile` and a GitHub Actions workflow that publishes to GHCR:

- `.github/workflows/publish-roundtable-mcp.yml`

Image tags:
- `ghcr.io/<org>/<repo>/roundtable-mcp:latest`
- `ghcr.io/<org>/<repo>/roundtable-mcp:<git-sha>`

### 2) Run On A VM

Example `docker run`:

```bash
docker run -d --name roundtable-mcp \
  -p 8789:8789 \
  -e HOST=0.0.0.0 \
  -e PORT=8789 \
  -e MCP_PATH=/mcp \
  -e MCP_AUTH_TOKENS='{"token-for-matt":"matt@browsium.com"}' \
  -e ROUNDTABLE_API_URL='https://roundtable-api.browsium.workers.dev' \
  -e ROUNDTABLE_CF_ACCESS_CLIENT_ID='...' \
  -e ROUNDTABLE_CF_ACCESS_CLIENT_SECRET='...' \
  ghcr.io/<org>/<repo>/roundtable-mcp:latest
```

Notes:
- If your Roundtable API is behind Cloudflare Access, set `ROUNDTABLE_CF_ACCESS_CLIENT_ID/SECRET` on the MCP server so it can call the API.
- Prefer `MCP_AUTH_TOKENS` over `MCP_AUTH_TOKEN`. `MCP_AUTH_TOKENS` enforces per-user session isolation by token.

### 3) Configure Claude Code (Each User)

In `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "roundtable": {
      "url": "https://roundtable-mcp.yourdomain.com/mcp",
      "headers": {
        "Authorization": "Bearer token-for-matt"
      }
    }
  }
}
```

## Remote Mode Caveats

- `roundtable.focus_group` cannot read a caller’s local `file_path` when using remote MCP. Use:
  - `file_base64` + `filename` (for binary files like PDF/DOCX), or
  - `content` + `filename` (for text content).
- `roundtable.export_session` returns an MCP `resource` by default in HTTP mode (so the client can receive the file bytes).

