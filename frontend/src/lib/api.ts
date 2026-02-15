import type { Persona, Session, Analysis } from './types';
import type { AnalysisArtifact } from './types';

// Get API URL from localStorage, environment, or fallback
const getApiUrl = () => {
  if (typeof window !== 'undefined') {
    // Check localStorage first (user override), then env var, then fallback
    const storedUrl = localStorage.getItem('api_url');
    if (storedUrl) return storedUrl;
    return process.env.NEXT_PUBLIC_API_URL || 'https://roundtable-api.browsium.workers.dev';
  }
  return 'https://roundtable-api.browsium.workers.dev';
};

// Helper for fetch with error handling
async function fetchWithError(url: string, options?: RequestInit): Promise<any> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`HTTP ${response.status}: ${error}`);
  }
  return response.json();
}

export type CLIBridgeProviderStatus = { name: string; available: boolean; version: string };
export type CLIBridgeHealthResponse = { status: string; version?: string; uptime?: string; providers: CLIBridgeProviderStatus[] };

export const clibridgeApi = {
  health: async (baseUrl?: string): Promise<CLIBridgeHealthResponse> => {
    const url = baseUrl || getApiUrl();
    return fetchWithError(`${url}/clibridge/health`);
  },
};

// Persona API
export const personaApi = {
  getAll: async (): Promise<Persona[]> => {
    return fetchWithError(`${getApiUrl()}/personas`);
  },

  get: async (id: string): Promise<Persona> => {
    return fetchWithError(`${getApiUrl()}/personas/${id}`);
  },

  create: async (personaData: { profile_json: any }): Promise<Persona> => {
    return fetchWithError(`${getApiUrl()}/personas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(personaData),
    });
  },

  update: async (id: string, personaData: { profile_json: any }): Promise<Persona> => {
    return fetchWithError(`${getApiUrl()}/personas/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(personaData),
    });
  },

  delete: async (id: string): Promise<void> => {
    await fetchWithError(`${getApiUrl()}/personas/${id}`, {
      method: 'DELETE',
    });
  },

  deploy: async (id: string): Promise<{ message: string; skill_name: string }> => {
    return fetchWithError(`${getApiUrl()}/personas/${id}/deploy`, {
      method: 'POST',
    });
  },
};

// Session API
export const sessionApi = {
  getAll: async (): Promise<Session[]> => {
    return fetchWithError(`${getApiUrl()}/sessions`);
  },

  get: async (id: string): Promise<Session & { analyses?: Analysis[] }> => {
    return fetchWithError(`${getApiUrl()}/sessions/${id}`);
  },

  startAnalysis: async (id: string): Promise<{ message: string; session_id: string }> => {
    return fetchWithError(`${getApiUrl()}/sessions/${id}/analyze`, {
      method: 'POST',
    });
  },

  retryPersona: async (id: string, personaId: string): Promise<{ message: string; session_id: string; persona_id: string }> => {
    return fetchWithError(`${getApiUrl()}/sessions/${id}/retry`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona_id: personaId }),
    });
  },

  share: async (id: string, emails: string[]): Promise<{ message: string; shared_with: string[] }> => {
    return fetchWithError(`${getApiUrl()}/sessions/${id}/share`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emails }),
    });
  },

  create: async (
    fileName: string,
    fileSize: number,
    fileExtension: string,
    selectedPersonaIds: string[],
    analysisProvider?: string,
    analysisModel?: string,
    workflow?: string,
    analysisConfigJson?: any,
  ): Promise<Session> => {
    return fetchWithError(`${getApiUrl()}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_name: fileName,
        file_size_bytes: fileSize,
        file_extension: fileExtension,
        selected_persona_ids: selectedPersonaIds,
        ...(analysisProvider && analysisModel ? {
          analysis_provider: analysisProvider,
          analysis_model: analysisModel,
        } : {}),
        ...(workflow ? { workflow } : {}),
        ...(analysisConfigJson ? { analysis_config_json: analysisConfigJson } : {}),
      }),
    });
  },

  update: async (id: string, updates: Partial<Session>): Promise<Session> => {
    return fetchWithError(`${getApiUrl()}/sessions/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
  },

  delete: async (id: string): Promise<void> => {
    await fetchWithError(`${getApiUrl()}/sessions/${id}`, {
      method: 'DELETE',
    });
  },

  getArtifacts: async (
    id: string,
    filters?: { persona_id?: string; artifact_type?: string }
  ): Promise<{ session_id: string; artifacts: AnalysisArtifact[] }> => {
    const params = new URLSearchParams();
    if (filters?.persona_id) params.set('persona_id', filters.persona_id);
    if (filters?.artifact_type) params.set('artifact_type', filters.artifact_type);
    const qs = params.toString();
    return fetchWithError(`${getApiUrl()}/sessions/${id}/artifacts${qs ? `?${qs}` : ''}`);
  },
};

// Persona Groups API (role variants)
export const personaGroupApi = {
  list: async (): Promise<any[]> => {
    return fetchWithError(`${getApiUrl()}/persona-groups`);
  },

  get: async (id: string): Promise<any> => {
    return fetchWithError(`${getApiUrl()}/persona-groups/${id}`);
  },

  create: async (data: { role_key: string; name: string; description?: string; base_persona_id?: string }): Promise<any> => {
    return fetchWithError(`${getApiUrl()}/persona-groups`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  },

  addMembers: async (id: string, personaIds: string[]): Promise<any> => {
    return fetchWithError(`${getApiUrl()}/persona-groups/${id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona_ids: personaIds }),
    });
  },

  generateVariants: async (id: string, data: { count: number; base_persona_id?: string; seed_constraints?: any; generator_provider?: string; generator_model?: string }): Promise<any> => {
    return fetchWithError(`${getApiUrl()}/persona-groups/${id}/generate-variants`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  },
};

// Settings API (global backend settings)
export const settingsApi = {
  getAll: async (baseUrl?: string): Promise<Record<string, string>> => {
    const url = baseUrl || getApiUrl();
    return fetchWithError(`${url}/settings`);
  },

  update: async (updates: Record<string, string>, baseUrl?: string): Promise<Record<string, string>> => {
    const url = baseUrl || getApiUrl();
    return fetchWithError(`${url}/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
  },
};

// R2 Upload API
export const r2Api = {
  getUploadUrl: async (sessionId: string, filename: string): Promise<{ uploadUrl: string; method: string }> => {
    return fetchWithError(`${getApiUrl()}/r2/upload-url?session_id=${sessionId}&filename=${encodeURIComponent(filename)}`);
  },

  uploadFile: async (sessionId: string, file: File): Promise<{ success: boolean; key: string; size: number }> => {
    const uploadUrl = `${getApiUrl()}/r2/upload/${sessionId}/${encodeURIComponent(file.name)}`;

    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': file.type || 'application/octet-stream',
      },
      body: await file.arrayBuffer(),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Upload failed: ${error}`);
    }

    return response.json();
  },
};

// WebSocket for streaming analysis
export class AnalysisWebSocket {
  private ws: WebSocket | null = null;
  private sessionId: string;
  private onMessage: (data: any) => void;
  private onError: (error: any) => void;
  private reconnectAttempts = 0;
  private maxReconnects = 3;
  private reconnectTimeouts = [2000, 4000, 8000]; // Exponential backoff
  private analysisStarted = false;
  private analysisComplete = false;

  constructor(
    sessionId: string,
    onMessage: (data: any) => void,
    onError: (error: any) => void
  ) {
    this.sessionId = sessionId;
    this.onMessage = onMessage;
    this.onError = onError;
  }

  connect(): void {
    // Don't reconnect if analysis is complete
    if (this.analysisComplete) {
      return;
    }
    
    const wsUrl = getApiUrl().replace('https://', 'wss://') + `/sessions/${this.sessionId}/analyze`;

    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      // Start analysis only if not already started
      if (!this.analysisStarted) {
        this.analysisStarted = true;
        this.send({ action: 'start_analysis', session_id: this.sessionId });
      }
    };

    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        // Track when analysis is complete
        if (data.type === 'all_complete') {
          this.analysisComplete = true;
        }
        this.onMessage(data);
      } catch (error) {
        this.onError(error);
      }
    };

    this.ws.onerror = (error) => {
      this.onError(error);
    };

    this.ws.onclose = () => {
      // Don't reconnect if analysis is complete
      if (this.analysisComplete) {
        return;
      }
      
      if (this.reconnectAttempts < this.maxReconnects) {
        const timeout = this.reconnectTimeouts[this.reconnectAttempts];
        setTimeout(() => {
          this.reconnectAttempts++;
          this.connect();
        }, timeout);
      }
    };
  }

  send(data: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }

  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

export default {
  clibridgeApi,
  personaApi,
  personaGroupApi,
  sessionApi,
  settingsApi,
  r2Api,
  AnalysisWebSocket,
};
