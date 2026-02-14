# roundtable-mcp (Local STDIO MCP Server)

This package exposes Roundtable as an MCP server over STDIO (for Claude Code/Codex-style tool calling).

## Tools

- `roundtable.list_personas`
- `roundtable.focus_group`
- `roundtable.get_session`
- `roundtable.export_session` (pdf/docx/csv/md)

## Environment Variables

- `ROUNDTABLE_API_URL`
  - Default: `https://roundtable-api.browsium.workers.dev`
- `ROUNDTABLE_CF_ACCESS_CLIENT_ID` / `ROUNDTABLE_CF_ACCESS_CLIENT_SECRET`
  - Optional Cloudflare Access service token headers for calling a protected API.
- `ROUNDTABLE_USER_EMAIL`
  - Optional. If set, sends `CF-Access-Authenticated-User-Email` header (useful when using a service token and you still want sessions owned by a specific email).

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

