export interface Persona {
  id: string;
  name: string;
  role: string;
  is_system: boolean;
  status: 'draft' | 'deployed' | 'failed';
  version: string;
  skill_name: string;
  skill_path: string;
  profile_json?: any;
  created_at?: string;
  updated_at?: string;
  deployed_at?: string;
}

export interface Session {
  id: string;
  file_name: string;
  file_r2_key?: string;
  file_size_bytes?: number;
  file_extension?: string;
  selected_persona_ids: string | string[];
  status: 'uploaded' | 'analyzing' | 'completed' | 'failed' | 'partial';
  created_at: string;
  updated_at?: string;
  analyses?: Analysis[];
}

export interface AnalysisScore {
  score: number;
  commentary: string;
}

export interface Analysis {
  id: number;
  session_id: string;
  persona_id: string;
  persona_name?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  score_json?: any;
  top_issues_json?: any;
  rewritten_suggestions_json?: any;
  error_message?: string;
  started_at?: string;
  completed_at?: string;
}

export interface WebSocketMessage {
  type: 'chunk' | 'complete' | 'error' | 'all_complete' | 'status';
  persona_id?: string;
  text?: string;
  result?: any;
  error?: string;
  session_id?: string;
  status?: string;
}
