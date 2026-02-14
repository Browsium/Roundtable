export type ModelPreset = {
  id: string;
  label: string;
  provider: string;
  model: string;
};

export const DEFAULT_ANALYSIS_PROVIDER = 'claude';
export const DEFAULT_ANALYSIS_MODEL = 'sonnet';

export const MODEL_PRESETS: ModelPreset[] = [
  { id: 'claude-sonnet', label: 'Claude (Sonnet)', provider: 'claude', model: 'sonnet' },
  { id: 'codex', label: 'Codex (default)', provider: 'codex', model: 'default' },
  { id: 'gemini', label: 'Gemini (default)', provider: 'gemini', model: 'default' },
  { id: 'kimi-2.5', label: 'Kimi 2.5', provider: 'kimi', model: '2.5' },
  { id: 'deepseek-3.1', label: 'DeepSeek 3.1', provider: 'deepseek', model: '3.1' },
  { id: 'minimax-2.1', label: 'MiniMax 2.1', provider: 'minimax', model: '2.1' },
  { id: 'deepseek-r1', label: 'DeepSeek R1', provider: 'deepseek', model: 'r1' },
  { id: 'nemotron', label: 'Nemotron (default)', provider: 'nemotron', model: 'default' },
  { id: 'custom', label: 'Custom', provider: '', model: '' },
];

export function inferPresetId(provider: string, model: string): string {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim().toLowerCase();
  const match = MODEL_PRESETS.find(
    p => p.provider.toLowerCase() === normalizedProvider && p.model.toLowerCase() === normalizedModel
  );
  return match?.id || 'custom';
}

