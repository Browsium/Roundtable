# roundtable-mcp (STDIO + Remote HTTP MCP Server)

This package exposes Roundtable as an MCP server over:

- **STDIO** (local, spawned by Claude Code/Codex)
- **Streamable HTTP** (remote, shared across machines/users)

## Tools

- `roundtable.list_personas`
- `roundtable.create_persona`
- `roundtable.update_persona`
- `roundtable.deploy_persona`
- `roundtable.focus_group`
- `roundtable.get_session`
- `roundtable.export_session` (pdf/docx/csv/md; in HTTP mode returns an MCP resource by default)

## Environment Variables

- `ROUNDTABLE_API_URL`
  - Default: `https://roundtable-api.browsium.workers.dev`
- `ROUNDTABLE_CF_ACCESS_CLIENT_ID` / `ROUNDTABLE_CF_ACCESS_CLIENT_SECRET`
  - Optional Cloudflare Access service token headers for calling a protected API.
- `ROUNDTABLE_USER_EMAIL`
  - Optional. If set, sends `CF-Access-Authenticated-User-Email` header (useful when using a service token and you still want sessions owned by a specific email).

### Docker MCP Gateway (Remote STDIO)

If you run this server under **Docker MCP Gateway**, it uses STDIO transport but behaves like a remote server.
Set:

- `ROUNDTABLE_MCP_REMOTE=1`

Effects:
- Disables `file_path` input (use `file_base64+filename` or `content+filename`).
- Returns exports as MCP `resource` blobs by default (instead of writing to disk on the container).

### Remote HTTP Server (Recommended Settings)

- `HOST` / `PORT`
  - Defaults: `0.0.0.0` / `8789`
- `MCP_PATH`
  - Default: `/mcp`
- `MCP_AUTH_TOKENS`
  - JSON map of `{ "<token>": "<user@domain>" }` (recommended for multi-user).
- `MCP_AUTH_TOKEN`
  - Single shared token (less secure; multi-user identity can be provided via `X-Roundtable-User-Email` header).

## Dev

```bash
cd mcp/roundtable-mcp
npm install
npm run dev
```

## Build

```bash
cd mcp/roundtable-mcp
npm install
npm run build
npm run start
```

## Run Remote HTTP Server

```bash
cd mcp/roundtable-mcp
npm install
npm run build
set HOST=0.0.0.0
set PORT=8789
set MCP_AUTH_TOKENS={"token-for-matt":"matt@browsium.com"}
node dist/index.js --http
```

Claude Code config example:

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

Notes:
- In remote mode, `roundtable.focus_group` cannot read your local file system. Use `file_base64+filename` or `content+filename`.
- In remote mode, `roundtable.export_session` returns the export as an MCP `resource` by default (so the client can receive the file bytes).
