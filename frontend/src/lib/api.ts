import axios from 'axios';

const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000',
  headers: {
    'Content-Type': 'application/json',
  },
});

// Types
export interface Persona {
  id: string;
  name: string;
  role: string;
  is_system: boolean;
  is_custom: boolean;
  profile_json: {
    background: string;
    professional_priorities: string[];
    marketing_pet_peeves: string[];
    evaluation_rubric: Record<string, string>;
    convince_me_criteria: string;
  };
}

export interface Session {
  id: string;
  file_name: string;
  file_metadata?: {
    filename: string;
    size_bytes: number;
    extension: string;
    version?: string;
  };
  selected_persona_ids: string[];
  status: 'uploaded' | 'analyzing' | 'completed' | 'partial' | 'failed';
  share_with_emails?: string[];
  analyses?: Analysis[];
  created_at: string;
  updated_at?: string;
}

export interface Analysis {
  id: number;
  persona_id: string;
  persona_name?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  score_json?: {
    relevance: { score: number; commentary: string };
    technical_credibility: { score: number; commentary: string };
    differentiation: { score: number; commentary: string };
    actionability: { score: number; commentary: string };
    trust_signals: { score: number; commentary: string };
    language_fit: { score: number; commentary: string };
  };
  top_issues_json?: Array<{
    issue: string;
    specific_example_from_content: string;
    suggested_rewrite: string;
  }>;
  rewritten_suggestions_json?: {
    what_works_well: string[];
    overall_verdict: string;
    rewritten_headline: string;
  };
  error_message?: string;
}

// API functions
export const personaApi = {
  getAll: async (): Promise<Persona[]> => {
    const response = await api.get('/api/personas/');
    return response.data;
  },
  
  get: async (id: string): Promise<Persona> => {
    const response = await api.get(`/api/personas/${id}`);
    return response.data;
  },
  
  create: async (personaData: { profile_json: any }): Promise<Persona> => {
    const response = await api.post('/api/personas/', personaData);
    return response.data;
  },
  
  update: async (id: string, personaData: { profile_json: any }): Promise<Persona> => {
    const response = await api.put(`/api/personas/${id}`, personaData);
    return response.data;
  },
  
  delete: async (id: string): Promise<void> => {
    await api.delete(`/api/personas/${id}`);
  },
  
  reload: async (): Promise<{ message: string; loaded: number; removed: number }> => {
    const response = await api.post('/api/personas/reload');
    return response.data;
  },
};

export const sessionApi = {
  getAll: async (): Promise<Session[]> => {
    const response = await api.get('/api/sessions/');
    return response.data;
  },
  
  get: async (id: string): Promise<Session> => {
    const response = await api.get(`/api/sessions/${id}`);
    return response.data;
  },
  
  create: async (file: File, selectedPersonaIds: string[]): Promise<Session> => {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('selected_persona_ids', JSON.stringify(selectedPersonaIds));
    
    const response = await api.post('/api/sessions/', formData, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
    return response.data;
  },
  
  startAnalysis: async (id: string): Promise<{ message: string; session_id: string }> => {
    const response = await api.post(`/api/sessions/${id}/analyze`);
    return response.data;
  },
  
  retryAnalysis: async (sessionId: string, personaId: string): Promise<any> => {
    const response = await api.post(`/api/sessions/${sessionId}/retry/${personaId}`);
    return response.data;
  },
  
  share: async (id: string, emails: string[]): Promise<void> => {
    await api.post(`/api/sessions/${id}/share`, { emails });
  },
  
  delete: async (id: string): Promise<void> => {
    await api.delete(`/api/sessions/${id}`);
  },
};

export const adminApi = {
  listUsers: async (): Promise<any[]> => {
    const response = await api.get('/api/admin/users');
    return response.data;
  },
  
  listSessions: async (): Promise<any[]> => {
    const response = await api.get('/api/admin/sessions');
    return response.data;
  },
  
  listBackends: async (): Promise<{ available: string[]; default: string }> => {
    const response = await api.get('/api/admin/backends');
    return response.data;
  },
  
  promotePersona: async (personaId: string): Promise<void> => {
    await api.post(`/api/admin/personas/${personaId}/promote`);
  },
};

export default api;