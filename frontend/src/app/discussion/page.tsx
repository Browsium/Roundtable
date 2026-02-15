'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { AlertCircle, ArrowRight, FileText, Upload, Users } from 'lucide-react';
import { personaApi, personaGroupApi, r2Api, sessionApi, settingsApi, clibridgeApi } from '@/lib/api';
import type { Persona } from '@/lib/types';
import { useRouter } from 'next/navigation';
import {
  DEFAULT_ANALYSIS_MODEL,
  DEFAULT_ANALYSIS_PROVIDER,
  MODEL_PRESETS,
  inferPresetId,
} from '@/lib/analysis-presets';

type GroupSummary = {
  id: string;
  name: string;
  role_key: string;
  description?: string;
  base_persona_id?: string;
};

function extFromFilename(name: string): string {
  return name.split('.').pop()?.toLowerCase() || '';
}

function roleKeyFromPersonaId(id: string): string {
  const part = (id || '').split('_')[0] || '';
  return part.trim().toLowerCase();
}

export default function DiscussionPage() {
  const router = useRouter();

  const [step, setStep] = useState<'upload' | 'configure'>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const [personas, setPersonas] = useState<Persona[]>([]);
  const personasById = useMemo(() => Object.fromEntries(personas.map((p) => [p.id, p])), [personas]);

  const [groups, setGroups] = useState<GroupSummary[]>([]);
  const [groupMode, setGroupMode] = useState<'existing' | 'generate'>('generate');
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [basePersonaId, setBasePersonaId] = useState('');
  const [variantCount, setVariantCount] = useState(4);

  const [variantProvider, setVariantProvider] = useState(DEFAULT_ANALYSIS_PROVIDER);
  const [variantModel, setVariantModel] = useState(DEFAULT_ANALYSIS_MODEL);
  const [variantPreset, setVariantPreset] = useState('claude-sonnet');

  const [chairProvider, setChairProvider] = useState(DEFAULT_ANALYSIS_PROVIDER);
  const [chairModel, setChairModel] = useState(DEFAULT_ANALYSIS_MODEL);
  const [chairPreset, setChairPreset] = useState('claude-sonnet');
  const [providerAvailability, setProviderAvailability] = useState<Record<string, boolean> | null>(null);

  const loadPersonas = useCallback(async () => {
    try {
      const data = await personaApi.getAll();
      setPersonas(data);
      if (!basePersonaId && data.length > 0) {
        setBasePersonaId(data[0].id);
      }
    } catch (e) {
      console.error('Failed to load personas:', e);
    }
  }, [basePersonaId]);

  const loadGroups = useCallback(async () => {
    try {
      const data = await personaGroupApi.list();
      setGroups(data as any);
      if (!selectedGroupId && Array.isArray(data) && data.length > 0) {
        setSelectedGroupId(String((data[0] as any).id || ''));
      }
    } catch (e) {
      console.error('Failed to load persona groups:', e);
    }
  }, [selectedGroupId]);

  useEffect(() => {
    // Default analysis backend from settings.
    (async () => {
      try {
        const data = await settingsApi.getAll();
        const provider = (data.analysis_provider || DEFAULT_ANALYSIS_PROVIDER).trim();
        const model = (data.analysis_model || DEFAULT_ANALYSIS_MODEL).trim();
        setVariantProvider(provider);
        setVariantModel(model);
        setVariantPreset(inferPresetId(provider, model));
        setChairProvider(provider);
        setChairModel(model);
        setChairPreset(inferPresetId(provider, model));
      } catch {
        // Ignore; use defaults
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const data = await clibridgeApi.health();
        const map: Record<string, boolean> = {};
        for (const p of data.providers || []) {
          map[String(p.name || '').toLowerCase()] = !!p.available;
        }
        setProviderAvailability(map);
      } catch {
        setProviderAvailability(null);
      }
    })();
  }, []);

  const isPresetUnavailable = (provider: string): boolean => {
    const p = (provider || '').trim().toLowerCase();
    if (!p) return false;
    if (!providerAvailability) return false;
    return providerAvailability[p] === false;
  };

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      setFile(acceptedFiles[0]);
      setError(null);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
      'text/plain': ['.txt'],
      'text/markdown': ['.md'],
    },
    maxSize: 50 * 1024 * 1024,
    multiple: false,
  });

  const handleContinue = async () => {
    if (!file) {
      setError('Please upload a file first');
      return;
    }
    setStep('configure');
    await Promise.all([loadPersonas(), loadGroups()]);
  };

  const handlePresetChange = (id: string, kind: 'variant' | 'chair') => {
    const preset = MODEL_PRESETS.find((p) => p.id === id);
    if (!preset) return;
    if (kind === 'variant') {
      setVariantPreset(id);
      if (id !== 'custom') {
        setVariantProvider(preset.provider);
        setVariantModel(preset.model);
      }
    } else {
      setChairPreset(id);
      if (id !== 'custom') {
        setChairProvider(preset.provider);
        setChairModel(preset.model);
      }
    }
  };

  const handleStartDiscussion = async () => {
    if (!file) {
      setError('Please upload a file first');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const fileExtension = extFromFilename(file.name);

      let groupId = '';
      let variantPersonaIds: string[] = [];

      if (groupMode === 'existing') {
        if (!selectedGroupId) throw new Error('Select a persona group');
        const data = await personaGroupApi.get(selectedGroupId);
        groupId = String(data?.group?.id || selectedGroupId);
        const members = Array.isArray(data?.members) ? data.members : [];
        variantPersonaIds = members.map((p: any) => String(p?.id || '')).filter(Boolean);
      } else {
        if (!basePersonaId) throw new Error('Select a base persona');
        const basePersona = personasById[basePersonaId];
        if (!basePersona) throw new Error('Base persona not found');
        const roleKey = roleKeyFromPersonaId(basePersona.id) || 'role';

        const group = await personaGroupApi.create({
          role_key: roleKey,
          name: `${basePersona.name} (${roleKey}) variants`,
          base_persona_id: basePersona.id,
        });
        groupId = String(group?.id || '');
        if (!groupId) throw new Error('Failed to create persona group');

        const gen = await personaGroupApi.generateVariants(groupId, {
          count: Math.max(2, Math.min(8, variantCount)),
          base_persona_id: basePersona.id,
          generator_provider: variantProvider.trim(),
          generator_model: variantModel.trim(),
        });
        variantPersonaIds = Array.isArray(gen?.created_persona_ids) ? gen.created_persona_ids : [];
      }

      if (variantPersonaIds.length < 2) {
        throw new Error('Need at least 2 variants to run a discussion');
      }

      const analysisConfig = {
        discussion: {
          persona_group_id: groupId || null,
          variant_backend: { provider: variantProvider.trim(), model: variantModel.trim() },
          chair_backend: { provider: chairProvider.trim(), model: chairModel.trim() },
          critique_mode: 'all_against_all',
        },
      };

      const session = await sessionApi.create(
        file.name,
        file.size,
        fileExtension,
        variantPersonaIds,
        variantProvider.trim(),
        variantModel.trim(),
        'role_variant_discussion',
        analysisConfig
      );

      await r2Api.uploadFile(session.id, file);
      router.push(`/sessions/detail?id=${session.id}`);
    } catch (e: any) {
      setError(e?.message || 'Failed to start discussion');
      setLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-gray-900 mb-2">
          Single Viewpoint Discussion
        </h2>
        <p className="text-gray-600">
          Generate (or reuse) multiple variants of the same job role and run a cross-critique focus group with a chairman synthesis.
        </p>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700">
          <AlertCircle className="h-5 w-5" />
          {error}
        </div>
      )}

      {step === 'upload' && (
        <div className="space-y-6">
          <div
            {...getRootProps()}
            className={`border-2 border-dashed rounded-xl p-12 text-center transition-colors cursor-pointer
              ${isDragActive ? 'border-blue-500 bg-blue-50' : 'border-gray-300 hover:border-gray-400'}`}
          >
            <input {...getInputProps()} />
            <Upload className="mx-auto h-12 w-12 text-gray-400 mb-4" />
            {file ? (
              <div className="text-center">
                <FileText className="mx-auto h-8 w-8 text-green-500 mb-2" />
                <p className="text-lg font-medium text-gray-900">{file.name}</p>
                <p className="text-sm text-gray-500">
                  {(file.size / 1024 / 1024).toFixed(2)} MB
                </p>
              </div>
            ) : (
              <>
                <p className="text-lg font-medium text-gray-900 mb-2">
                  {isDragActive ? 'Drop your file here' : 'Drag & drop your file here'}
                </p>
                <p className="text-sm text-gray-500 mb-4">
                  or click to browse (PDF, DOCX, PPTX, TXT, MD)
                </p>
                <p className="text-xs text-gray-400">Maximum file size: 50MB</p>
              </>
            )}
          </div>

          {file && (
            <div className="flex justify-end">
              <button
                onClick={handleContinue}
                className="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                Continue
                <ArrowRight className="ml-2 h-5 w-5" />
              </button>
            </div>
          )}
        </div>
      )}

      {step === 'configure' && (
        <div className="space-y-6">
          <div className="flex items-center gap-2">
            <Users className="h-6 w-6" />
            <h3 className="text-xl font-semibold text-gray-900">Configure Discussion</h3>
          </div>

          <div className="bg-white border rounded-lg p-4 space-y-4">
            <div className="flex items-center gap-4 flex-wrap">
              <label className="text-sm font-medium text-gray-700">Variants</label>
              <div className="flex items-center gap-3">
                <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="radio"
                    name="groupMode"
                    checked={groupMode === 'generate'}
                    onChange={() => setGroupMode('generate')}
                  />
                  Generate new
                </label>
                <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                  <input
                    type="radio"
                    name="groupMode"
                    checked={groupMode === 'existing'}
                    onChange={() => setGroupMode('existing')}
                  />
                  Use existing group
                </label>
              </div>
            </div>

            {groupMode === 'existing' ? (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Persona group</label>
                  <select
                    value={selectedGroupId}
                    onChange={(e) => setSelectedGroupId(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-sm"
                  >
                    {groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name} ({g.role_key})
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    Groups are saved and reusable.
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Variant count</label>
                  <input
                    type="number"
                    min={2}
                    max={8}
                    value={variantCount}
                    onChange={(e) => setVariantCount(parseInt(e.target.value || '4', 10))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-sm"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    Used only when generating; existing groups use their saved members.
                  </p>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Base persona</label>
                  <select
                    value={basePersonaId}
                    onChange={(e) => setBasePersonaId(e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-sm"
                  >
                    {personas.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.id})
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    Variants will share the same role as this persona.
                  </p>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Variant count</label>
                  <input
                    type="number"
                    min={2}
                    max={8}
                    value={variantCount}
                    onChange={(e) => setVariantCount(parseInt(e.target.value || '4', 10))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-sm"
                  />
                  <p className="text-xs text-gray-500 mt-1">
                    All-against-all critiques scale as N×(N-1). Default 4.
                  </p>
                </div>
              </div>
            )}
          </div>

          <div className="bg-white border rounded-lg p-4 space-y-4">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div>
                <h4 className="font-medium text-gray-900">Backends</h4>
                <p className="text-sm text-gray-600 mt-1">
                  Variants generate initial analyses and critiques; chairman synthesizes the final result.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <p className="text-sm font-medium text-gray-700">Variant backend</p>
                <select
                  value={variantPreset}
                  onChange={(e) => handlePresetChange(e.target.value, 'variant')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-sm"
                >
                  {MODEL_PRESETS.map((p) => (
                    <option
                      key={p.id}
                      value={p.id}
                      disabled={!!p.disabled || isPresetUnavailable(p.provider)}
                    >
                      {isPresetUnavailable(p.provider) ? `${p.label} (Unavailable)` : p.label}
                    </option>
                  ))}
                </select>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={variantProvider}
                    onChange={(e) => {
                      setVariantPreset('custom');
                      setVariantProvider(e.target.value);
                    }}
                    disabled={variantPreset !== 'custom'}
                    className="w-full px-3 py-2 border rounded-md disabled:bg-gray-50 font-mono text-sm"
                    placeholder="provider"
                  />
                  <input
                    type="text"
                    value={variantModel}
                    onChange={(e) => {
                      setVariantPreset('custom');
                      setVariantModel(e.target.value);
                    }}
                    disabled={variantPreset !== 'custom'}
                    className="w-full px-3 py-2 border rounded-md disabled:bg-gray-50 font-mono text-sm"
                    placeholder="model"
                  />
                </div>
              </div>

              <div className="space-y-2">
                <p className="text-sm font-medium text-gray-700">Chairman backend</p>
                <select
                  value={chairPreset}
                  onChange={(e) => handlePresetChange(e.target.value, 'chair')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white text-sm"
                >
                  {MODEL_PRESETS.map((p) => (
                    <option
                      key={p.id}
                      value={p.id}
                      disabled={!!p.disabled || isPresetUnavailable(p.provider)}
                    >
                      {isPresetUnavailable(p.provider) ? `${p.label} (Unavailable)` : p.label}
                    </option>
                  ))}
                </select>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={chairProvider}
                    onChange={(e) => {
                      setChairPreset('custom');
                      setChairProvider(e.target.value);
                    }}
                    disabled={chairPreset !== 'custom'}
                    className="w-full px-3 py-2 border rounded-md disabled:bg-gray-50 font-mono text-sm"
                    placeholder="provider"
                  />
                  <input
                    type="text"
                    value={chairModel}
                    onChange={(e) => {
                      setChairPreset('custom');
                      setChairModel(e.target.value);
                    }}
                    disabled={chairPreset !== 'custom'}
                    className="w-full px-3 py-2 border rounded-md disabled:bg-gray-50 font-mono text-sm"
                    placeholder="model"
                  />
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between pt-2">
            <button
              onClick={() => setStep('upload')}
              className="text-gray-600 hover:text-gray-900 font-medium"
            >
              ← Back
            </button>
            <button
              onClick={handleStartDiscussion}
              disabled={loading}
              className="inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-gray-900 hover:bg-gray-800 disabled:opacity-50"
            >
              {loading ? (
                <>
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2" />
                  Starting...
                </>
              ) : (
                <>
                  Start Discussion
                  <ArrowRight className="ml-2 h-5 w-5" />
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
