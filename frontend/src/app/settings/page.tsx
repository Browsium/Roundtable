'use client';

import { useState, useEffect } from 'react';
import { Settings, Check, AlertCircle } from 'lucide-react';

export default function SettingsPage() {
  const [apiUrl, setApiUrl] = useState('');
  const [showSavedMessage, setShowSavedMessage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storedValue, setStoredValue] = useState<string | null>(null);

  useEffect(() => {
    // Load saved API URL
    const saved = localStorage.getItem('api_url');
    const defaultUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
    setApiUrl(saved || defaultUrl);
    setStoredValue(saved);
  }, []);

  const handleSave = () => {
    try {
      // Validate URL
      new URL(apiUrl);
      localStorage.setItem('api_url', apiUrl);
      setStoredValue(apiUrl);
      setShowSavedMessage(true);
      setError(null);
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
    setTimeout(() => setShowSavedMessage(false), 3000);
  };

  return (
    <div className="max-w-2xl mx-auto">
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-gray-900">Settings</h2>
        <p className="text-gray-600 mt-2">Configure application settings</p>
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
