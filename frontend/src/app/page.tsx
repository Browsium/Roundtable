'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { useDropzone } from 'react-dropzone';
import { Upload, FileText, Users, ArrowRight, Check, AlertCircle, ChevronDown } from 'lucide-react';
import { personaApi, sessionApi, r2Api, settingsApi, clibridgeApi } from '@/lib/api';
import type { Persona } from '@/lib/types';
import { useRouter } from 'next/navigation';
import {
  DEFAULT_ANALYSIS_MODEL,
  DEFAULT_ANALYSIS_PROVIDER,
  MODEL_PRESETS,
  inferPresetId,
} from '@/lib/analysis-presets';

export default function Home() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [selectedPersonas, setSelectedPersonas] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'upload' | 'select'>('upload');
  const [analysisProvider, setAnalysisProvider] = useState(DEFAULT_ANALYSIS_PROVIDER);
  const [analysisModel, setAnalysisModel] = useState(DEFAULT_ANALYSIS_MODEL);
  const [analysisPreset, setAnalysisPreset] = useState('claude-sonnet');
  const [useCouncil, setUseCouncil] = useState(true);
  const [councilMemberIds, setCouncilMemberIds] = useState<string[]>(['claude-sonnet']);
  const [providerAvailability, setProviderAvailability] = useState<Record<string, boolean> | null>(null);
  const [analysisBackendOpen, setAnalysisBackendOpen] = useState(false);
  const analysisBackendRef = useRef<HTMLDivElement | null>(null);

  // Load personas on mount
  const loadPersonas = useCallback(async () => {
    try {
      const data = await personaApi.getAll();
      setPersonas(data);
    } catch (err) {
      console.error('Failed to load personas:', err);
    }
  }, []);

  // Default analysis backend for new sessions: fetched from API settings.
  useEffect(() => {
    (async () => {
      try {
        const data = await settingsApi.getAll();
        const provider = (data.analysis_provider || DEFAULT_ANALYSIS_PROVIDER).trim();
        const model = (data.analysis_model || DEFAULT_ANALYSIS_MODEL).trim();
        setAnalysisProvider(provider);
        setAnalysisModel(model);
        const presetId = inferPresetId(provider, model);
        setAnalysisPreset(presetId);
        if (presetId !== 'custom') {
          setCouncilMemberIds([presetId]);
        }
      } catch {
        // If settings are unreachable, keep defaults.
      }
    })();
  }, []);

  // Provider availability (from CLIBridge /health via the API proxy).
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

  const isPresetDisabled = (preset: (typeof MODEL_PRESETS)[number] | undefined | null): boolean => {
    if (!preset) return true;
    if (preset.disabled) return true;
    return isPresetUnavailable(preset.provider);
  };

  useEffect(() => {
    if (!analysisBackendOpen) return;
    // Ensure the expanded section is visible on smaller screens.
    analysisBackendRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [analysisBackendOpen]);

  // File upload handling
  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      setFile(acceptedFiles[0]);
      setError(null);
      loadPersonas();
    }
  }, [loadPersonas]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'application/pdf': ['.pdf'],
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
      'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
      'text/plain': ['.txt'],
      'text/markdown': ['.md'],
    },
    maxSize: 50 * 1024 * 1024, // 50MB
    multiple: false,
  });

  const handlePersonaToggle = (personaId: string) => {
    setSelectedPersonas(prev => 
      prev.includes(personaId) 
        ? prev.filter(id => id !== personaId)
        : [...prev, personaId]
    );
  };

  const handleSelectAll = () => {
    if (selectedPersonas.length === personas.length) {
      setSelectedPersonas([]);
    } else {
      setSelectedPersonas(personas.map(p => p.id));
    }
  };

  const handleContinue = () => {
    if (!file) {
      setError('Please upload a file first');
      return;
    }
    setStep('select');
    loadPersonas();
  };

  const handlePresetChange = (id: string) => {
    setAnalysisPreset(id);
    const preset = MODEL_PRESETS.find(p => p.id === id);
    if (!preset) return;
    if (id === 'custom') return;
    setAnalysisProvider(preset.provider);
    setAnalysisModel(preset.model);

    // If council is enabled and the member set is empty, default members to chair preset.
    setCouncilMemberIds((prev) => (prev.length === 0 ? [id] : prev));
  };

  const toggleCouncilMember = (id: string) => {
    setCouncilMemberIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      return [...prev, id];
    });
  };

 const handleStartAnalysis = async () => {
    if (!file || selectedPersonas.length === 0) {
      setError('Please select at least one persona');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      // Get file extension
      const fileExtension = file.name.split('.').pop()?.toLowerCase() || '';

      const chairBackend = {
        provider: analysisProvider.trim(),
        model: analysisModel.trim(),
      };

      let workflow: string | undefined = undefined;
      let analysisConfig: any | undefined = undefined;
        if (useCouncil) {
          workflow = 'roundtable_council';

          const members = councilMemberIds
            .map((pid) => MODEL_PRESETS.find((p) => p.id === pid))
            .filter((p) => !!p && !isPresetDisabled(p) && p!.id !== 'custom')
            .map((p) => ({ provider: p!.provider, model: p!.model }));

        if (members.length === 0) {
          setError('Select at least one council member model');
          setLoading(false);
          return;
        }

        analysisConfig = {
          council: {
            members,
            reviewer_backend: chairBackend,
            chair_backend: chairBackend,
          },
        };
      } else {
        workflow = 'roundtable_standard';
      }

       // Create session (metadata only, no file)
       const session = await sessionApi.create(
         file.name,
         file.size,
         fileExtension,
        selectedPersonas,
        analysisProvider.trim(),
        analysisModel.trim(),
        workflow,
        analysisConfig,
      );

      // Upload file to R2
      await r2Api.uploadFile(session.id, file);

// Redirect to results page where WebSocket will handle analysis
    router.push(`/sessions/detail?id=${session.id}`);
    } catch (err: any) {
      setError(err.message || 'Failed to start analysis');
      setLoading(false);
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-gray-900 mb-2">
          Upload Your Marketing Document
        </h2>
        <p className="text-gray-600">
          Get feedback from our panel of cybersecurity industry experts on your marketing content.
        </p>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-700">
          <AlertCircle className="h-5 w-5" />
          {error}
        </div>
      )}

      {/* Step 1: Upload */}
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

      {/* Step 2: Select Personas */}
      {step === 'select' && (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-xl font-semibold text-gray-900 flex items-center gap-2">
                <Users className="h-6 w-6" />
                Select Your Panel
              </h3>
              <p className="text-gray-600 mt-1">
                Choose which personas will review your content
              </p>
            </div>
            <button
              onClick={handleSelectAll}
              className="text-sm text-blue-600 hover:text-blue-800 font-medium"
            >
              {selectedPersonas.length === personas.length ? 'Deselect All' : 'Select All'}
            </button>
           </div>

           <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
             {personas.map((persona) => (
               <div
                 key={persona.id}
                onClick={() => handlePersonaToggle(persona.id)}
                className={`p-4 border-2 rounded-lg cursor-pointer transition-all
                  ${selectedPersonas.includes(persona.id)
                    ? 'border-blue-500 bg-blue-50'
                    : 'border-gray-200 hover:border-gray-300'
                  }`}
              >
                <div className="flex items-start gap-3">
                  <div className={`mt-0.5 w-5 h-5 rounded border-2 flex items-center justify-center
                    ${selectedPersonas.includes(persona.id)
                      ? 'bg-blue-500 border-blue-500'
                      : 'border-gray-300'
                    }`}
                  >
                    {selectedPersonas.includes(persona.id) && (
                      <Check className="h-3 w-3 text-white" />
                    )}
                  </div>
<div className="flex-1">
                          <h4 className="font-medium text-gray-900">{persona.name}</h4>
                          <p className="text-sm text-gray-600">{persona.role}</p>
                          {(() => {
                            try {
                              const profile = typeof persona.profile_json === 'string' 
                                ? JSON.parse(persona.profile_json) 
                                : persona.profile_json;
                              if (profile?.convince_me_criteria) {
                                return (
                                  <p className="text-xs text-gray-500 mt-2 line-clamp-2">
                                    {profile.convince_me_criteria}
                                  </p>
                                );
                              }
                            } catch (e) {
                              // Ignore parse errors
                            }
                            return null;
                          })()}
                        </div>
                </div>
               </div>
             ))}
           </div>

           <div
             ref={analysisBackendRef}
             className="bg-white border rounded-lg overflow-hidden"
           >
             <button
               type="button"
               onClick={() => setAnalysisBackendOpen((v) => !v)}
               aria-expanded={analysisBackendOpen}
               className="w-full p-4 text-left flex items-start justify-between gap-4 hover:bg-gray-50"
             >
               <div className="min-w-0">
                 <p className="text-sm font-medium text-gray-900">Analysis Backend</p>
                 <p className="text-xs text-gray-600 mt-1">
                   {analysisPreset === 'custom'
                     ? `${analysisProvider.trim() || 'provider'} / ${analysisModel.trim() || 'model'}`
                     : (MODEL_PRESETS.find((p) => p.id === analysisPreset)?.label || analysisPreset)}
                   {useCouncil ? ` • Council: on (${councilMemberIds.length})` : ' • Council: off'}
                 </p>
               </div>
               <ChevronDown
                 className={`h-5 w-5 text-gray-500 shrink-0 transition-transform ${analysisBackendOpen ? 'rotate-180' : ''}`}
               />
             </button>

             <div
               className={`transition-[max-height] duration-300 ease-in-out overflow-hidden ${
                 analysisBackendOpen ? 'max-h-[520px]' : 'max-h-0'
               }`}
             >
               <div className="p-4 border-t max-h-[520px] overflow-y-auto space-y-4">
                 <div className="flex items-start justify-between gap-4 flex-wrap">
                   <div>
                     <p className="text-sm text-gray-700">
                       Applies to this document. You can change defaults in Settings.
                     </p>
                     <p className="text-xs text-gray-500 mt-1">
                       DeepSeek/Kimi/MiniMax/Nemotron presets are routed via CLIBridge provider <span className="font-mono">opencode</span>.
                     </p>
                   </div>
                   <div className="flex items-center gap-2">
                     <label className="text-sm text-gray-600">Preset</label>
                     <select
                       value={analysisPreset}
                       onChange={(e) => handlePresetChange(e.target.value)}
                       className="px-3 py-2 border border-gray-300 rounded-md bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                     >
                       {MODEL_PRESETS.map(p => (
                         <option
                           key={p.id}
                           value={p.id}
                           disabled={!!p.disabled || isPresetUnavailable(p.provider)}
                         >
                           {isPresetUnavailable(p.provider) ? `${p.label} (Unavailable)` : p.label}
                         </option>
                       ))}
                     </select>
                   </div>
                 </div>

                 <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                   <div>
                     <label className="block text-sm font-medium text-gray-700 mb-1">Provider</label>
                     <input
                       type="text"
                       value={analysisProvider}
                       onChange={(e) => {
                         setAnalysisPreset('custom');
                         setAnalysisProvider(e.target.value);
                       }}
                       disabled={analysisPreset !== 'custom'}
                       className="w-full px-3 py-2 border rounded-md focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-50 disabled:text-gray-500 font-mono text-sm"
                     />
                   </div>
                   <div>
                     <label className="block text-sm font-medium text-gray-700 mb-1">Model</label>
                     <input
                       type="text"
                       value={analysisModel}
                       onChange={(e) => {
                         setAnalysisPreset('custom');
                         setAnalysisModel(e.target.value);
                       }}
                       disabled={analysisPreset !== 'custom'}
                       className="w-full px-3 py-2 border rounded-md focus:ring-blue-500 focus:border-blue-500 disabled:bg-gray-50 disabled:text-gray-500 font-mono text-sm"
                     />
                   </div>
                 </div>

                 <div className="border-t pt-4">
                   <div className="flex items-center justify-between gap-4 flex-wrap">
                     <div>
                       <p className="text-sm font-medium text-gray-900">Council Mode</p>
                       <p className="text-xs text-gray-500 mt-1">
                         When enabled, each persona is run across multiple models and a chairman synthesizes one final answer per persona.
                       </p>
                     </div>
                     <label className="inline-flex items-center gap-2 text-sm text-gray-700">
                       <input
                         type="checkbox"
                         checked={useCouncil}
                         onChange={(e) => setUseCouncil(e.target.checked)}
                       />
                       Enable council
                     </label>
                   </div>

                   {useCouncil && (
                     <div className="mt-3">
                       <p className="text-sm font-medium text-gray-700 mb-2">Council members</p>
                       <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2">
                         {MODEL_PRESETS.filter(p => !isPresetDisabled(p) && p.id !== 'custom').map((p) => (
                           <label
                             key={p.id}
                             className="inline-flex items-center gap-2 px-3 py-2 border rounded-md bg-white text-sm cursor-pointer hover:bg-gray-50"
                           >
                             <input
                               type="checkbox"
                               checked={councilMemberIds.includes(p.id)}
                               onChange={() => toggleCouncilMember(p.id)}
                             />
                             <span>{p.label}</span>
                           </label>
                         ))}
                       </div>
                       <p className="text-xs text-gray-500 mt-2">
                         Chairman uses the selected provider/model above. Reviewer defaults to chairman.
                       </p>
                     </div>
                   )}
                 </div>
               </div>
             </div>
           </div>

           <div className="flex items-center justify-between pt-6 border-t">
             <button
               onClick={() => setStep('upload')}
                className="text-gray-600 hover:text-gray-900 font-medium"
            >
              ← Back to upload
            </button>
            <button
              onClick={handleStartAnalysis}
              disabled={selectedPersonas.length === 0 || loading}
              className={`inline-flex items-center px-6 py-3 border border-transparent text-base font-medium rounded-md shadow-sm text-white
                ${selectedPersonas.length === 0 || loading
                  ? 'bg-gray-400 cursor-not-allowed'
                  : 'bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500'
                }`}
            >
              {loading ? (
                <>
                  <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2" />
                  Starting Analysis...
                </>
              ) : (
                <>
                  Start Roundtable Analysis
                  <ArrowRight className="ml-2 h-5 w-5" />
                </>
              )}
            </button>
          </div>

          <div className="text-sm text-gray-500 text-center">
            {selectedPersonas.length} of {personas.length} personas selected
          </div>
        </div>
      )}
    </div>
  );
}
