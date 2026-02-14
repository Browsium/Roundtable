import { Hono } from 'hono';
import type { Env } from '../index';
import { D1Client } from '../lib/d1';
import { CLIBridgeClient } from '../lib/clibridge';
import { validateAnalysisBackend } from '../lib/analysis-backend';
import { generateSkillFromPersona } from '../lib/skill-generator';

export const personaGroupRoutes = new Hono<{ Bindings: Env }>();

const getViewerEmail = (c: any) => {
  return c.req.header('CF-Access-Authenticated-User-Email') || 'anonymous';
};

function safeJsonParse(text: string): any | null {
  const trimmed = (text || '').trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    // Try fenced code block extraction.
    const match = trimmed.match(/```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/);
    if (match) {
      try {
        return JSON.parse(match[1]);
      } catch {
        return null;
      }
    }
  }

  return null;
}

function slugify(s: string): string {
  return (s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48) || 'variant';
}

function buildVariantPrompt(base: any, roleKey: string, groupId: string, count: number, seedConstraints: any): string {
  const constraints = seedConstraints && typeof seedConstraints === 'object'
    ? JSON.stringify(seedConstraints, null, 2)
    : '';

  // Keep this prompt explicit; variant JSON must match what Roundtable already expects.
  return `You are generating persona variants for a focus group.

BASE PERSONA (SOURCE OF TRUTH FOR ROLE):
${JSON.stringify(base, null, 2)}

ROLE KEY: ${roleKey}
GROUP ID: ${groupId}
COUNT: ${count}
${constraints ? `SEED CONSTRAINTS:\n${constraints}\n` : ''}

TASK:
Generate ${count} DISTINCT persona profiles representing the SAME job role as the base persona, but with different background, agenda, biases, and constraints.

REQUIREMENTS:
- Each variant must have a unique id.
- Use id pattern: "${roleKey}_${groupId}_<variant_slug>" where <variant_slug> is short, lowercase, underscores.
- Keep "role" identical to the base persona role.
- Keep the same JSON shape as the base persona (id, name, role, background, professional_priorities, marketing_pet_peeves, evaluation_rubric, convince_me_criteria, voice_and_tone, typical_objections, industry_influences, budget_authority).
- Add two extra fields to each variant:
  - "agenda_summary": string (1-2 sentences)
  - "biases_and_constraints": string (1-2 sentences)
  - "variant_label": string (short slug, e.g. "board_risk_first")
- Ensure variants disagree on at least 2 priorities and 2 objections.

OUTPUT:
Return ONLY valid JSON (no markdown, no commentary). Output a JSON array of persona objects.`;
}

async function resolveGeneratorBackend(db: D1Client, env: Env, overrides?: { provider?: string; model?: string }): Promise<{ provider: string; model: string }> {
  const DEFAULT_ANALYSIS_PROVIDER = 'claude';
  const DEFAULT_ANALYSIS_MODEL = 'sonnet';

  const provider = (overrides?.provider || (await db.getSettingValue('analysis_provider')) || DEFAULT_ANALYSIS_PROVIDER).trim();
  const model = (overrides?.model || (await db.getSettingValue('analysis_model')) || DEFAULT_ANALYSIS_MODEL).trim();

  const validation = validateAnalysisBackend(env, provider, model);
  if (!validation.ok) {
    throw new Error(validation.error);
  }
  return validation.backend;
}

// List persona groups for the current user
personaGroupRoutes.get('/', async (c) => {
  const viewerEmail = getViewerEmail(c);
  const db = new D1Client(c.env.DB);
  const groups = await db.listPersonaGroups(viewerEmail);
  return c.json(groups);
});

// Create a persona group
personaGroupRoutes.post('/', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const roleKey = typeof body?.role_key === 'string' ? body.role_key.trim().toLowerCase() : '';
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  const description = typeof body?.description === 'string' ? body.description.trim() : '';
  const basePersonaId = typeof body?.base_persona_id === 'string' ? body.base_persona_id.trim() : '';

  if (!roleKey) return c.json({ error: 'role_key is required' }, 400);
  if (!name) return c.json({ error: 'name is required' }, 400);

  const viewerEmail = getViewerEmail(c);
  const db = new D1Client(c.env.DB);

  if (basePersonaId) {
    const p = await db.getPersona(basePersonaId);
    if (!p) return c.json({ error: 'base_persona_id not found' }, 404);
  }

  const id = crypto.randomUUID();
  await db.createPersonaGroup({
    id,
    owner_email: viewerEmail,
    group_type: 'role_variants',
    role_key: roleKey,
    name,
    ...(description ? { description } : {}),
    ...(basePersonaId ? { base_persona_id: basePersonaId } : {}),
  } as any);

  const group = await db.getPersonaGroup(id);
  return c.json(group, 201);
});

// Get a persona group (includes members)
personaGroupRoutes.get('/:id', async (c) => {
  const id = c.req.param('id');
  const viewerEmail = getViewerEmail(c);
  const db = new D1Client(c.env.DB);

  const group = await db.getPersonaGroup(id);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  if (group.owner_email !== viewerEmail) return c.json({ error: 'Access denied' }, 403);

  const members = await db.getPersonaGroupMembers(id);
  const personas = [];
  for (const m of members) {
    const p = await db.getPersona(m.persona_id);
    if (p) personas.push(p);
  }

  return c.json({ group, members: personas });
});

// Add members to a group
personaGroupRoutes.post('/:id/members', async (c) => {
  const id = c.req.param('id');
  const viewerEmail = getViewerEmail(c);
  const db = new D1Client(c.env.DB);

  const group = await db.getPersonaGroup(id);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  if (group.owner_email !== viewerEmail) return c.json({ error: 'Access denied' }, 403);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const personaIds = Array.isArray(body?.persona_ids)
    ? body.persona_ids.filter((x: any) => typeof x === 'string').map((x: string) => x.trim()).filter(Boolean)
    : [];

  if (personaIds.length === 0) return c.json({ error: 'persona_ids is required' }, 400);

  // Validate personas exist
  for (const pid of personaIds) {
    const p = await db.getPersona(pid);
    if (!p) return c.json({ error: `Persona not found: ${pid}` }, 404);
  }

  await db.addPersonaGroupMembers(id, personaIds);
  const members = await db.getPersonaGroupMembers(id);
  return c.json({ group_id: id, members });
});

// Generate and save persona variants, attach them to a group
personaGroupRoutes.post('/:id/generate-variants', async (c) => {
  const groupId = c.req.param('id');
  const viewerEmail = getViewerEmail(c);
  const db = new D1Client(c.env.DB);

  const group = await db.getPersonaGroup(groupId);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  if (group.owner_email !== viewerEmail) return c.json({ error: 'Access denied' }, 403);

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const count = typeof body?.count === 'number' && Number.isFinite(body.count) ? Math.floor(body.count) : 0;
  if (count <= 0 || count > 8) {
    return c.json({ error: 'count must be between 1 and 8' }, 400);
  }

  const basePersonaId = typeof body?.base_persona_id === 'string'
    ? body.base_persona_id.trim()
    : (group.base_persona_id || '').trim();
  if (!basePersonaId) return c.json({ error: 'base_persona_id is required (either on group or in request)' }, 400);

  const basePersona = await db.getPersona(basePersonaId);
  if (!basePersona) return c.json({ error: 'base_persona_id not found' }, 404);

  let baseProfile: any;
  try {
    baseProfile = JSON.parse(basePersona.profile_json);
  } catch {
    return c.json({ error: 'base persona profile_json is invalid JSON' }, 500);
  }

  const generatorProvider = typeof body?.generator_provider === 'string' ? body.generator_provider.trim() : '';
  const generatorModel = typeof body?.generator_model === 'string' ? body.generator_model.trim() : '';
  const backend = await resolveGeneratorBackend(db, c.env, {
    provider: generatorProvider || undefined,
    model: generatorModel || undefined,
  });

  const seedConstraints = body?.seed_constraints;
  const systemPrompt = buildVariantPrompt(baseProfile, group.role_key, groupId, count, seedConstraints);

  const clibridge = new CLIBridgeClient(c.env);
  const resp = await clibridge.completeAnalysis({
    provider: backend.provider,
    model: backend.model,
    systemPrompt,
    messages: [{ role: 'user', content: 'Generate the variants now.' }],
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    return c.json({ error: `Variant generation failed: ${resp.status} ${resp.statusText}${errText ? ` - ${errText.slice(0, 500)}` : ''}` }, 500);
  }

  const raw = await resp.text();
  const parsed = safeJsonParse(raw);
  if (!Array.isArray(parsed)) {
    return c.json({ error: 'Variant generation did not return a JSON array', raw: raw.slice(0, 1000) }, 500);
  }

  const createdPersonas: any[] = [];
  const createdPersonaIds: string[] = [];

  for (const candidate of parsed) {
    if (!candidate || typeof candidate !== 'object') continue;
    const role = String(candidate.role || '').trim();
    if (!role || role !== String(baseProfile.role || '').trim()) {
      continue;
    }

    const variantLabel = slugify(String((candidate as any).variant_label || (candidate as any).agenda_summary || candidate.name || 'variant'));
    const expectedPrefix = `${group.role_key}_${groupId}_`;
    let id = String(candidate.id || '').trim();
    if (!id || !id.startsWith(expectedPrefix)) {
      id = `${expectedPrefix}${variantLabel}`;
    }
    candidate.id = id;

    if (!candidate.name || typeof candidate.name !== 'string') {
      candidate.name = `${baseProfile.name} (${variantLabel})`;
    }

    // Persist variant metadata in profile_json for now.
    (candidate as any).variant_label = variantLabel;
    (candidate as any).role_key = group.role_key;
    (candidate as any).variant_group_id = groupId;

    // Ensure required arrays exist to avoid downstream prompt crashes.
    for (const arrKey of ['professional_priorities', 'marketing_pet_peeves', 'typical_objections']) {
      if (!Array.isArray((candidate as any)[arrKey])) (candidate as any)[arrKey] = [];
    }
    if (!(candidate as any).evaluation_rubric || typeof (candidate as any).evaluation_rubric !== 'object') {
      (candidate as any).evaluation_rubric = {};
    }

    // Create persona (skip if already exists).
    const existing = await db.getPersona(id);
    if (existing) {
      // Still attach to group.
      await db.addPersonaGroupMembers(groupId, [id]);
      createdPersonaIds.push(id);
      continue;
    }

    const skill = generateSkillFromPersona(candidate);
    const personaRow = {
      id: candidate.id,
      name: candidate.name,
      role: candidate.role,
      profile_json: JSON.stringify(candidate),
      version: '1.0.0',
      skill_name: skill.skillName,
      skill_path: `roundtable/${skill.skillName}`,
      is_system: false,
      status: 'draft' as const,
    };

    await db.createPersona(personaRow as any);
    await db.addPersonaGroupMembers(groupId, [id]);
    createdPersonas.push(personaRow);
    createdPersonaIds.push(id);
  }

  return c.json({
    group_id: groupId,
    generator_backend: backend,
    created_persona_ids: createdPersonaIds,
    created_personas: createdPersonas,
  });
});

