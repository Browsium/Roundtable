'use client';

import { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import { Upload, FileText, Users, ArrowRight, Check, AlertCircle } from 'lucide-react';
import { personaApi, sessionApi, r2Api } from '@/lib/api';
import type { Persona } from '@/lib/types';
import { useRouter } from 'next/navigation';

export default function Home() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [selectedPersonas, setSelectedPersonas] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<'upload' | 'select'>('upload');

  // Load personas on mount
  const loadPersonas = useCallback(async () => {
    try {
      const data = await personaApi.getAll();
      setPersonas(data);
    } catch (err) {
      console.error('Failed to load personas:', err);
    }
  }, []);

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

      // Create session (metadata only, no file)
      const session = await sessionApi.create(
        file.name,
        file.size,
        fileExtension,
        selectedPersonas
      );

      // Upload file to R2
      await r2Api.uploadFile(session.id, file);

      // Redirect to results page where WebSocket will handle analysis
      router.push(`/sessions/${session.id}`);
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