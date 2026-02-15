import { Hono } from 'hono';
import type { Env } from '../index';
import { CLIBridgeClient } from '../lib/clibridge';

export const clibridgeRoutes = new Hono<{ Bindings: Env }>();

// Proxy CLIBridge health so the frontend can use it without needing Cloudflare Access headers.
clibridgeRoutes.get('/health', async (c) => {
  try {
    const client = new CLIBridgeClient(c.env);
    const data = await client.health();
    return c.json(data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return c.json({ error: msg }, 502);
  }
});

