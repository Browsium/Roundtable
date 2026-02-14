export type ModelPreset = {
  id: string;
  label: string;
  provider: string;
  model: string;
  disabled?: boolean;
};

export const DEFAULT_ANALYSIS_PROVIDER = 'claude';
export const DEFAULT_ANALYSIS_MODEL = 'sonnet';

export const MODEL_PRESETS: ModelPreset[] = [
  { id: 'claude-sonnet', label: 'Claude (Sonnet)', provider: 'claude', model: 'sonnet' },
  // Presets below are disabled until CLIBridge supports them end-to-end.
  { id: 'codex', label: 'Codex (Coming soon)', provider: 'codex', model: 'default', disabled: true },
  { id: 'gemini', label: 'Gemini (Coming soon)', provider: 'gemini', model: 'default', disabled: true },
  { id: 'kimi-2.5', label: 'Kimi 2.5 (Coming soon)', provider: 'kimi', model: '2.5', disabled: true },
  { id: 'deepseek-3.1', label: 'DeepSeek 3.1 (Coming soon)', provider: 'deepseek', model: '3.1', disabled: true },
  { id: 'minimax-2.1', label: 'MiniMax 2.1 (Coming soon)', provider: 'minimax', model: '2.1', disabled: true },
  { id: 'deepseek-r1', label: 'DeepSeek R1 (Coming soon)', provider: 'deepseek', model: 'r1', disabled: true },
  { id: 'nemotron', label: 'Nemotron (Coming soon)', provider: 'nemotron', model: 'default', disabled: true },
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
