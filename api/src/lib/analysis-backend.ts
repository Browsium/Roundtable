import type { Env } from '../index';

export type AnalysisBackend = {
  provider: string;
  model: string;
};

// Defaults align with the CLIBridge providers exposed in `docs/api.md`.
// This is a policy allowlist (what Roundtable will accept), not a runtime
// availability check (whether CLIBridge can actually run that provider).
const DEFAULT_SUPPORTED_PROVIDERS = ['claude', 'opencode', 'codex'];

const OPENCODE_MODEL_ALIASES = new Set([
  'kimi-2.5',
  'deepseek-3.1',
  'minimax-2.1',
  'deepseek-r1',
  'nemotron',
]);

function coerceLegacyBackend(provider: string, model: string): AnalysisBackend {
  const p = (provider || '').trim().toLowerCase();
  const m = (model || '').trim();
  const mLower = m.toLowerCase();

  // Some callers mistakenly pass an OpenCode model alias as the provider.
  if (OPENCODE_MODEL_ALIASES.has(p)) {
    return { provider: 'opencode', model: p };
  }

  // Roundtable v1.2.0 presets previously (incorrectly) used these aliases as providers.
  // Convert them into the canonical "opencode" provider + model alias form.
  if (p === 'deepseek') {
    if (mLower === 'r1' || mLower === 'deepseek-r1') return { provider: 'opencode', model: 'deepseek-r1' };
    if (mLower === '3.1' || mLower === 'deepseek-3.1') return { provider: 'opencode', model: 'deepseek-3.1' };
  }

  if (p === 'kimi') {
    if (mLower === '2.5' || mLower === 'kimi-2.5') return { provider: 'opencode', model: 'kimi-2.5' };
  }

  if (p === 'minimax') {
    if (mLower === '2.1' || mLower === 'minimax-2.1') return { provider: 'opencode', model: 'minimax-2.1' };
  }

  if (p === 'nemotron') {
    return { provider: 'opencode', model: 'nemotron' };
  }

  return { provider: p, model: m };
}

function normalizeCsv(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function getSupportedProviders(env: Env): string[] {
  const raw = typeof (env as any).SUPPORTED_ANALYSIS_PROVIDERS === 'string'
    ? String((env as any).SUPPORTED_ANALYSIS_PROVIDERS)
    : '';
  const parsed = raw.trim() ? normalizeCsv(raw) : [];
  const providers = parsed.length > 0 ? parsed : DEFAULT_SUPPORTED_PROVIDERS;
  return Array.from(new Set(providers));
}

export function validateAnalysisBackend(
  env: Env,
  provider: string,
  model: string
): { ok: true; backend: AnalysisBackend } | { ok: false; error: string } {
  const providerTrimmed = (provider || '').trim();
  const modelTrimmed = (model || '').trim();

  if (!providerTrimmed) {
    return { ok: false, error: 'analysis_provider cannot be empty' };
  }
  if (!modelTrimmed) {
    return { ok: false, error: 'analysis_model cannot be empty' };
  }

  const supported = getSupportedProviders(env);
  const coerced = coerceLegacyBackend(providerTrimmed, modelTrimmed);
  const providerNormalized = coerced.provider.toLowerCase();

  if (!supported.includes(providerNormalized)) {
    return {
      ok: false,
      error: `Unsupported analysis_provider '${providerNormalized}'. Supported providers: ${supported.join(', ')}`,
    };
  }

  return { ok: true, backend: { provider: providerNormalized, model: coerced.model } };
}
