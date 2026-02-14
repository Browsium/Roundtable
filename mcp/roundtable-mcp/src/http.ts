import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createRoundtableMcpServer } from './server.js';

type SessionEntry = {
  userEmail?: string;
  server: ReturnType<typeof createRoundtableMcpServer>;
  transport: StreamableHTTPServerTransport;
  createdAtMs: number;
  lastAccessMs: number;
};

function getEnv(key: string): string {
  return (process.env[key] || '').trim();
}

function parseBearerToken(req: IncomingMessage): string | null {
  const h = req.headers['authorization'];
  const v = Array.isArray(h) ? h[0] : h;
  if (!v) return null;
  const m = String(v).match(/^Bearer\s+(.+)\s*$/i);
  return m ? m[1].trim() : null;
}

function tryParseJsonMap(v: string): Record<string, string> | null {
  const raw = (v || '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(parsed)) {
      if (typeof k !== 'string' || !k.trim()) continue;
      if (typeof val !== 'string' || !val.trim()) continue;
      out[k.trim()] = val.trim();
    }
    return Object.keys(out).length ? out : null;
  } catch {
    return null;
  }
}

function resolveUserFromRequest(req: IncomingMessage): { ok: true; token?: string; userEmail?: string } | { ok: false; status: number; message: string } {
  const tokenMap = tryParseJsonMap(getEnv('MCP_AUTH_TOKENS'));
  const sharedToken = getEnv('MCP_AUTH_TOKEN');

  if (tokenMap) {
    const token = parseBearerToken(req);
    if (!token) return { ok: false, status: 401, message: 'Missing Authorization: Bearer <token>' };
    const email = tokenMap[token];
    if (!email) return { ok: false, status: 403, message: 'Invalid token' };
    return { ok: true, token, userEmail: email };
  }

  if (sharedToken) {
    const token = parseBearerToken(req);
    if (!token) return { ok: false, status: 401, message: 'Missing Authorization: Bearer <token>' };
    if (token !== sharedToken) return { ok: false, status: 403, message: 'Invalid token' };

    // Less strict: allow client to supply an email for ownership isolation.
    // NOTE: This is not safe against impersonation; prefer MCP_AUTH_TOKENS.
    const hdr = req.headers['x-roundtable-user-email'];
    const email = (Array.isArray(hdr) ? hdr[0] : hdr) ? String(Array.isArray(hdr) ? hdr[0] : hdr).trim() : '';
    return { ok: true, token, userEmail: email || undefined };
  }

  // No auth configured. This is intentionally permissive for local testing.
  const hdr = req.headers['x-roundtable-user-email'];
  const email = (Array.isArray(hdr) ? hdr[0] : hdr) ? String(Array.isArray(hdr) ? hdr[0] : hdr).trim() : '';
  return { ok: true, userEmail: email || undefined };
}

function sendJson(res: ServerResponse, status: number, obj: any): void {
  const body = JSON.stringify(obj, null, 2);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(body);
}

function getHeaderSessionId(req: IncomingMessage): string | undefined {
  const v = req.headers['mcp-session-id'];
  const s = Array.isArray(v) ? v[0] : v;
  const out = (s ? String(s) : '').trim();
  return out || undefined;
}

export async function runHttpMcpServer(options: { version: string }): Promise<void> {
  const host = getEnv('HOST') || '0.0.0.0';
  const port = Number.parseInt(getEnv('PORT') || '8789', 10);
  const mcpPath = getEnv('MCP_PATH') || '/mcp';

  const sessionTtlSeconds = Number.parseInt(getEnv('MCP_SESSION_TTL_SECONDS') || '14400', 10); // 4h
  const cleanupIntervalSeconds = Number.parseInt(getEnv('MCP_SESSION_CLEANUP_SECONDS') || '60', 10);

  const sessions = new Map<string, SessionEntry>();

  function cleanupExpiredSessions() {
    const now = Date.now();
    const ttlMs = Math.max(60, sessionTtlSeconds) * 1000;
    for (const [sid, entry] of sessions.entries()) {
      if (now - entry.lastAccessMs > ttlMs) {
        sessions.delete(sid);
        entry.transport.close().catch(() => undefined);
      }
    }
  }

  setInterval(cleanupExpiredSessions, Math.max(10, cleanupIntervalSeconds) * 1000).unref();

  async function createNewSession(userEmail?: string): Promise<StreamableHTTPServerTransport> {
    const createdAtMs = Date.now();
    const server = createRoundtableMcpServer({ version: options.version, mode: 'http', userEmail });

    // Session ID is generated on initialize. We register the transport into `sessions`
    // when that happens, then use the transport instance for all subsequent requests.
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        sessions.set(sid, {
          userEmail,
          server,
          transport,
          createdAtMs,
          lastAccessMs: Date.now(),
        });
      },
      onsessionclosed: (sid) => {
        const entry = sessions.get(sid);
        if (entry) {
          sessions.delete(sid);
          entry.transport.close().catch(() => undefined);
        }
      },
    });

    await server.connect(transport);
    return transport;
  }

  const srv = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      if (url.pathname === '/healthz') {
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname !== mcpPath) {
        return sendJson(res, 404, { error: `Not found. Use ${mcpPath}` });
      }

      const auth = resolveUserFromRequest(req);
      if (!auth.ok) {
        return sendJson(res, auth.status, { error: auth.message });
      }

      const sessionId = getHeaderSessionId(req);
      if (sessionId) {
        const entry = sessions.get(sessionId);
        if (!entry) {
          return sendJson(res, 404, { error: 'Unknown session. Re-initialize.' });
        }
        if (entry.userEmail && entry.userEmail !== auth.userEmail) {
          return sendJson(res, 403, { error: 'Session does not belong to this user.' });
        }
        entry.lastAccessMs = Date.now();
        await entry.transport.handleRequest(req as any, res as any);
        return;
      }

      // No session ID: this should be an initialize flow. Create a new session transport+server.
      const transport = await createNewSession(auth.userEmail);
      await transport.handleRequest(req as any, res as any);

      // If the initialize failed, we may not have a session ID. Clean up this transport.
      const sid = transport.sessionId;
      if (!sid || !sessions.has(sid)) {
        transport.close().catch(() => undefined);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendJson(res, 500, { error: msg });
    }
  });

  await new Promise<void>((resolve) => {
    srv.listen(port, host, () => resolve());
  });

  // eslint-disable-next-line no-console
  console.log(`roundtable-mcp http listening on http://${host}:${port}${mcpPath}`);
}
