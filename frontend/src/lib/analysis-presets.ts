export type ModelPreset = {
  id: string;
  label: string;
  provider: string;
  model: string;
  disabled?: boolean;
};

export const DEFAULT_ANALYSIS_PROVIDER = 'claude';
export const DEFAULT_ANALYSIS_MODEL = 'sonnet';

function coerceLegacyPreset(provider: string, model: string): { provider: string; model: string } {
  const p = (provider || '').trim().toLowerCase();
  const m = (model || '').trim();
  const mLower = m.toLowerCase();

  // If a caller mistakenly passes an OpenCode model alias as the provider, normalize it.
  const opencodeAliases = new Set(['kimi-2.5', 'deepseek-3.1', 'minimax-2.1', 'deepseek-r1', 'nemotron']);
  if (opencodeAliases.has(p)) {
    return { provider: 'opencode', model: p };
  }

  // Legacy (incorrect) presets used these model aliases as providers.
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

  return { provider: p, model: mLower };
}

export const MODEL_PRESETS: ModelPreset[] = [
  { id: 'claude-sonnet', label: 'Claude (Sonnet)', provider: 'claude', model: 'sonnet' },
  // These models are routed via CLIBridge's "opencode" provider (see CLIBridge internal/provider/opencode.go).
  { id: 'opencode-kimi-2.5', label: 'OpenCode (Kimi 2.5)', provider: 'opencode', model: 'kimi-2.5' },
  { id: 'opencode-deepseek-3.1', label: 'OpenCode (DeepSeek 3.1)', provider: 'opencode', model: 'deepseek-3.1' },
  { id: 'opencode-deepseek-r1', label: 'OpenCode (DeepSeek R1)', provider: 'opencode', model: 'deepseek-r1' },
  { id: 'opencode-minimax-2.1', label: 'OpenCode (MiniMax 2.1)', provider: 'opencode', model: 'minimax-2.1' },
  { id: 'opencode-nemotron', label: 'OpenCode (Nemotron)', provider: 'opencode', model: 'nemotron' },

  // Other CLIBridge providers may be available depending on server configuration.
  { id: 'codex', label: 'Codex', provider: 'codex', model: 'default' },
  { id: 'gemini', label: 'Gemini', provider: 'gemini', model: 'default' },
  { id: 'custom', label: 'Custom', provider: '', model: '' },
];

export function inferPresetId(provider: string, model: string): string {
  const coerced = coerceLegacyPreset(provider, model);
  const normalizedProvider = coerced.provider;
  const normalizedModel = coerced.model;
  const match = MODEL_PRESETS.find(
    p => p.provider.toLowerCase() === normalizedProvider && p.model.toLowerCase() === normalizedModel
  );
  return match?.id || 'custom';
}
