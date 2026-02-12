import type { Persona, Session, Analysis } from './types';

// Get API URL from environment or fallback
const getApiUrl = () => {
  if (typeof window !== 'undefined') {
    return process.env.NEXT_PUBLIC_API_URL || 'https://roundtable-api.browsium.workers.dev';
  }
  return 'https://roundtable-api.browsium.workers.dev';
};

const API_BASE = getApiUrl();

// Helper for fetch with error handling
async function fetchWithError(url: string, options?: RequestInit): Promise<any> {
  const response = await fetch(url, options);
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`HTTP ${response.status}: ${error}`);
  }
  return response.json();
}

// Persona API
export const personaApi = {
  getAll: async (): Promise<Persona[]> => {
    return fetchWithError(`${API_BASE}/personas`);
  },

  get: async (id: string): Promise<Persona> => {
    return fetchWithError(`${API_BASE}/personas/${id}`);
  },

  create: async (personaData: { profile_json: any }): Promise<Persona> => {
    return fetchWithError(`${API_BASE}/personas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(personaData),
    });
  },

  update: async (id: string, personaData: { profile_json: any }): Promise<Persona> => {
    return fetchWithError(`${API_BASE}/personas/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(personaData),
    });
  },

  delete: async (id: string): Promise<void> => {
    await fetchWithError(`${API_BASE}/personas/${id}`, {
      method: 'DELETE',
    });
  },

  deploy: async (id: string): Promise<{ message: string; skill_name: string }> => {
    return fetchWithError(`${API_BASE}/personas/${id}/deploy`, {
      method: 'POST',
    });
  },
};

// Session API
export const sessionApi = {
  getAll: async (): Promise<Session[]> => {
    return fetchWithError(`${API_BASE}/sessions`);
  },

  get: async (id: string): Promise<Session & { analyses?: Analysis[] }> => {
    return fetchWithError(`${API_BASE}/sessions/${id}`);
  },

  create: async (
    fileName: string,
    fileSize: number,
    fileExtension: string,
    selectedPersonaIds: string[]
  ): Promise<Session> => {
    return fetchWithError(`${API_BASE}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_name: fileName,
        file_size_bytes: fileSize,
        file_extension: fileExtension,
        selected_persona_ids: selectedPersonaIds,
      }),
    });
  },

  update: async (id: string, updates: Partial<Session>): Promise<Session> => {
    return fetchWithError(`${API_BASE}/sessions/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
  },

  delete: async (id: string): Promise<void> => {
    await fetchWithError(`${API_BASE}/sessions/${id}`, {
      method: 'DELETE',
    });
  },
};

// R2 Upload API
export const r2Api = {
  getUploadUrl: async (sessionId: string, filename: string): Promise<{ uploadUrl: string; method: string }> => {
    return fetchWithError(`${API_BASE}/r2/upload-url?session_id=${sessionId}&filename=${encodeURIComponent(filename)}`);
  },

  uploadFile: async (sessionId: string, file: File): Promise<{ success: boolean; key: string; size: number }> => {
    const uploadUrl = `${API_BASE}/r2/upload/${sessionId}/${encodeURIComponent(file.name)}`;
    
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
    const wsUrl = API_BASE.replace('https://', 'wss://') + `/sessions/${this.sessionId}/analyze`;
    
    this.ws = new WebSocket(wsUrl);
    
    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      // Start analysis
      this.send({ action: 'start_analysis', session_id: this.sessionId });
    };
    
    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.onMessage(data);
      } catch (error) {
        this.onError(error);
      }
    };
    
    this.ws.onerror = (error) => {
      this.onError(error);
    };
    
    this.ws.onclose = () => {
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
  personaApi,
  sessionApi,
  r2Api,
  AnalysisWebSocket,
};
