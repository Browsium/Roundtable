import { Hono } from 'hono';
import type { Env } from '../index';
import { D1Client } from '../lib/d1';
import { R2Client } from '../lib/r2';
import { generateR2Key, getFileExtension } from '../lib/document-processor';
import { validateAnalysisBackend } from '../lib/analysis-backend';

export const sessionRoutes = new Hono<{ Bindings: Env }>();

const getViewerEmail = (c: any) => {
  return c.req.header('CF-Access-Authenticated-User-Email') || 'anonymous';
};

const isTruthy = (v: string | undefined) => {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
};

const isFalsy = (v: string | undefined) => {
  if (!v) return false;
  const s = v.trim().toLowerCase();
  return s === '0' || s === 'false' || s === 'no' || s === 'off';
};

// Get all sessions for user
sessionRoutes.get('/', async (c) => {
  const userEmail = getViewerEmail(c);
  const includeSharedParam = (c.req.query('include_shared') as string | undefined);
  const includeShared = includeSharedParam === undefined ? true : !isFalsy(includeSharedParam) || isTruthy(includeSharedParam);
  const db = new D1Client(c.env.DB);
  const sessions = await db.getSessions(userEmail, includeShared);

  // Hide ownership details from the client, but include an access hint.
  const response = sessions.map((s) => {
    const { user_email, ...rest } = s as any;
    const isOwner = user_email === userEmail;
    return {
      ...rest,
      is_owner: isOwner,
      is_shared: !isOwner,
    };
  });

  return c.json(response);
});

// Get single session
sessionRoutes.get('/:id', async (c) => {
  const db = new D1Client(c.env.DB);
  const sessionId = c.req.param('id');
  const viewerEmail = getViewerEmail(c);
  const session = await db.getSession(sessionId);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const isOwner = session.user_email === viewerEmail;
  const hasAccess = isOwner || await db.isSessionSharedWith(session.id, viewerEmail);
  if (!hasAccess) {
    return c.json({ error: 'Access denied' }, 403);
  }
  
  // Get analyses
  const analyses = await db.getAnalyses(session.id);

  const shareWithEmails = isOwner ? await db.getSessionShareEmails(session.id) : undefined;
  
  return c.json({
    ...(() => {
      const { user_email, ...rest } = session as any;
      return {
        ...rest,
        is_owner: isOwner,
        is_shared: !isOwner,
      };
    })(),
    analyses,
    ...(shareWithEmails ? { share_with_emails: shareWithEmails } : {}),
  });
});

// Create session (metadata only, file uploaded separately)
sessionRoutes.post('/', async (c) => {
  const body = await c.req.json();
  const { file_name, file_size_bytes, file_extension, selected_persona_ids } = body;
  const analysis_provider = typeof body?.analysis_provider === 'string' ? body.analysis_provider : undefined;
  const analysis_model = typeof body?.analysis_model === 'string' ? body.analysis_model : undefined;
  const workflow = typeof body?.workflow === 'string' ? body.workflow.trim() : '';
  const analysis_config_json = body?.analysis_config_json;
  
  if (!file_name || !selected_persona_ids) {
    return c.json({ error: 'file_name and selected_persona_ids are required' }, 400);
  }

  const hasProvider = analysis_provider !== undefined;
  const hasModel = analysis_model !== undefined;
  if (hasProvider !== hasModel) {
    return c.json({ error: 'analysis_provider and analysis_model must be provided together' }, 400);
  }
  const providerTrimmed = hasProvider ? (analysis_provider || '').trim() : undefined;
  const modelTrimmed = hasModel ? (analysis_model || '').trim() : undefined;
  if (hasProvider && !providerTrimmed) {
    return c.json({ error: 'analysis_provider cannot be empty' }, 400);
  }
  if (hasModel && !modelTrimmed) {
    return c.json({ error: 'analysis_model cannot be empty' }, 400);
  }

  let providerFinal = providerTrimmed;
  let modelFinal = modelTrimmed;
  if (hasProvider && hasModel && providerTrimmed && modelTrimmed) {
    const validation = validateAnalysisBackend(c.env, providerTrimmed, modelTrimmed);
    if (!validation.ok) {
      return c.json({ error: validation.error }, 400);
    }
    providerFinal = validation.backend.provider;
    modelFinal = validation.backend.model;
  }

  let workflowFinal: string | undefined = undefined;
  if (workflow) {
    const normalized = workflow.trim().toLowerCase();
    const allowed = new Set(['roundtable_council', 'role_variant_discussion', 'roundtable_standard']);
    if (!allowed.has(normalized)) {
      return c.json({ error: `Invalid workflow '${workflow}'. Allowed: ${Array.from(allowed).join(', ')}` }, 400);
    }
    workflowFinal = normalized;
  }

  let configFinal: string | undefined = undefined;
  if (analysis_config_json !== undefined) {
    if (analysis_config_json === null) {
      configFinal = undefined;
    } else if (typeof analysis_config_json === 'string') {
      // Accept pre-stringified JSON.
      const trimmed = analysis_config_json.trim();
      if (trimmed) {
        try {
          JSON.parse(trimmed);
        } catch {
          return c.json({ error: 'analysis_config_json must be valid JSON' }, 400);
        }
        configFinal = trimmed;
      }
    } else if (typeof analysis_config_json === 'object') {
      configFinal = JSON.stringify(analysis_config_json);
    } else {
      return c.json({ error: 'analysis_config_json must be an object or JSON string' }, 400);
    }
  }
  
  const userEmail = getViewerEmail(c);
  const sessionId = crypto.randomUUID();
  const r2Key = generateR2Key(sessionId, file_name);
  
  const db = new D1Client(c.env.DB);

  // For broad roundtables (standard/council), prevent selecting multiple personas with the same role.
  // For role-variant discussion, duplicates are expected.
  const effectiveWorkflow = workflowFinal || 'roundtable_standard';
  if (effectiveWorkflow !== 'role_variant_discussion') {
    const roles: string[] = [];
    for (const personaId of selected_persona_ids) {
      const p = await db.getPersona(String(personaId));
      if (p?.role) roles.push(p.role.trim().toLowerCase());
    }
    const seen = new Set<string>();
    const dups = new Set<string>();
    for (const r of roles) {
      if (!r) continue;
      if (seen.has(r)) dups.add(r);
      seen.add(r);
    }
    if (dups.size > 0) {
      return c.json({ error: `Only one persona per role is allowed in broad roundtable runs. Duplicate roles: ${Array.from(dups).join(', ')}` }, 400);
    }
  }

  await db.createSession({
    id: sessionId,
    user_email: userEmail,
    file_name,
    file_r2_key: r2Key,
    file_size_bytes: file_size_bytes || 0,
    file_extension: file_extension || getFileExtension(file_name),
    selected_persona_ids: JSON.stringify(selected_persona_ids),
    status: 'uploaded',
    ...(hasProvider && hasModel ? {
      analysis_provider: providerFinal,
      analysis_model: modelFinal,
    } : {}),
    ...(workflowFinal || configFinal ? {
      ...(workflowFinal ? { workflow: workflowFinal } : {}),
      ...(configFinal ? { analysis_config_json: configFinal } : {}),
    } : {}),
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
  if (!session) {
    return c.json({ error: 'Failed to create session' }, 500);
  }

  const { user_email, ...rest } = session as any;
  return c.json({
    ...rest,
    is_owner: true,
    is_shared: false,
  }, 201);
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

  const viewerEmail = getViewerEmail(c);
  if (existing.user_email !== viewerEmail) {
    return c.json({ error: 'Only the owner can update sessions' }, 403);
  }
  
  const updates: any = {};
  if (body.status) updates.status = body.status;
  if (body.selected_persona_ids) updates.selected_persona_ids = JSON.stringify(body.selected_persona_ids);
  
  await db.updateSession(id, updates);
  const updated = await db.getSession(id);
  if (!updated) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const { user_email, ...rest } = updated as any;
  return c.json({
    ...rest,
    is_owner: true,
    is_shared: false,
  });
});

// Share session with specific emails (owner-only)
sessionRoutes.post('/:id/share', async (c) => {
  const id = c.req.param('id');
  const viewerEmail = getViewerEmail(c);
  const db = new D1Client(c.env.DB);

  const session = await db.getSession(id);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  if (session.user_email !== viewerEmail) {
    return c.json({ error: 'Only the owner can share sessions' }, 403);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const emails = Array.isArray(body?.emails) ? body.emails : null;
  if (!emails) {
    return c.json({ error: 'emails is required' }, 400);
  }

  const normalized = Array.from(new Set(
    (emails as any[])
      .filter((e) => typeof e === 'string')
      .map((e) => (e as string).trim().toLowerCase())
      .filter((e) => e.length > 0)
  )) as string[];

  if (normalized.length === 0) {
    return c.json({ error: 'No valid emails provided' }, 400);
  }

  await db.addSessionShares(id, normalized);
  const sharedWith = await db.getSessionShareEmails(id);

  return c.json({ message: 'Session shared successfully', shared_with: sharedWith });
});

// Delete session
sessionRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const db = new D1Client(c.env.DB);

  const session = await db.getSession(id);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const viewerEmail = getViewerEmail(c);
  if (session.user_email !== viewerEmail) {
    return c.json({ error: 'Only the owner can delete sessions' }, 403);
  }

  // Delete from R2
  const r2 = new R2Client(c.env.R2, '2b2861c0bba0855e5f6ed79a9451e6b2');
  await r2.deleteDocument(session.file_r2_key);

  // Delete from D1
  await db.deleteSession(id);

  return c.json({ message: 'Session deleted' });
});

// Get analysis artifacts for a session
sessionRoutes.get('/:id/artifacts', async (c) => {
  const sessionId = c.req.param('id');
  const viewerEmail = getViewerEmail(c);
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

  const personaId = (c.req.query('persona_id') as string | undefined) || undefined;
  const artifactType = (c.req.query('artifact_type') as string | undefined) || undefined;
  const artifacts = await db.getAnalysisArtifacts(sessionId, {
    persona_id: personaId,
    artifact_type: artifactType,
  });

  return c.json({ session_id: sessionId, artifacts });
});

// Trigger analysis manually (fallback for when WebSocket doesn't work)
sessionRoutes.post('/:id/analyze', async (c) => {
  const id = c.req.param('id');
  const db = new D1Client(c.env.DB);

  const session = await db.getSession(id);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const viewerEmail = getViewerEmail(c);
  if (session.user_email !== viewerEmail) {
    return c.json({ error: 'Only the owner can start analysis' }, 403);
  }

  if (session.status && session.status !== 'uploaded') {
    return c.json({ error: `Analysis already ${session.status}` }, 400);
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

// Retry a failed persona analysis (owner-only).
sessionRoutes.post('/:id/retry', async (c) => {
  const id = c.req.param('id');
  const db = new D1Client(c.env.DB);

  const session = await db.getSession(id);
  if (!session) {
    return c.json({ error: 'Session not found' }, 404);
  }

  const viewerEmail = getViewerEmail(c);
  if (session.user_email !== viewerEmail) {
    return c.json({ error: 'Only the owner can retry analyses' }, 403);
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const personaId = typeof body?.persona_id === 'string' ? body.persona_id.trim() : '';
  if (!personaId) {
    return c.json({ error: 'persona_id is required' }, 400);
  }

  if (session.status === 'uploaded') {
    return c.json({ error: 'Session has not started analysis yet' }, 400);
  }

  if (session.status === 'analyzing') {
    return c.json({ error: 'Session is currently analyzing; wait for it to finish' }, 400);
  }

  const analyses = await db.getAnalyses(id);
  const analysis = analyses.find((a) => a.persona_id === personaId);
  if (!analysis) {
    return c.json({ error: 'Analysis not found for persona_id' }, 404);
  }

  // Trigger the durable object to retry this persona.
  const analyzerId = c.env.SESSION_ANALYZER.idFromName(id);
  const analyzer = c.env.SESSION_ANALYZER.get(analyzerId);

  await analyzer.fetch(new Request('http://internal/retry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: id, persona_id: personaId }),
  }));

  return c.json({ message: 'Retry started', session_id: id, persona_id: personaId });
});
