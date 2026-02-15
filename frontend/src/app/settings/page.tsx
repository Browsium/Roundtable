'use client';

import { useState, useEffect } from 'react';
import { Settings, Check, AlertCircle, GitBranch, Server, Monitor } from 'lucide-react';
import { FRONTEND_VERSION, BUILD_DATE_ET } from '@/lib/version';
import { settingsApi, clibridgeApi } from '@/lib/api';
import {
  DEFAULT_ANALYSIS_MODEL,
  DEFAULT_ANALYSIS_PROVIDER,
  MODEL_PRESETS,
  inferPresetId,
} from '@/lib/analysis-presets';

interface ApiVersionInfo {
  version: string;
  build_date: string;
  environment: string;
}

export default function SettingsPage() {
  const [apiUrl, setApiUrl] = useState('');
  const [showSavedMessage, setShowSavedMessage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storedValue, setStoredValue] = useState<string | null>(null);
  const [apiVersion, setApiVersion] = useState<ApiVersionInfo | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [providerAvailability, setProviderAvailability] = useState<Record<string, boolean> | null>(null);

  const [analysisProvider, setAnalysisProvider] = useState(DEFAULT_ANALYSIS_PROVIDER);
  const [analysisModel, setAnalysisModel] = useState(DEFAULT_ANALYSIS_MODEL);
  const [analysisPreset, setAnalysisPreset] = useState('claude-sonnet');
  const [analysisSavedMessage, setAnalysisSavedMessage] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);

  useEffect(() => {
    // Load saved API URL
    const saved = localStorage.getItem('api_url');
    const defaultUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
    setApiUrl(saved || defaultUrl);
    setStoredValue(saved);

    // Fetch API version
    fetchApiVersion(saved || defaultUrl);
    fetchApiSettings(saved || defaultUrl);
    fetchClibridgeHealth(saved || defaultUrl);
  }, []);

  const fetchApiVersion = async (url: string) => {
    try {
      setVersionError(null);
      const response = await fetch(`${url}/version`);
      if (response.ok) {
        const data = await response.json();
        setApiVersion(data);
      } else {
        setVersionError('Unable to fetch API version');
      }
    } catch {
      setVersionError('Unable to connect to API');
    }
  };

  const fetchClibridgeHealth = async (url: string) => {
    try {
      const data = await clibridgeApi.health(url);
      const map: Record<string, boolean> = {};
      for (const p of data.providers || []) {
        map[String(p.name || '').toLowerCase()] = !!p.available;
      }
      setProviderAvailability(map);
    } catch {
      // Treat as unknown: don't disable any preset based on availability.
      setProviderAvailability(null);
    }
  };

  const fetchApiSettings = async (url: string) => {
    try {
      setAnalysisError(null);
      const data = await settingsApi.getAll(url);
      const provider = (data.analysis_provider || DEFAULT_ANALYSIS_PROVIDER).trim();
      const model = (data.analysis_model || DEFAULT_ANALYSIS_MODEL).trim();

      setAnalysisProvider(provider);
      setAnalysisModel(model);
      setAnalysisPreset(inferPresetId(provider, model));
    } catch {
      setAnalysisError('Unable to fetch analysis settings');
    }
  };

  const handleSave = () => {
    try {
      // Validate URL
      new URL(apiUrl);
      localStorage.setItem('api_url', apiUrl);
      setStoredValue(apiUrl);
      setShowSavedMessage(true);
      setError(null);
      
      // Refresh API version with new URL
      fetchApiVersion(apiUrl);
      fetchApiSettings(apiUrl);
      fetchClibridgeHealth(apiUrl);
      
      setTimeout(() => setShowSavedMessage(false), 3000);
    } catch {
      setError('Please enter a valid URL');
    }
  };

  const handleReset = () => {
    const defaultUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
    localStorage.removeItem('api_url');
    setApiUrl(defaultUrl);
    setStoredValue(null);
    setShowSavedMessage(true);
    fetchApiVersion(defaultUrl);
    fetchApiSettings(defaultUrl);
    fetchClibridgeHealth(defaultUrl);
    setTimeout(() => setShowSavedMessage(false), 3000);
  };

  const handleSaveAnalysisSettings = async () => {
    try {
      setAnalysisError(null);
      setAnalysisLoading(true);

      // Validate API URL before calling it.
      new URL(apiUrl);

      const provider = analysisProvider.trim();
      const model = analysisModel.trim();
      if (!provider) {
        setAnalysisError('Provider cannot be empty');
        return;
      }
      if (!model) {
        setAnalysisError('Model cannot be empty');
        return;
      }

      await settingsApi.update({
        analysis_provider: provider,
        analysis_model: model,
      }, apiUrl);

      setAnalysisSavedMessage(true);
      setTimeout(() => setAnalysisSavedMessage(false), 3000);
    } catch (e: any) {
      setAnalysisError(e?.message || 'Failed to save analysis settings');
    } finally {
      setAnalysisLoading(false);
    }
  };

  const isPresetUnavailable = (provider: string): boolean => {
    const p = (provider || '').trim().toLowerCase();
    if (!p) return false;
    if (!providerAvailability) return false;
    return providerAvailability[p] === false;
  };

  const formatBuildDateEt = (dateString: string) => {
    try {
      if (!dateString) return 'unknown';
      const d = new Date(dateString);
      if (Number.isNaN(d.getTime()) || d.getTime() <= 0) return 'unknown';
      return new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
        timeZoneName: 'short',
      }).format(d);
    } catch {
      return dateString;
    }
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-gray-900">Settings</h2>
        <p className="text-gray-600 mt-2">Configure application settings</p>
      </div>

      {/* Version Information */}
      <div className="bg-white border rounded-lg p-6 mb-6">
        <div className="flex items-center gap-3 mb-6">
          <GitBranch className="h-6 w-6 text-blue-600" />
          <h3 className="text-lg font-semibold text-gray-900">Version Information</h3>
        </div>

        <div className="space-y-4">
          {/* Frontend Version */}
          <div className="flex items-start gap-3 p-4 bg-gray-50 rounded-lg">
            <Monitor className="h-5 w-5 text-blue-600 mt-0.5" />
            <div className="flex-1">
              <h4 className="font-medium text-gray-900">Frontend</h4>
              <div className="text-sm text-gray-600 mt-1 space-y-1">
                <div className="flex justify-between">
                  <span>Version:</span>
                  <span className="font-mono font-medium">{FRONTEND_VERSION}</span>
                </div>
                <div className="flex justify-between">
                  <span>Build Date:</span>
                  <span className="font-mono">{BUILD_DATE_ET || 'unknown'}</span>
                </div>
              </div>
            </div>
          </div>

          {/* API Version */}
          <div className="flex items-start gap-3 p-4 bg-gray-50 rounded-lg">
            <Server className="h-5 w-5 text-green-600 mt-0.5" />
            <div className="flex-1">
              <h4 className="font-medium text-gray-900">API</h4>
              {apiVersion ? (
                <div className="text-sm text-gray-600 mt-1 space-y-1">
                  <div className="flex justify-between">
                    <span>Version:</span>
                    <span className="font-mono font-medium">{apiVersion.version}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Build Date:</span>
                    <span className="font-mono">{formatBuildDateEt(apiVersion.build_date)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Environment:</span>
                    <span className="font-mono">{apiVersion.environment}</span>
                  </div>
                </div>
              ) : versionError ? (
                <div className="text-sm text-red-600 mt-1 flex items-center gap-1">
                  <AlertCircle className="h-4 w-4" />
                  {versionError}
                </div>
              ) : (
                <div className="text-sm text-gray-500 mt-1">Loading...</div>
              )}
            </div>
          </div>
        </div>
      </div>

      <div className="bg-white border rounded-lg p-6">
        <div className="flex items-center gap-3 mb-6">
          <Settings className="h-6 w-6 text-blue-600" />
          <h3 className="text-lg font-semibold text-gray-900">API Configuration</h3>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Backend API URL
            </label>
            <input
              type="url"
              value={apiUrl}
              onChange={(e) => setApiUrl(e.target.value)}
              placeholder="https://api.example.com"
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <p className="text-sm text-gray-500 mt-2">
              The URL of your Roundtable backend API. Leave empty to use the default.
            </p>
          </div>

          {error && (
            <div className="flex items-center gap-2 text-red-600 text-sm">
              <AlertCircle className="h-4 w-4" />
              {error}
            </div>
          )}

          {showSavedMessage && (
            <div className="flex items-center gap-2 text-green-600 text-sm">
              <Check className="h-4 w-4" />
              Settings saved successfully
            </div>
          )}

          <div className="flex gap-3 pt-4">
            <button
              onClick={handleSave}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium"
            >
              Save Settings
            </button>
            <button
              onClick={handleReset}
              className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 font-medium"
            >
              Reset to Default
            </button>
          </div>
        </div>
      </div>

      {/* Analysis Backend Configuration */}
      <div className="bg-white border rounded-lg p-6 mt-6">
        <div className="flex items-center gap-3 mb-6">
          <Server className="h-6 w-6 text-purple-600" />
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Analysis Backend</h3>
            <p className="text-sm text-gray-600">Applies to the next document you submit for analysis.</p>
          </div>
        </div>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">
              Preset
            </label>
            <select
              value={analysisPreset}
              onChange={(e) => {
                const presetId = e.target.value;
                setAnalysisPreset(presetId);
                const preset = MODEL_PRESETS.find(p => p.id === presetId);
                if (preset && presetId !== 'custom') {
                  setAnalysisProvider(preset.provider);
                  setAnalysisModel(preset.model);
                }
              }}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
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
            <p className="text-sm text-gray-500 mt-2">
              Presets set the raw provider/model values sent to CLIBridge. You can fine-tune below.
            </p>
            <p className="text-sm text-gray-500 mt-1">
              DeepSeek/Kimi/MiniMax/Nemotron presets are routed via provider <span className="font-mono">opencode</span>.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Provider
              </label>
              <input
                type="text"
                value={analysisProvider}
                onChange={(e) => {
                  setAnalysisProvider(e.target.value);
                  setAnalysisPreset('custom');
                }}
                placeholder="claude"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Model
              </label>
              <input
                type="text"
                value={analysisModel}
                onChange={(e) => {
                  setAnalysisModel(e.target.value);
                  setAnalysisPreset('custom');
                }}
                placeholder="sonnet"
                className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
              />
            </div>
          </div>

          {analysisError && (
            <div className="flex items-center gap-2 text-red-600 text-sm">
              <AlertCircle className="h-4 w-4" />
              {analysisError}
            </div>
          )}

          {analysisSavedMessage && (
            <div className="flex items-center gap-2 text-green-600 text-sm">
              <Check className="h-4 w-4" />
              Analysis settings saved successfully
            </div>
          )}

          <div className="flex gap-3 pt-2">
            <button
              onClick={handleSaveAnalysisSettings}
              disabled={analysisLoading}
              className="px-4 py-2 bg-gray-900 text-white rounded-md hover:bg-gray-800 font-medium disabled:opacity-50"
            >
              {analysisLoading ? 'Saving...' : 'Save Analysis Settings'}
            </button>
          </div>
        </div>
      </div>

      <div className="mt-8 bg-gray-50 border rounded-lg p-6">
        <h3 className="text-sm font-medium text-gray-900 mb-2">Current Configuration</h3>
        <div className="space-y-2 text-sm">
          <div className="flex justify-between">
            <span className="text-gray-600">Environment Variable:</span>
            <span className="font-mono text-gray-900">
              {process.env.NEXT_PUBLIC_API_URL || 'Not set'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Stored in localStorage:</span>
            <span className="font-mono text-gray-900">
              {storedValue || 'Not set'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-600">Default URL:</span>
            <span className="font-mono text-gray-900">http://localhost:8000</span>
          </div>
        </div>
      </div>
    </div>
  );
}
