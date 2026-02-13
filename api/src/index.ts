import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { SessionAnalyzer } from './durable-objects/session-analyzer';
import { personaRoutes } from './routes/personas';
import { sessionRoutes } from './routes/sessions';
import { r2Routes } from './routes/r2';
import { settingsRoutes } from './routes/settings';
import { D1Client } from './lib/d1';
import pkg from '../package.json';

export interface Env {
  DB: D1Database;
  R2: R2Bucket;
  SESSION_ANALYZER: DurableObjectNamespace;
  CLIBRIDGE_URL: string;
  CLIBRIDGE_CLIENT_ID: string;
  CLIBRIDGE_CLIENT_SECRET: string;
  CLIBRIDGE_API_KEY: string;
}

const app = new Hono<{ Bindings: Env }>();
const BUILD_DATE = new Date().toISOString();

// CORS middleware
app.use('*', cors({
  origin: ['https://roundtable.browsium.com', 'http://localhost:3000'],
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'CF-Access-Authenticated-User-Email'],
  credentials: true,
}));

// Health check
app.get('/', (c) => c.json({ status: 'ok', service: 'roundtable-api' }));

// Version endpoint
app.get('/version', (c) => c.json({
  version: pkg.version,
  build_date: BUILD_DATE,
  environment: 'production',
  service: 'roundtable-api'
}));

// Routes
app.route('/personas', personaRoutes);
app.route('/sessions', sessionRoutes);
app.route('/r2', r2Routes);
app.route('/settings', settingsRoutes);

// WebSocket upgrade endpoint
app.get('/sessions/:id/analyze', async (c) => {
  const sessionId = c.req.param('id');
  const viewerEmail = c.req.header('CF-Access-Authenticated-User-Email') || 'anonymous';

  // Enforce session access before upgrading to a WebSocket.
  const db = new D1Client(c.env.DB);
  const session = await db.getSession(sessionId);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const isOwner = session.user_email === viewerEmail;
  const hasAccess = isOwner || await db.isSessionSharedWith(sessionId, viewerEmail);
  if (!hasAccess) {
    return c.json({ error: 'Access denied' }, 403);
  }

  const id = c.env.SESSION_ANALYZER.idFromName(sessionId);
  const analyzer = c.env.SESSION_ANALYZER.get(id);
  
  return await analyzer.fetch(c.req.raw);
});

export default app;
export { SessionAnalyzer };
