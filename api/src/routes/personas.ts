import { Hono } from 'hono';
import type { Env } from '../index';
import { D1Client } from '../lib/d1';
import { CLIBridgeClient } from '../lib/clibridge';
import { generateNextVersion, generateSkillFromPersona, validateSkillName } from '../lib/skill-generator';

export const personaRoutes = new Hono<{ Bindings: Env }>();

// Get all personas
personaRoutes.get('/', async (c) => {
  const db = new D1Client(c.env.DB);
  const personas = await db.getPersonas();
  return c.json(personas);
});

// Get single persona
personaRoutes.get('/:id', async (c) => {
  const db = new D1Client(c.env.DB);
  const persona = await db.getPersona(c.req.param('id'));
  if (!persona) {
    return c.json({ error: 'Persona not found' }, 404);
  }
  return c.json(persona);
});

// Create persona
personaRoutes.post('/', async (c) => {
  const body = await c.req.json();
  const { profile_json } = body;
  
  if (!profile_json || !profile_json.id) {
    return c.json({ error: 'Profile JSON with id is required' }, 400);
  }
  
  const db = new D1Client(c.env.DB);
  
  // Generate skill
  const skill = generateSkillFromPersona(profile_json);
  
  const persona = {
    id: profile_json.id,
    name: profile_json.name,
    role: profile_json.role,
    profile_json: JSON.stringify(profile_json),
    version: '1.0.0',
    skill_name: skill.skillName,
    skill_path: `roundtable/${skill.skillName}`,
    is_system: false,
    status: 'draft' as const,
  };
  
  await db.createPersona(persona);
  return c.json(persona, 201);
});

// Update persona
personaRoutes.put('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  const { profile_json } = body;
  
  const db = new D1Client(c.env.DB);
  const existing = await db.getPersona(id);
  if (!existing) {
    return c.json({ error: 'Persona not found' }, 404);
  }
  
  if (profile_json) {
    const updates: any = { profile_json: JSON.stringify(profile_json) };
    
    if (profile_json.name) updates.name = profile_json.name;
    if (profile_json.role) updates.role = profile_json.role;

    // Editing a persona creates a new skill version. Mark as draft until re-deployed.
    const versionMatch = /^(\d+)\.(\d+)\.(\d+)$/.exec((existing.version || '').trim());
    const baseVersion = versionMatch ? `${versionMatch[1]}.${versionMatch[2]}.${versionMatch[3]}` : '1.0.0';
    const nextVersion = generateNextVersion(baseVersion);
    const skill = generateSkillFromPersona(profile_json, nextVersion);

    updates.version = nextVersion;
    updates.skill_name = skill.skillName;
    updates.skill_path = `roundtable/${skill.skillName}`;
    updates.status = 'draft';
    updates.deployed_at = null;
    
    await db.updatePersona(id, updates);
  }
  
  const updated = await db.getPersona(id);
  return c.json(updated);
});

// Delete persona
personaRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const db = new D1Client(c.env.DB);
  
  const existing = await db.getPersona(id);
  if (!existing) {
    return c.json({ error: 'Persona not found' }, 404);
  }
  
  await db.deletePersona(id);
  return c.json({ message: 'Persona deleted' });
});

// Deploy persona to CLIBridge
personaRoutes.post('/:id/deploy', async (c) => {
  const id = c.req.param('id');
  const db = new D1Client(c.env.DB);
  
  const persona = await db.getPersona(id);
  if (!persona) {
    return c.json({ error: 'Persona not found' }, 404);
  }
  
  try {
    const profile = JSON.parse(persona.profile_json);
    const skill = generateSkillFromPersona(profile, persona.version);
    
    // Validate skill name
    if (!validateSkillName(skill.skillName)) {
      return c.json({ error: 'Invalid skill name generated' }, 500);
    }
    
    // Upload to CLIBridge
    const clibridge = new CLIBridgeClient(c.env);
    await clibridge.uploadSkill({
      skillName: skill.skillName,
      manifest: skill.manifest,
      template: skill.template,
    });
    
    // Update status
    await db.updatePersona(id, {
      status: 'deployed',
      deployed_at: new Date().toISOString(),
      skill_name: skill.skillName,
      skill_path: `roundtable/${skill.skillName}`,
    });
    
    return c.json({
      message: 'Persona deployed successfully',
      skill_name: skill.skillName,
    });
  } catch (error) {
    await db.updatePersona(id, {
      status: 'failed',
    });
    return c.json({ error: 'Deployment failed', details: String(error) }, 500);
  }
});
