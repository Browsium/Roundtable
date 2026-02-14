import type { Env } from '../index';

export type AnalysisBackend = {
  provider: string;
  model: string;
};

const DEFAULT_SUPPORTED_PROVIDERS = ['claude'];

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
  const providerNormalized = providerTrimmed.toLowerCase();

  if (!supported.includes(providerNormalized)) {
    return {
      ok: false,
      error: `Unsupported analysis_provider '${providerNormalized}'. Supported providers: ${supported.join(', ')}`,
    };
  }

  return { ok: true, backend: { provider: providerNormalized, model: modelTrimmed } };
}

