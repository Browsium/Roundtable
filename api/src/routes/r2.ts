import { Hono } from 'hono';
import type { Env } from '../index';
import { R2Client } from '../lib/r2';
import { D1Client } from '../lib/d1';

export const r2Routes = new Hono<{ Bindings: Env }>();

// Get presigned upload URL
r2Routes.get('/upload-url', async (c) => {
  const sessionId = c.req.query('session_id');
  const filename = c.req.query('filename');
  
  if (!sessionId || !filename) {
    return c.json({ error: 'session_id and filename are required' }, 400);
  }
  
  // For now, return the upload endpoint URL
  // The actual upload will be handled by the upload endpoint
  return c.json({
    uploadUrl: `/r2/upload/${sessionId}/${encodeURIComponent(filename)}`,
    method: 'PUT',
  });
});

// Upload file directly to R2
r2Routes.put('/upload/:sessionId/:filename{.+}', async (c) => {
  const sessionId = c.req.param('sessionId');
  const filename = decodeURIComponent(c.req.param('filename'));

  const r2 = new R2Client(c.env.R2, '2b2861c0bba0855e5f6ed79a9451e6b2');
  const contentType = c.req.header('Content-Type') || 'application/octet-stream';

  try {
    // Get the session to find the correct R2 key
    const db = new D1Client(c.env.DB);
    const session = await db.getSession(sessionId);
    
    if (!session) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const data = await c.req.arrayBuffer();
    
    // Use the file_r2_key that was stored when the session was created
    const key = session.file_r2_key;

    await r2.uploadDocument(key, data, contentType);
    
    // Update session file size
    await db.updateSession(sessionId, { 
      file_size_bytes: data.byteLength,
      status: 'uploaded'
    });

    return c.json({
      success: true,
      key,
      size: data.byteLength,
    });
  } catch (error) {
    return c.json({ error: 'Upload failed', details: String(error) }, 500);
  }
});

// Get document
r2Routes.get('/documents/:key{.+}', async (c) => {
  const key = c.req.param('key');
  const r2 = new R2Client(c.env.R2, '2b2861c0bba0855e5f6ed79a9451e6b2');
  
  try {
    const stream = await r2.getDocument(key);
    if (!stream) {
      return c.json({ error: 'Document not found' }, 404);
    }
    
    return new Response(stream, {
      headers: {
        'Content-Type': 'application/octet-stream',
      },
    });
  } catch (error) {
    return c.json({ error: 'Failed to retrieve document', details: String(error) }, 500);
  }
});
