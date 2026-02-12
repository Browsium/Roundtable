import { Hono } from 'hono';
import type { Env } from '../index';
import { D1Client } from '../lib/d1';
import { R2Client } from '../lib/r2';
import { generateR2Key, getFileExtension } from '../lib/document-processor';

export const sessionRoutes = new Hono<{ Bindings: Env }>();

// Get all sessions for user
sessionRoutes.get('/', async (c) => {
  const userEmail = c.req.header('CF-Access-Authenticated-User-Email') || 'anonymous';
  const db = new D1Client(c.env.DB);
  const sessions = await db.getSessions(userEmail);
  return c.json(sessions);
});

// Get single session
sessionRoutes.get('/:id', async (c) => {
  const db = new D1Client(c.env.DB);
  const session = await db.getSession(c.req.param('id'));
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }
  
  // Get analyses
  const analyses = await db.getAnalyses(session.id);
  
  return c.json({
    ...session,
    analyses,
  });
});

// Create session (metadata only, file uploaded separately)
sessionRoutes.post('/', async (c) => {
  const body = await c.req.json();
  const { file_name, file_size_bytes, file_extension, selected_persona_ids } = body;
  
  if (!file_name || !selected_persona_ids) {
    return c.json({ error: 'file_name and selected_persona_ids are required' }, 400);
  }
  
  const userEmail = c.req.header('CF-Access-Authenticated-User-Email') || 'anonymous';
  const sessionId = crypto.randomUUID();
  const r2Key = generateR2Key(sessionId, file_name);
  
  const db = new D1Client(c.env.DB);
  await db.createSession({
    id: sessionId,
    user_email: userEmail,
    file_name,
    file_r2_key: r2Key,
    file_size_bytes: file_size_bytes || 0,
    file_extension: file_extension || getFileExtension(file_name),
    selected_persona_ids: JSON.stringify(selected_persona_ids),
    status: 'uploaded',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  
  // Create analysis records for each persona
  for (const personaId of selected_persona_ids) {
    await db.createAnalysis({
      session_id: sessionId,
      persona_id: personaId,
      status: 'pending',
    });
  }
  
  const session = await db.getSession(sessionId);
  return c.json(session, 201);
});

// Update session
sessionRoutes.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  
  const db = new D1Client(c.env.DB);
  const existing = await db.getSession(id);
  if (!existing) {
    return c.json({ error: 'Session not found' }, 404);
  }
  
  const updates: any = {};
  if (body.status) updates.status = body.status;
  if (body.selected_persona_ids) updates.selected_persona_ids = JSON.stringify(body.selected_persona_ids);
  
  await db.updateSession(id, updates);
  const updated = await db.getSession(id);
  return c.json(updated);
});

// Delete session
sessionRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const db = new D1Client(c.env.DB);

  const session = await db.getSession(id);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  // Delete from R2
  const r2 = new R2Client(c.env.R2, '2b2861c0bba0855e5f6ed79a9451e6b2');
  await r2.deleteDocument(session.file_r2_key);

  // Delete from D1
  await db.deleteSession(id);

  return c.json({ message: 'Session deleted' });
});

// Trigger analysis manually (fallback for when WebSocket doesn't work)
sessionRoutes.post('/:id/analyze', async (c) => {
  const id = c.req.param('id');
  const db = new D1Client(c.env.DB);

  const session = await db.getSession(id);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  // Trigger the durable object to start analysis
  const analyzerId = c.env.SESSION_ANALYZER.idFromName(id);
  const analyzer = c.env.SESSION_ANALYZER.get(analyzerId);

  // Send a message to start analysis
  await analyzer.fetch(new Request('http://internal/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: id }),
  }));

  return c.json({ message: 'Analysis started', session_id: id });
});
