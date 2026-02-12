'use client';

import { useEffect, useState } from 'react';
import { Plus, Edit, Trash2, RefreshCw, User } from 'lucide-react';
import { personaApi } from '@/lib/api';
import type { Persona } from '@/lib/types';

export default function PersonasPage() {
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editingPersona, setEditingPersona] = useState<Persona | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [formData, setFormData] = useState<any>({});

  useEffect(() => {
    loadPersonas();
  }, []);

  const loadPersonas = async () => {
    try {
      setLoading(true);
      const data = await personaApi.getAll();
      setPersonas(data);
    } catch (err) {
      setError('Failed to load personas');
    } finally {
      setLoading(false);
    }
  };

  const handleReload = async () => {
    // Reload from D1 - just re-fetch
    await loadPersonas();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this persona?')) return;
    try {
      await personaApi.delete(id);
      await loadPersonas();
    } catch (err) {
      setError('Failed to delete persona');
    }
  };

  const handleSave = async () => {
    try {
      if (editingPersona) {
        await personaApi.update(editingPersona.id, { profile_json: formData });
      } else if (isCreating) {
        await personaApi.create({ profile_json: formData });
      }
      setEditingPersona(null);
      setIsCreating(false);
      setFormData({});
      await loadPersonas();
    } catch (err: any) {
      setError(err.response?.data?.detail || 'Failed to save persona');
    }
  };

  const startEdit = (persona: Persona) => {
    setEditingPersona(persona);
    // Parse profile_json if it's a string
    const profile = typeof persona.profile_json === 'string' 
      ? JSON.parse(persona.profile_json) 
      : persona.profile_json;
    setFormData(profile || {});
  };

  const startCreate = () => {
    setIsCreating(true);
    setFormData({
      id: '',
      name: '',
      role: '',
      background: '',
      professional_priorities: [],
      marketing_pet_peeves: [],
      evaluation_rubric: {},
      convince_me_criteria: '',
      voice_and_tone: '',
      typical_objections: [],
      industry_influences: '',
      budget_authority: ''
    });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (editingPersona || isCreating) {
    return (
      <div>
        <h2 className="text-3xl font-bold text-gray-900 mb-6">
          {editingPersona ? 'Edit Persona' : 'Create Persona'}
        </h2>
        
        <div className="bg-white border rounded-lg p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">ID</label>
            <input
              type="text"
              value={formData.id || ''}
              onChange={(e) => setFormData({ ...formData, id: e.target.value })}
              disabled={!!editingPersona}
              className="w-full px-3 py-2 border rounded-md focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Name</label>
            <input
              type="text"
              value={formData.name || ''}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="w-full px-3 py-2 border rounded-md focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Role</label>
            <input
              type="text"
              value={formData.role || ''}
              onChange={(e) => setFormData({ ...formData, role: e.target.value })}
              className="w-full px-3 py-2 border rounded-md focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Background</label>
            <textarea
              value={formData.background || ''}
              onChange={(e) => setFormData({ ...formData, background: e.target.value })}
              rows={4}
              className="w-full px-3 py-2 border rounded-md focus:ring-blue-500 focus:border-blue-500"
            />
          </div>
          
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                setEditingPersona(null);
                setIsCreating(false);
              }}
              className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-8">
        <div>
          <h2 className="text-3xl font-bold text-gray-900 mb-2">Personas</h2>
          <p className="text-gray-600">
            Manage roundtable personas that review marketing content.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={handleReload}
            className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Reload from Files
          </button>
          <button
            onClick={startCreate}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
          >
            <Plus className="h-4 w-4 mr-2" />
            Create Persona
          </button>
        </div>
      </div>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {personas.map((persona) => (
          <div key={persona.id} className="bg-white border rounded-lg p-6">
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3">
                <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center">
                  <User className="h-5 w-5 text-blue-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900">{persona.name}</h3>
                  <p className="text-sm text-gray-600">{persona.role}</p>
                </div>
              </div>
{persona.is_system && (
                <span className="px-2 py-1 bg-gray-100 text-gray-600 text-xs rounded">
                  System
                </span>
              )}
              {!persona.is_system && (
                <span className="px-2 py-1 bg-blue-100 text-blue-600 text-xs rounded">
                  Custom
                </span>
              )}
            </div>

            <p className="text-sm text-gray-600 mb-4 line-clamp-3">
              {(() => {
                try {
                  const profile = typeof persona.profile_json === 'string' 
                    ? JSON.parse(persona.profile_json) 
                    : persona.profile_json;
                  return profile?.background || '';
                } catch (e) {
                  return '';
                }
              })()}
            </p>
            
            <div className="flex gap-2">
              <button
                onClick={() => startEdit(persona)}
                className="flex-1 inline-flex items-center justify-center px-3 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
              >
                <Edit className="h-4 w-4 mr-1" />
                Edit
              </button>
              {!persona.is_system && (
                <button
                  onClick={() => handleDelete(persona.id)}
                  className="inline-flex items-center justify-center px-3 py-2 border border-red-300 rounded-md text-sm font-medium text-red-700 bg-white hover:bg-red-50"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}