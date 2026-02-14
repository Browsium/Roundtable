import { Hono } from 'hono';
import type { Env } from '../index';
import { D1Client } from '../lib/d1';
import { validateAnalysisBackend } from '../lib/analysis-backend';

export const settingsRoutes = new Hono<{ Bindings: Env }>();

const DEFAULT_ANALYSIS_PROVIDER = 'claude';
const DEFAULT_ANALYSIS_MODEL = 'sonnet';

function toSettingsMap(rows: Array<{ key: string; value: string }>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const r of rows) {
    map[r.key] = r.value;
  }
  return map;
}

settingsRoutes.get('/', async (c) => {
  const db = new D1Client(c.env.DB);
  const rows = await db.getSettings();
  const settings = toSettingsMap(rows);

  // Always return defaults for analysis settings so the UI has a stable shape.
  if (!settings.analysis_provider?.trim()) settings.analysis_provider = DEFAULT_ANALYSIS_PROVIDER;
  if (!settings.analysis_model?.trim()) settings.analysis_model = DEFAULT_ANALYSIS_MODEL;

  return c.json(settings);
});

settingsRoutes.put('/', async (c) => {
  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!body || typeof body !== 'object') {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  const allowedKeys = new Set([
    'analysis_provider',
    'analysis_model',
    'share_expiry_days',
  ]);

  const updates: Record<string, string> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!allowedKeys.has(key)) continue;
    if (typeof value !== 'string') {
      return c.json({ error: `Setting '${key}' must be a string` }, 400);
    }
    updates[key] = value.trim();
  }

  const updatingProvider = Object.prototype.hasOwnProperty.call(updates, 'analysis_provider');
  const updatingModel = Object.prototype.hasOwnProperty.call(updates, 'analysis_model');
  if (updatingProvider !== updatingModel) {
    return c.json({ error: 'analysis_provider and analysis_model must be updated together' }, 400);
  }

  if (typeof updates.analysis_provider === 'string' && updates.analysis_provider.length === 0) {
    return c.json({ error: 'analysis_provider cannot be empty' }, 400);
  }

  if (typeof updates.analysis_model === 'string' && updates.analysis_model.length === 0) {
    return c.json({ error: 'analysis_model cannot be empty' }, 400);
  }

  if (updatingProvider && updatingModel) {
    const validation = validateAnalysisBackend(c.env, updates.analysis_provider, updates.analysis_model);
    if (!validation.ok) {
      return c.json({ error: validation.error }, 400);
    }
    // Normalize to a stable form (e.g., provider lowercased).
    updates.analysis_provider = validation.backend.provider;
    updates.analysis_model = validation.backend.model;
  }

  if (Object.keys(updates).length === 0) {
    return c.json({ error: 'No valid settings provided' }, 400);
  }

  const db = new D1Client(c.env.DB);
  await db.upsertSettings(updates);

  const rows = await db.getSettings();
  const settings = toSettingsMap(rows);
  if (!settings.analysis_provider?.trim()) settings.analysis_provider = DEFAULT_ANALYSIS_PROVIDER;
  if (!settings.analysis_model?.trim()) settings.analysis_model = DEFAULT_ANALYSIS_MODEL;

  return c.json(settings);
});
