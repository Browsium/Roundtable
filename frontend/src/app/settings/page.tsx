'use client';

import { useState, useEffect } from 'react';
import { Settings, Check, AlertCircle, GitBranch, Server, Monitor } from 'lucide-react';
import { FRONTEND_VERSION, BUILD_DATE } from '@/lib/version';
import { sessionApi } from '@/lib/api';

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

  useEffect(() => {
    // Load saved API URL
    const saved = localStorage.getItem('api_url');
    const defaultUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
    setApiUrl(saved || defaultUrl);
    setStoredValue(saved);

    // Fetch API version
    fetchApiVersion(saved || defaultUrl);
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
    setTimeout(() => setShowSavedMessage(false), 3000);
  };

  const formatBuildDate = (dateString: string) => {
    try {
      return new Date(dateString).toLocaleString();
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
                  <span className="font-mono">{formatBuildDate(BUILD_DATE)}</span>
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
                    <span className="font-mono">{formatBuildDate(apiVersion.build_date)}</span>
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
