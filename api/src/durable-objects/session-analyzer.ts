import type { Env } from '../index';
import { D1Client } from '../lib/d1';
import { CLIBridgeClient } from '../lib/clibridge';
import { extractTextFromDocument } from '../lib/document-processor';
import { validateAnalysisBackend } from '../lib/analysis-backend';
import JSON5 from 'json5';

interface AnalysisMessage {
  type: 'chunk' | 'complete' | 'error' | 'all_complete' | 'status' | 'activity';
  persona_id?: string;
  text?: string;
  result?: any;
  error?: string;
  session_id?: string;
  status?: string;
  phase?: string;
  message?: string;
  at?: string;
  backend_provider?: string;
  backend_model?: string;
  candidate_id?: string;
  meta?: any;
}

type Backend = { provider: string; model: string };

type Workflow = 'roundtable_standard' | 'roundtable_council' | 'role_variant_discussion';

type AnalysisJobTask =
  | { kind: 'extract_document' }
  | { kind: 'analyze_persona'; persona_id: string }
  | { kind: 'discussion_generate_tasks' }
  | { kind: 'discussion_critique'; from_persona_id: string; target_persona_id: string }
  | { kind: 'discussion_chair' }
  | { kind: 'finalize' };

type AnalysisJobState = {
  session_id: string;
  file_r2_key: string;
  file_extension: string;
  workflow: Workflow;
  persona_ids: string[];
  // Stored after extraction (truncated for analysis).
  document_text: string;
  document_excerpt: string;
  // Standard workflow.
  roundtable_backend?: Backend;
  // Council workflow.
  council?: { members: Backend[]; reviewer: Backend; chair: Backend };
  // Role-variant discussion workflow.
  discussion?: {
    persona_group_id: string;
    variant_backend: Backend;
    chair_backend: Backend;
    variant_persona_ids: string[];
  };
  tasks: AnalysisJobTask[];
  created_at: string;
  updated_at: string;
};

const JOB_STORAGE_KEY = 'analysis_job_v1';

type CLIBridgeUsage = {
  input_tokens?: number;
  output_tokens?: number;
  cost_usd?: number;
};

type CLIBridgeCompletionMeta = {
  provider?: string;
  model?: string;
  session_id?: string;
  usage?: CLIBridgeUsage;
  duration_ms?: number;
};

type CLIBridgeCompletion = {
  text: string;
  meta: CLIBridgeCompletionMeta | null;
};

export class SessionAnalyzer {
  private state: DurableObjectState;
  private env: Env;
  private websockets: Set<WebSocket> = new Set();
  private analysisStarted: boolean = false;
  private websocketViewerEmails: Map<WebSocket, string> = new Map();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }

    // Handle direct analysis trigger
    if (request.method === 'POST' && url.pathname === '/start') {
      let body: any;
      try {
        body = await request.json();
      } catch {
        return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const sessionId = typeof body?.session_id === 'string' ? body.session_id.trim() : '';
      if (!sessionId) {
        return new Response(JSON.stringify({ error: 'session_id is required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Start asynchronously; the alarm will do the heavy work.
      this.state.waitUntil(this.startAnalysis(sessionId));
      return new Response(JSON.stringify({ message: 'Analysis started' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Retry a failed persona analysis.
    if (request.method === 'POST' && url.pathname === '/retry') {
      const body = await request.json() as { session_id?: string; persona_id?: string };
      const sessionId = typeof body?.session_id === 'string' ? body.session_id : '';
      const personaId = typeof body?.persona_id === 'string' ? body.persona_id : '';
      if (!sessionId || !personaId) {
        return new Response(JSON.stringify({ error: 'session_id and persona_id are required' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Run asynchronously and broadcast updates over any connected websockets.
      this.state.waitUntil(this.retryPersonaAnalysis(sessionId, personaId));
      return new Response(JSON.stringify({ message: 'Retry started', session_id: sessionId, persona_id: personaId }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }

  private broadcastToAll(msg: any): void {
    const payload = JSON.stringify(msg);
    this.websockets.forEach((socket) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      }
    });
  }

  private async getJob(): Promise<AnalysisJobState | null> {
    const job = await this.state.storage.get<AnalysisJobState>(JOB_STORAGE_KEY);
    return job || null;
  }

  private async putJob(job: AnalysisJobState | null): Promise<void> {
    if (!job) {
      await this.state.storage.delete(JOB_STORAGE_KEY);
      this.analysisStarted = false;
      return;
    }
    await this.state.storage.put(JOB_STORAGE_KEY, job);
    this.analysisStarted = true;
  }

  private async scheduleAlarmSoon(delayMs: number = 50): Promise<void> {
    await this.state.storage.setAlarm(Date.now() + delayMs);
  }

  async alarm(): Promise<void> {
    const job = await this.getJob();
    if (!job) return;

    const sendMessage = (msg: any) => this.broadcastToAll(msg);
    const db = new D1Client(this.env.DB);

    const task = job.tasks.shift();
    if (!task) {
      await this.putJob(null);
      return;
    }

    job.updated_at = new Date().toISOString();
    await this.putJob(job);

    try {
      await this.runJobTask(job, task, db, sendMessage);
    } catch (e) {
      const err = String(e);
      console.error(`Job task failed for session ${job.session_id}:`, err);
      sendMessage({ type: 'error', error: err, session_id: job.session_id });
      try {
        await db.updateSession(job.session_id, { error_message: err } as any);
      } catch {
        // ignore
      }
    }

    const updated = await this.getJob();
    if (updated && updated.tasks.length > 0) {
      await this.scheduleAlarmSoon(50);
      return;
    }
    if (updated && updated.tasks.length === 0) {
      await this.putJob(null);
    }
  }

  private async failAllPendingAnalyses(sessionId: string, db: D1Client, errorMessage: string): Promise<void> {
    const analyses = await db.getAnalyses(sessionId);
    for (const a of analyses) {
      if (a.status === 'pending' || a.status === 'running') {
        await db.updateAnalysis(a.id, {
          status: 'failed',
          error_message: errorMessage,
          completed_at: new Date().toISOString(),
        });
      }
    }
  }

  private async runJobTask(
    job: AnalysisJobState,
    task: AnalysisJobTask,
    db: D1Client,
    sendMessage: (msg: any) => void
  ): Promise<void> {
    switch (task.kind) {
      case 'extract_document':
        await this.jobExtractDocument(job, db, sendMessage);
        return;
      case 'analyze_persona':
        await this.jobAnalyzePersona(job, task.persona_id, db, sendMessage);
        return;
      case 'discussion_generate_tasks':
        await this.jobDiscussionGenerateTasks(job, db, sendMessage);
        return;
      case 'discussion_critique':
        await this.jobDiscussionCritique(job, task.from_persona_id, task.target_persona_id, db, sendMessage);
        return;
      case 'discussion_chair':
        await this.jobDiscussionChair(job, db, sendMessage);
        return;
      case 'finalize':
        await this.jobFinalize(job, db, sendMessage);
        return;
      default: {
        const _exhaustive: never = task;
        throw new Error(`Unhandled job task kind: ${(task as any)?.kind}`);
      }
    }
  }

  private async jobExtractDocument(job: AnalysisJobState, db: D1Client, sendMessage: (msg: any) => void): Promise<void> {
    const sessionId = job.session_id;
    sendMessage({
      type: 'activity',
      session_id: sessionId,
      phase: 'extract_document',
      message: 'Extracting text from document...',
      at: new Date().toISOString(),
    });
    const r2Key = (job.file_r2_key || '').trim();
    if (!r2Key) {
      const err = 'Missing document storage key';
      sendMessage({ type: 'error', error: err, session_id: sessionId });
      await db.updateSession(sessionId, { status: 'failed', error_message: err } as any);
      await this.failAllPendingAnalyses(sessionId, db, err);
      sendMessage({ type: 'all_complete', session_id: sessionId });
      sendMessage({ type: 'status', session_id: sessionId, status: 'failed' });
      await this.putJob(null);
      return;
    }

    const r2Object = await this.env.R2.get(r2Key);
    if (!r2Object) {
      const err = 'Document not found in storage';
      sendMessage({ type: 'error', error: err, session_id: sessionId });
      await db.updateSession(sessionId, { status: 'failed', error_message: err } as any);
      await this.failAllPendingAnalyses(sessionId, db, err);
      sendMessage({ type: 'all_complete', session_id: sessionId });
      sendMessage({ type: 'status', session_id: sessionId, status: 'failed' });
      await this.putJob(null);
      return;
    }

    const fileBuffer = await r2Object.arrayBuffer();
    console.log(`Extracting text from document, buffer size: ${fileBuffer.byteLength} bytes`);
    const extractedDoc = await extractTextFromDocument(fileBuffer, job.file_extension);
    const documentText = extractedDoc.text || '';
    console.log(`Extracted document text, length: ${documentText.length}`);

    // Check if extraction returned an error message
    if (documentText.startsWith('[') && documentText.includes('document:') && documentText.includes('error')) {
      const err = 'Failed to process document: ' + documentText;
      console.warn('Document extraction appears to have failed, sending error to frontend');
      sendMessage({ type: 'error', error: err, session_id: sessionId });
      await db.updateSession(sessionId, { status: 'failed', error_message: err } as any);
      await this.failAllPendingAnalyses(sessionId, db, err);
      sendMessage({ type: 'all_complete', session_id: sessionId });
      sendMessage({ type: 'status', session_id: sessionId, status: 'failed' });
      await this.putJob(null);
      return;
    }

    // Store truncated text for downstream model calls.
    const MAX_DOC_CHARS = 8000;
    const documentForAnalysis = documentText.length > MAX_DOC_CHARS ? documentText.slice(0, MAX_DOC_CHARS) : documentText;
    if (documentText.length > MAX_DOC_CHARS) {
      console.log(`Truncated document text for session ${sessionId}: ${documentText.length} -> ${documentForAnalysis.length} chars`);
    }

    job.document_text = documentForAnalysis;
    job.document_excerpt = documentText.slice(0, 2000);
    job.updated_at = new Date().toISOString();
    await this.putJob(job);

    sendMessage({
      type: 'activity',
      session_id: sessionId,
      phase: 'extract_document_done',
      message: `Document text extracted (${documentText.length.toLocaleString()} chars, sent ${documentForAnalysis.length.toLocaleString()} chars)`,
      at: new Date().toISOString(),
    });
  }

  private async jobAnalyzePersona(
    job: AnalysisJobState,
    personaId: string,
    db: D1Client,
    sendMessage: (msg: any) => void
  ): Promise<void> {
    const sessionId = job.session_id;
    if (!job.document_text) {
      throw new Error('Document text not available (extract_document has not completed)');
    }

    const persona = await db.getPersona(personaId);
    if (!persona) {
      const err = `Persona not found: ${personaId}`;
      sendMessage({ type: 'error', persona_id: personaId, error: err });
      const analyses = await db.getAnalyses(sessionId);
      const analysis = analyses.find((a) => a.persona_id === personaId);
      if (analysis) {
        await db.updateAnalysis(analysis.id, {
          status: 'failed',
          error_message: err,
          completed_at: new Date().toISOString(),
        });
      }
      return;
    }

    const idx = job.persona_ids.indexOf(personaId);
    const position = idx >= 0 ? idx + 1 : 0;
    const total = job.persona_ids.length;
    sendMessage({
      type: 'activity',
      session_id: sessionId,
      persona_id: persona.id,
      phase: 'persona_start',
      message: `${position > 0 && total > 0 ? `Persona ${position}/${total}: ` : ''}${persona.name} (${persona.role})`,
      at: new Date().toISOString(),
    });

    if (job.workflow === 'roundtable_council') {
      if (!job.council) throw new Error('Missing council workflow configuration');
      await this.analyzePersonaCouncil(sessionId, persona, job.document_text, sendMessage, db, job.council);
      return;
    }

    if (job.workflow === 'role_variant_discussion') {
      if (!job.discussion) throw new Error('Missing discussion workflow configuration');
      await this.analyzePersona(sessionId, persona, job.document_text, sendMessage, db, job.discussion.variant_backend);
      return;
    }

    if (!job.roundtable_backend) throw new Error('Missing roundtable backend configuration');
    await this.analyzePersona(sessionId, persona, job.document_text, sendMessage, db, job.roundtable_backend);
  }

  private async jobDiscussionGenerateTasks(job: AnalysisJobState, db: D1Client, _sendMessage: (msg: any) => void): Promise<void> {
    if (job.workflow !== 'role_variant_discussion' || !job.discussion) {
      return;
    }

    const sessionId = job.session_id;
    const variantIds = Array.isArray(job.discussion.variant_persona_ids) && job.discussion.variant_persona_ids.length > 0
      ? job.discussion.variant_persona_ids
      : job.persona_ids;

    const analyses = await db.getAnalyses(sessionId);
    const completed = new Set(
      analyses
        .filter((a) => a.status === 'completed')
        .map((a) => String(a.persona_id))
    );

    const completedVariantIds = variantIds.filter((id) => completed.has(String(id)));

    if (completedVariantIds.length === 0) {
      await db.createAnalysisArtifact({
        session_id: sessionId,
        persona_id: 'discussion',
        artifact_type: 'discussion_chair_error',
        backend_provider: job.discussion.chair_backend.provider,
        backend_model: job.discussion.chair_backend.model,
        content_json: JSON.stringify({ error: 'No completed variant analyses available for discussion synthesis' }),
      } as any);
      return;
    }

    const newTasks: AnalysisJobTask[] = [];
    if (completedVariantIds.length >= 2) {
      for (const fromId of completedVariantIds) {
        for (const targetId of completedVariantIds) {
          if (targetId === fromId) continue;
          newTasks.push({ kind: 'discussion_critique', from_persona_id: fromId, target_persona_id: targetId });
        }
      }
    }

    // Always attempt a chair synthesis when at least one candidate exists.
    newTasks.push({ kind: 'discussion_chair' });

    // Insert before any remaining tasks (typically just finalize).
    job.tasks = newTasks.concat(job.tasks);
    job.updated_at = new Date().toISOString();
    await this.putJob(job);
  }

  private async jobDiscussionCritique(
    job: AnalysisJobState,
    fromPersonaId: string,
    targetPersonaId: string,
    db: D1Client,
    sendMessage: (msg: any) => void
  ): Promise<void> {
    if (!job.discussion) throw new Error('Missing discussion workflow configuration');

    const sessionId = job.session_id;
    const fromPersona = await db.getPersona(fromPersonaId);
    const targetPersona = await db.getPersona(targetPersonaId);

    const artifactBase = {
      session_id: sessionId,
      persona_id: fromPersonaId,
      artifact_type: 'discussion_critique',
      backend_provider: job.discussion.variant_backend.provider,
      backend_model: job.discussion.variant_backend.model,
    };

    if (!fromPersona || !targetPersona) {
      const payload = {
        from_persona_id: fromPersonaId,
        target_persona_id: targetPersonaId,
        error: `Missing persona(s): from=${!!fromPersona} target=${!!targetPersona}`,
      };
      await db.createAnalysisArtifact({ ...(artifactBase as any), content_json: JSON.stringify(payload) } as any);
      return;
    }

    const analyses = await db.getAnalyses(sessionId);
    const targetAnalysis = analyses.find((a) => a.persona_id === targetPersonaId);
    if (!targetAnalysis || targetAnalysis.status !== 'completed') {
      const payload = {
        from_persona_id: fromPersonaId,
        target_persona_id: targetPersonaId,
        error: 'Target analysis not completed',
      };
      await db.createAnalysisArtifact({ ...(artifactBase as any), content_json: JSON.stringify(payload) } as any);
      return;
    }

    let score: any = null;
    let issues: any = null;
    let suggestions: any = null;
    try { score = targetAnalysis.score_json ? (typeof targetAnalysis.score_json === 'string' ? JSON.parse(targetAnalysis.score_json) : targetAnalysis.score_json) : null; } catch {}
    try { issues = targetAnalysis.top_issues_json ? (typeof targetAnalysis.top_issues_json === 'string' ? JSON.parse(targetAnalysis.top_issues_json) : targetAnalysis.top_issues_json) : null; } catch {}
    try { suggestions = targetAnalysis.rewritten_suggestions_json ? (typeof targetAnalysis.rewritten_suggestions_json === 'string' ? JSON.parse(targetAnalysis.rewritten_suggestions_json) : targetAnalysis.rewritten_suggestions_json) : null; } catch {}

    const targetCandidate = {
      persona_id: targetPersona.id,
      name: targetPersona.name,
      role: targetPersona.role,
      dimension_scores: score,
      top_3_issues: issues,
      feedback: suggestions,
    };

    const MAX_TARGET_JSON_CHARS = 6000;
    try {
      sendMessage({
        type: 'activity',
        session_id: sessionId,
        persona_id: fromPersonaId,
        phase: 'discussion_critique_start',
        backend_provider: job.discussion.variant_backend.provider,
        backend_model: job.discussion.variant_backend.model,
        message: `Focus group critique: ${fromPersona.name} -> ${targetPersona.name}`,
        at: new Date().toISOString(),
      });

      const critiqueCompletion = await this.clibridgeComplete({
        provider: job.discussion.variant_backend.provider,
        model: job.discussion.variant_backend.model,
        systemPrompt: this.buildDiscussionCritiquePrompt(fromPersona),
        messages: [{
          role: 'user',
          content: JSON.stringify({
            target_persona_id: targetPersonaId,
            target_analysis: targetCandidate,
          }).slice(0, MAX_TARGET_JSON_CHARS),
        }],
      });

      const critiqueMeta = critiqueCompletion.meta;
      const critiqueJson = this.parseJsonFlexible(critiqueCompletion.text);
      const payload = {
        from_persona_id: fromPersonaId,
        target_persona_id: targetPersonaId,
        meta: critiqueMeta || null,
        critique: critiqueJson,
      };
      await db.createAnalysisArtifact({ ...(artifactBase as any), content_json: JSON.stringify(payload) } as any);

      sendMessage({
        type: 'activity',
        session_id: sessionId,
        persona_id: fromPersonaId,
        phase: 'discussion_critique_done',
        backend_provider: job.discussion.variant_backend.provider,
        backend_model: job.discussion.variant_backend.model,
        meta: critiqueMeta || null,
        message: `Focus group critique done: ${fromPersona.name} -> ${targetPersona.name}`,
        at: new Date().toISOString(),
      });
    } catch (e) {
      const payload = {
        from_persona_id: fromPersonaId,
        target_persona_id: targetPersonaId,
        error: String(e),
      };
      await db.createAnalysisArtifact({ ...(artifactBase as any), content_json: JSON.stringify(payload) } as any);

      sendMessage({
        type: 'activity',
        session_id: sessionId,
        persona_id: fromPersonaId,
        phase: 'discussion_critique_error',
        backend_provider: job.discussion.variant_backend.provider,
        backend_model: job.discussion.variant_backend.model,
        message: `Focus group critique error: ${String(e)}`,
        at: new Date().toISOString(),
      });
    }
  }

  private async jobDiscussionChair(job: AnalysisJobState, db: D1Client, sendMessage: (msg: any) => void): Promise<void> {
    if (!job.discussion) throw new Error('Missing discussion workflow configuration');

    const sessionId = job.session_id;
    const variantIds = Array.isArray(job.discussion.variant_persona_ids) && job.discussion.variant_persona_ids.length > 0
      ? job.discussion.variant_persona_ids
      : job.persona_ids;

    const variants: any[] = [];
    for (const id of variantIds) {
      const p = await db.getPersona(String(id));
      if (p) variants.push(p);
    }
    if (variants.length === 0) {
      await db.createAnalysisArtifact({
        session_id: sessionId,
        persona_id: 'discussion',
        artifact_type: 'discussion_chair_error',
        backend_provider: job.discussion.chair_backend.provider,
        backend_model: job.discussion.chair_backend.model,
        content_json: JSON.stringify({ error: 'No variant personas found for discussion synthesis' }),
      } as any);
      return;
    }

    const analyses = await db.getAnalyses(sessionId);
    const byPersona: Record<string, any> = {};
    for (const a of analyses) {
      if (!a.persona_id) continue;
      byPersona[a.persona_id] = a;
    }

    const candidates: any[] = [];
    for (const v of variants) {
      const a = byPersona[v.id];
      if (!a || a.status !== 'completed') continue;

      let score: any = null;
      let issues: any = null;
      let suggestions: any = null;
      try { score = a.score_json ? (typeof a.score_json === 'string' ? JSON.parse(a.score_json) : a.score_json) : null; } catch {}
      try { issues = a.top_issues_json ? (typeof a.top_issues_json === 'string' ? JSON.parse(a.top_issues_json) : a.top_issues_json) : null; } catch {}
      try { suggestions = a.rewritten_suggestions_json ? (typeof a.rewritten_suggestions_json === 'string' ? JSON.parse(a.rewritten_suggestions_json) : a.rewritten_suggestions_json) : null; } catch {}

      candidates.push({
        persona_id: v.id,
        name: v.name,
        role: v.role,
        dimension_scores: score,
        top_3_issues: issues,
        feedback: suggestions,
      });
    }

    if (candidates.length === 0) {
      await db.createAnalysisArtifact({
        session_id: sessionId,
        persona_id: 'discussion',
        artifact_type: 'discussion_chair_error',
        backend_provider: job.discussion.chair_backend.provider,
        backend_model: job.discussion.chair_backend.model,
        content_json: JSON.stringify({ error: 'No completed variant analyses available for discussion synthesis' }),
      } as any);
      return;
    }

    const critiqueArtifacts = await db.getAnalysisArtifacts(sessionId, { artifact_type: 'discussion_critique' });
    const critiques: any[] = [];
    for (const a of critiqueArtifacts) {
      const raw = (a as any)?.content_json;
      if (raw == null) continue;
      if (typeof raw === 'object') {
        critiques.push(raw);
        continue;
      }
      if (typeof raw === 'string') {
        try {
          critiques.push(this.parseJsonFlexible(raw));
        } catch {
          critiques.push(raw);
        }
      }
    }

    const role = String(variants[0]?.role || 'Role').trim() || 'Role';
    let chairJson: any;
    let chairMeta: CLIBridgeCompletionMeta | null = null;
    try {
      sendMessage({
        type: 'activity',
        session_id: sessionId,
        persona_id: 'discussion',
        phase: 'discussion_chair_start',
        backend_provider: job.discussion.chair_backend.provider,
        backend_model: job.discussion.chair_backend.model,
        message: `Focus group chairman: ${job.discussion.chair_backend.provider}/${job.discussion.chair_backend.model}`,
        at: new Date().toISOString(),
      });

      const chairCompletion = await this.clibridgeComplete({
        provider: job.discussion.chair_backend.provider,
        model: job.discussion.chair_backend.model,
        systemPrompt: this.buildDiscussionChairPrompt(role),
        messages: [{
          role: 'user',
          content: JSON.stringify({
            persona_group_id: job.discussion.persona_group_id || null,
            candidates,
            critiques,
            doc_excerpt: job.document_excerpt || '',
          }),
        }],
      });
      chairMeta = chairCompletion.meta;
      chairJson = this.parseJsonFlexible(chairCompletion.text);

      sendMessage({
        type: 'activity',
        session_id: sessionId,
        persona_id: 'discussion',
        phase: 'discussion_chair_done',
        backend_provider: job.discussion.chair_backend.provider,
        backend_model: job.discussion.chair_backend.model,
        meta: chairMeta || null,
        message: 'Focus group chairman synthesis done',
        at: new Date().toISOString(),
      });
    } catch (e) {
      const err = String(e);
      console.error('Discussion chair synthesis failed:', err);
      await db.createAnalysisArtifact({
        session_id: sessionId,
        persona_id: 'discussion',
        artifact_type: 'discussion_chair_error',
        backend_provider: job.discussion.chair_backend.provider,
        backend_model: job.discussion.chair_backend.model,
        content_json: JSON.stringify({ error: err }),
      } as any);

      sendMessage({
        type: 'activity',
        session_id: sessionId,
        persona_id: 'discussion',
        phase: 'discussion_chair_error',
        backend_provider: job.discussion.chair_backend.provider,
        backend_model: job.discussion.chair_backend.model,
        message: `Focus group chairman error: ${err}`,
        at: new Date().toISOString(),
      });
      return;
    }

    const finalObj = chairJson?.final;
    const dissents = Array.isArray(chairJson?.dissents) ? chairJson.dissents : [];
    if (!finalObj || typeof finalObj !== 'object') {
      await db.createAnalysisArtifact({
        session_id: sessionId,
        persona_id: 'discussion',
        artifact_type: 'discussion_chair_error',
        backend_provider: job.discussion.chair_backend.provider,
        backend_model: job.discussion.chair_backend.model,
        content_json: JSON.stringify({ error: 'Discussion chair did not return a valid final object' }),
      } as any);
      return;
    }

    const normalizedFinal = this.normalizeResult(finalObj, variants[0]);

    await db.createAnalysisArtifact({
      session_id: sessionId,
      persona_id: 'discussion',
      artifact_type: 'discussion_chair_final',
      backend_provider: job.discussion.chair_backend.provider,
      backend_model: job.discussion.chair_backend.model,
      content_json: JSON.stringify({ persona_group_id: job.discussion.persona_group_id || null, meta: chairMeta || null, final: normalizedFinal }),
    } as any);

    await db.createAnalysisArtifact({
      session_id: sessionId,
      persona_id: 'discussion',
      artifact_type: 'discussion_dissents',
      backend_provider: job.discussion.chair_backend.provider,
      backend_model: job.discussion.chair_backend.model,
      content_json: JSON.stringify({ persona_group_id: job.discussion.persona_group_id || null, meta: chairMeta || null, dissents }),
    } as any);

    sendMessage({ type: 'complete', persona_id: 'discussion', result: { final: normalizedFinal, dissents } });
  }

  private async jobFinalize(job: AnalysisJobState, db: D1Client, sendMessage: (msg: any) => void): Promise<void> {
    const sessionId = job.session_id;
    sendMessage({
      type: 'activity',
      session_id: sessionId,
      phase: 'finalize',
      message: 'Finalizing results...',
      at: new Date().toISOString(),
    });
    sendMessage({ type: 'all_complete', session_id: sessionId });
    await this.updateSessionFinalStatus(sessionId, db, sendMessage);
    await this.putJob(null);
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    
    this.websockets.add(server);
    const viewerEmail = request.headers.get('CF-Access-Authenticated-User-Email') || 'anonymous';
    this.websocketViewerEmails.set(server, viewerEmail);
    
    server.accept();
    
    server.addEventListener('message', async (event) => {
      try {
        const data = JSON.parse(event.data as string);
        
        if (data.action === 'start_analysis') {
          // Only the session owner may start analysis.
          await this.startAnalysis(data.session_id, server, viewerEmail, true);
        }
      } catch (error) {
        server.send(JSON.stringify({
          type: 'error',
          error: 'Invalid message format',
        }));
      }
    });
    
    server.addEventListener('close', () => {
      this.websockets.delete(server);
      this.websocketViewerEmails.delete(server);
    });
    
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async startAnalysis(sessionId: string, ws?: WebSocket, requesterEmail?: string, requireOwner: boolean = false): Promise<void> {
    const db = new D1Client(this.env.DB);

    const sendMessage = (msg: any) => {
      // Send to specific WebSocket if provided and open
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
        return;
      }

      // Otherwise broadcast to all connected websockets (excluding the specific one if it exists)
      this.websockets.forEach((socket) => {
        if (socket !== ws && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(msg));
        }
      });
    };

    await this.state.blockConcurrencyWhile(async () => {
      const existingJob = await this.getJob();
      if (existingJob && existingJob.session_id === sessionId) {
        console.log(`Analysis job already queued for session ${sessionId}; ensuring alarm is scheduled`);
        await this.scheduleAlarmSoon(50);
        this.analysisStarted = true;
        return;
      }

      const session = await db.getSession(sessionId);
      if (!session) {
        sendMessage({ type: 'error', error: 'Session not found' });
        return;
      }

      if (requireOwner) {
        const email = requesterEmail || 'anonymous';
        if (session.user_email !== email) {
          sendMessage({ type: 'error', error: 'Only the owner can start analysis' });
          return;
        }
      }

      if (session.status && session.status !== 'uploaded') {
        console.log(`Session ${sessionId} is already ${session.status}; refusing to start a new analysis`);
        return;
      }

      const workflowRaw = (session.workflow || '').trim().toLowerCase();
      const workflow: Workflow = (workflowRaw === 'roundtable_council' || workflowRaw === 'role_variant_discussion' || workflowRaw === 'roundtable_standard')
        ? (workflowRaw as Workflow)
        : 'roundtable_standard';

      let analysisConfig: any = {};
      const rawConfig = (session.analysis_config_json || '').trim();
      if (rawConfig) {
        try {
          analysisConfig = JSON.parse(rawConfig);
        } catch (e) {
          console.warn(`Invalid analysis_config_json for session ${sessionId}; ignoring.`, e);
        }
      }

      // Choose provider/model for this session:
      // 1) session-scoped override (preferred)
      // 2) global settings (fallback)
      // 3) hard-coded default (last resort)
      const DEFAULT_ANALYSIS_PROVIDER = 'claude';
      const DEFAULT_ANALYSIS_MODEL = 'sonnet';

      const sessionProvider = (session.analysis_provider || '').trim();
      const sessionModel = (session.analysis_model || '').trim();

      const configuredProvider = (await db.getSettingValue('analysis_provider'))?.trim();
      const configuredModel = (await db.getSettingValue('analysis_model'))?.trim();

      const analysisBackend = (sessionProvider && sessionModel)
        ? { provider: sessionProvider, model: sessionModel }
        : {
          provider: configuredProvider || DEFAULT_ANALYSIS_PROVIDER,
          model: configuredModel || DEFAULT_ANALYSIS_MODEL,
        };

      const backendValidation = validateAnalysisBackend(this.env, analysisBackend.provider, analysisBackend.model);
      if (!backendValidation.ok) {
        const errorMessage = backendValidation.error;
        sendMessage({ type: 'error', error: errorMessage });
        await db.updateSession(sessionId, { status: 'failed', error_message: errorMessage } as any);
        await this.failAllPendingAnalyses(sessionId, db, errorMessage);
        sendMessage({ type: 'all_complete', session_id: sessionId });
        sendMessage({ type: 'status', session_id: sessionId, status: 'failed' });
        return;
      }

      const validatedBackend = backendValidation.backend;

      const parseBackend = (v: any): Backend | null => {
        if (!v || typeof v !== 'object') return null;
        const provider = typeof v.provider === 'string' ? v.provider.trim() : '';
        const model = typeof v.model === 'string' ? v.model.trim() : '';
        if (!provider || !model) return null;
        const validation = validateAnalysisBackend(this.env, provider, model);
        if (!validation.ok) return null;
        return validation.backend;
      };

      // Workflow plan
      let sessionDisplayBackend: Backend = validatedBackend;
      let roundtableBackend: Backend = validatedBackend;
      let councilCfg: AnalysisJobState['council'] | undefined;
      let discussionCfg: AnalysisJobState['discussion'] | undefined;

      if (workflow === 'roundtable_council') {
        const council = (analysisConfig && typeof analysisConfig === 'object')
          ? ((analysisConfig.council && typeof analysisConfig.council === 'object') ? analysisConfig.council : analysisConfig)
          : {};

        const membersRaw = Array.isArray(council.members) ? council.members : [];
        const members: Backend[] = [];
        for (const m of membersRaw) {
          const b = parseBackend(m);
          if (b) members.push(b);
        }

        const chair = parseBackend(council.chair_backend || council.chair) || validatedBackend;
        const reviewer = parseBackend(council.reviewer_backend || council.reviewer) || chair;
        councilCfg = { members: members.length > 0 ? members : [validatedBackend], reviewer, chair };
        sessionDisplayBackend = chair;
      } else if (workflow === 'role_variant_discussion') {
        const discussion = (analysisConfig && typeof analysisConfig === 'object')
          ? ((analysisConfig.discussion && typeof analysisConfig.discussion === 'object') ? analysisConfig.discussion : analysisConfig)
          : {};

        const variantBackend = parseBackend(discussion.variant_backend || discussion.variant) || validatedBackend;
        const chairBackend = parseBackend(discussion.chair_backend || discussion.chair) || validatedBackend;
        const groupId = typeof discussion.persona_group_id === 'string' ? discussion.persona_group_id.trim() : '';
        discussionCfg = {
          persona_group_id: groupId,
          variant_backend: variantBackend,
          chair_backend: chairBackend,
          variant_persona_ids: [],
        };
        sessionDisplayBackend = chairBackend;
      } else {
        roundtableBackend = validatedBackend;
        sessionDisplayBackend = validatedBackend;
      }

      // Parse selected personas
      let selectedPersonaIds: string[] = [];
      try {
        const ids = JSON.parse(session.selected_persona_ids || '[]');
        if (Array.isArray(ids)) {
          selectedPersonaIds = ids.map((id) => String(id)).filter(Boolean);
        }
      } catch {
        selectedPersonaIds = [];
      }

      if (discussionCfg) {
        discussionCfg.variant_persona_ids = selectedPersonaIds;
      }

      if (selectedPersonaIds.length === 0) {
        const errorMessage = 'No valid personas found';
        sendMessage({ type: 'error', error: errorMessage });
        await db.updateSession(sessionId, { status: 'failed', error_message: errorMessage } as any);
        await this.failAllPendingAnalyses(sessionId, db, errorMessage);
        sendMessage({ type: 'all_complete', session_id: sessionId });
        sendMessage({ type: 'status', session_id: sessionId, status: 'failed' });
        return;
      }

      console.log(`Queueing analysis job for session ${sessionId}:`, { workflow, sessionBackend: sessionDisplayBackend });

      await db.updateSession(sessionId, {
        status: 'analyzing',
        analysis_provider: sessionDisplayBackend.provider,
        analysis_model: sessionDisplayBackend.model,
        error_message: null as any,
      } as any);
      sendMessage({ type: 'status', session_id: sessionId, status: 'analyzing' });

      const now = new Date().toISOString();
      const tasks: AnalysisJobTask[] = [
        { kind: 'extract_document' },
        ...selectedPersonaIds.map((id) => ({ kind: 'analyze_persona', persona_id: id }) as AnalysisJobTask),
        ...(workflow === 'role_variant_discussion' ? ([{ kind: 'discussion_generate_tasks' }] as AnalysisJobTask[]) : []),
        { kind: 'finalize' },
      ];

      const job: AnalysisJobState = {
        session_id: sessionId,
        file_r2_key: session.file_r2_key,
        file_extension: session.file_extension,
        workflow,
        persona_ids: selectedPersonaIds,
        document_text: '',
        document_excerpt: '',
        ...(workflow === 'roundtable_council'
          ? { council: councilCfg || { members: [validatedBackend], reviewer: validatedBackend, chair: validatedBackend } }
          : {}),
        ...(workflow === 'role_variant_discussion'
          ? { discussion: discussionCfg || { persona_group_id: '', variant_backend: validatedBackend, chair_backend: validatedBackend, variant_persona_ids: selectedPersonaIds } }
          : {}),
        ...(workflow === 'roundtable_standard' ? { roundtable_backend: roundtableBackend } : {}),
        tasks,
        created_at: now,
        updated_at: now,
      };

      await this.putJob(job);
      await this.scheduleAlarmSoon(50);
      this.analysisStarted = true;
    });
  }

  private extractFirstJsonValue(text: string): string | null {
    const s = (text || '').trim();
    const start = s.search(/[\[{]/);
    if (start === -1) return null;

    const stack: string[] = [];
    let inString = false;
    let quote = '';
    let escape = false;

    for (let i = start; i < s.length; i++) {
      const ch = s[i];

      if (inString) {
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === '\\\\') {
          escape = true;
          continue;
        }
        if (ch === quote) {
          inString = false;
          quote = '';
        }
        continue;
      }

      if (ch === '"' || ch === "'") {
        inString = true;
        quote = ch;
        continue;
      }

      if (ch === '{' || ch === '[') {
        stack.push(ch);
        continue;
      }

      if (ch === '}' || ch === ']') {
        const open = stack[stack.length - 1];
        const matches = (open === '{' && ch === '}') || (open === '[' && ch === ']');
        if (!matches) continue;
        stack.pop();
        if (stack.length === 0) {
          return s.slice(start, i + 1);
        }
      }
    }

    return null;
  }

  private parseJsonFlexible(text: string): any {
    const trimmed = (text || '').trim();
    if (!trimmed) throw new Error('Empty response');

    const candidates: string[] = [];

    // 1) Any fenced blocks (many models ignore "no markdown" instructions).
    const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
    let m: RegExpExecArray | null;
    while ((m = fenceRegex.exec(trimmed)) !== null) {
      const inner = (m[1] || '').trim();
      if (inner) candidates.push(inner);
    }

    // 2) First balanced JSON value in the response (handles leading/trailing commentary).
    const extracted = this.extractFirstJsonValue(trimmed);
    if (extracted) candidates.unshift(extracted);

    // 3) Full response last.
    candidates.push(trimmed);

    for (const c of candidates) {
      try {
        return JSON.parse(c);
      } catch {
        // continue
      }
      try {
        return JSON5.parse(c);
      } catch {
        // continue
      }
    }

    throw new Error('Failed to parse JSON result');
  }

  private fallbackResultFromText(text: string, persona: any): any {
    return this.normalizeResult(
      {
        persona_role: persona?.role || 'Unknown Persona',
        overall_score: 0,
        dimension_scores: {},
        top_3_issues: [],
        what_works_well: [],
        overall_verdict: text || 'No response received',
        rewritten_headline_suggestion: '',
      },
      persona
    );
  }

  private async parseRoundtableResultFromText(fullResponse: string, persona: any): Promise<any> {
    const result = this.parseJsonFlexible(fullResponse);
    return this.normalizeResult(result, persona);
  }

  private async clibridgeComplete(req: { provider: string; model: string; systemPrompt: string; messages: Array<{ role: string; content: string }> }): Promise<CLIBridgeCompletion> {
    const clibridge = new CLIBridgeClient(this.env);
    const resp = await clibridge.completeAnalysis(req);
    if (!resp.ok) {
      const errorText = await resp.text().catch(() => '');
      throw new Error(`CLIBridge complete returned ${resp.status}: ${resp.statusText} - ${errorText.substring(0, 200)}`);
    }
    const raw = await resp.text();
    return this.extractCompletionPayload(raw);
  }

  private async clibridgeCompleteText(req: { provider: string; model: string; systemPrompt: string; messages: Array<{ role: string; content: string }> }): Promise<string> {
    const { text } = await this.clibridgeComplete(req);
    return text;
  }

  private buildCouncilReviewPrompt(persona: any): string {
    const profile = JSON.parse(persona.profile_json);
    return `You are a strict reviewer helping select the best candidate analysis for a ${profile.role}.

You will be given multiple candidate JSON analyses for the SAME persona and document, each from different model backends.
Your job is to:
1) Rank them best-to-worst.
2) Identify inaccuracies, unsupported claims, rubric misses, and low-specificity feedback.
3) Provide merge guidance for a chairman to synthesize a final answer.

OUTPUT FORMAT:
Respond with ONLY valid JSON:
{
  "ranking": [
    {"candidate_id": "c1", "rank": 1, "why": "..."},
    {"candidate_id": "c2", "rank": 2, "why": "..."}
  ],
  "key_flaws": ["..."],
  "merge_guidance": ["..."],
  "overall_recommendation": "..."
}`;
  }

  private buildCouncilChairPrompt(persona: any): string {
    const profile = JSON.parse(persona.profile_json);
    return `You are the chairman synthesizing multiple candidate analyses into ONE final answer for ${profile.name} (${profile.role}).

You will receive:
- candidates: an array of candidate JSON analyses
- reviewer: a JSON review with ranking + merge guidance

TASK:
Produce a single final analysis in the EXACT Roundtable JSON shape below. Use the best parts of the candidates, fix flaws, and ensure the output is specific and actionable.

OUTPUT FORMAT:
Respond with ONLY valid JSON (no markdown, no extra text). Use this exact shape:
{
  "persona_role": "${profile.role}",
  "overall_score": 7,
  "dimension_scores": {
    "relevance": { "score": 8, "commentary": "..." },
    "technical_credibility": { "score": 6, "commentary": "..." },
    "differentiation": { "score": 5, "commentary": "..." },
    "actionability": { "score": 7, "commentary": "..." },
    "trust_signals": { "score": 6, "commentary": "..." },
    "language_fit": { "score": 7, "commentary": "..." }
  },
  "top_3_issues": [
    { "issue": "...", "specific_example_from_content": "...", "suggested_rewrite": "..." },
    { "issue": "...", "specific_example_from_content": "...", "suggested_rewrite": "..." },
    { "issue": "...", "specific_example_from_content": "...", "suggested_rewrite": "..." }
  ],
  "what_works_well": ["...", "..."],
  "overall_verdict": "...",
  "rewritten_headline_suggestion": "..."
}`;
  }

  private async analyzePersonaCouncil(
    sessionId: string,
    persona: any,
    documentText: string,
    sendMessage: (msg: any) => void,
    db: D1Client,
    council: { members: Backend[]; reviewer: Backend; chair: Backend }
  ): Promise<void> {
    console.log(`Starting analyzePersonaCouncil for ${persona.id} in session ${sessionId}`);

    try {
      // Get existing analysis record
      const analyses = await db.getAnalyses(sessionId);
      const analysis = analyses.find(a => a.persona_id === persona.id);
      if (!analysis) {
        throw new Error(`Missing analysis row for persona ${persona.id}`);
      }

      await db.updateAnalysis(analysis.id, {
        status: 'running',
        started_at: new Date().toISOString(),
        completed_at: null as any,
        score_json: null as any,
        top_issues_json: null as any,
        rewritten_suggestions_json: null as any,
        error_message: null as any,
        analysis_provider: council.chair.provider,
        analysis_model: council.chair.model,
      });

      sendMessage({ type: 'status', persona_id: persona.id, status: 'running' });

      const systemPrompt = this.buildSystemPrompt(persona);

      const MAX_DOC_CHARS = 8000;
      const documentForAnalysis = documentText.length > MAX_DOC_CHARS ? documentText.slice(0, MAX_DOC_CHARS) : documentText;

      sendMessage({
        type: 'activity',
        session_id: sessionId,
        persona_id: persona.id,
        phase: 'council_start',
        message: `Council mode: collecting ${council.members.length} candidate(s)`,
        at: new Date().toISOString(),
      });

      const candidates: Array<{ candidate_id: string; backend: Backend; raw: string; meta?: CLIBridgeCompletionMeta | null; parsed?: any; parse_error?: string }> = [];
      let idx = 0;
      for (const member of council.members) {
        idx += 1;
        const candidateId = `c${idx}`;
        sendMessage({
          type: 'activity',
          session_id: sessionId,
          persona_id: persona.id,
          phase: 'council_member_start',
          candidate_id: candidateId,
          backend_provider: member.provider,
          backend_model: member.model,
          message: `Council member ${candidateId}: ${member.provider}/${member.model}`,
          at: new Date().toISOString(),
        });
        try {
          const completion = await this.clibridgeComplete({
            provider: member.provider,
            model: member.model,
            systemPrompt,
            messages: [{ role: 'user', content: documentForAnalysis }],
          });
          const raw = completion.text;
          const meta = completion.meta;

          let parsed: any | undefined;
          let parseError: string | undefined;
          try {
            parsed = await this.parseRoundtableResultFromText(raw, persona);
          } catch (e) {
            parseError = String(e);
            parsed = this.fallbackResultFromText(raw, persona);
          }

          candidates.push({ candidate_id: candidateId, backend: member, raw, meta, parsed, parse_error: parseError });
          await db.createAnalysisArtifact({
            session_id: sessionId,
            persona_id: persona.id,
            artifact_type: 'council_member_output',
            backend_provider: member.provider,
            backend_model: member.model,
            content_json: JSON.stringify({ candidate_id: candidateId, raw, meta: meta || null, parsed: parsed || null, parse_error: parseError || null }),
          } as any);

          sendMessage({
            type: 'activity',
            session_id: sessionId,
            persona_id: persona.id,
            phase: parseError ? 'council_member_done_with_parse_error' : 'council_member_done',
            candidate_id: candidateId,
            backend_provider: member.provider,
            backend_model: member.model,
            meta: meta || null,
            message: parseError ? `Council member ${candidateId} returned non-JSON` : `Council member ${candidateId} done`,
            at: new Date().toISOString(),
          });
        } catch (e) {
          const err = String(e);
          candidates.push({ candidate_id: candidateId, backend: member, raw: '', parse_error: err });
          await db.createAnalysisArtifact({
            session_id: sessionId,
            persona_id: persona.id,
            artifact_type: 'council_member_output',
            backend_provider: member.provider,
            backend_model: member.model,
            content_json: JSON.stringify({ candidate_id: candidateId, raw: null, parsed: null, parse_error: err }),
          } as any);

          sendMessage({
            type: 'activity',
            session_id: sessionId,
            persona_id: persona.id,
            phase: 'council_member_error',
            candidate_id: candidateId,
            backend_provider: member.provider,
            backend_model: member.model,
            message: `Council member ${candidateId} error: ${err}`,
            at: new Date().toISOString(),
          });
        }
      }

      const usable = candidates.filter((c) => c.parsed && typeof c.parsed === 'object' && !c.parse_error);
      if (usable.length === 0) {
        // Council members sometimes ignore JSON-only instructions (or return invalid JSON). Rather than
        // failing the persona outright, fall back to running a single direct analysis using the chair backend.
        // This preserves a usable user experience while still recording member outputs as artifacts.
        try {
          console.warn(`Council produced no usable JSON for ${persona.id}; falling back to chair direct analysis`);
          sendMessage({
            type: 'activity',
            session_id: sessionId,
            persona_id: persona.id,
            phase: 'council_fallback_start',
            backend_provider: council.chair.provider,
            backend_model: council.chair.model,
            message: 'Council fallback: running direct chair analysis',
            at: new Date().toISOString(),
          });

          const fallbackCompletion = await this.clibridgeComplete({
            provider: council.chair.provider,
            model: council.chair.model,
            systemPrompt,
            messages: [{ role: 'user', content: documentForAnalysis }],
          });
          const fallbackText = fallbackCompletion.text;
          const fallbackMeta = fallbackCompletion.meta;

          let fallbackResult: any;
          let fallbackParseError: string | null = null;
          try {
            fallbackResult = await this.parseRoundtableResultFromText(fallbackText, persona);
          } catch (e) {
            fallbackParseError = String(e);
            fallbackResult = this.fallbackResultFromText(fallbackText, persona);
          }

          await db.createAnalysisArtifact({
            session_id: sessionId,
            persona_id: persona.id,
            artifact_type: 'council_fallback_direct',
            backend_provider: council.chair.provider,
            backend_model: council.chair.model,
            content_json: JSON.stringify({ raw: fallbackText, meta: fallbackMeta || null, parsed: fallbackResult, parse_error: fallbackParseError }),
          } as any);

          sendMessage({
            type: 'activity',
            session_id: sessionId,
            persona_id: persona.id,
            phase: fallbackParseError ? 'council_fallback_done_with_parse_error' : 'council_fallback_done',
            backend_provider: council.chair.provider,
            backend_model: council.chair.model,
            meta: fallbackMeta || null,
            message: fallbackParseError ? 'Council fallback: chair returned non-JSON (stored as verdict)' : 'Council fallback: direct chair analysis done',
            at: new Date().toISOString(),
          });

          sendMessage({ type: 'complete', persona_id: persona.id, result: fallbackResult });

          await db.updateAnalysis(analysis.id, {
            status: 'completed',
            analysis_provider: council.chair.provider,
            analysis_model: council.chair.model,
            error_message: (fallbackParseError ? `Non-JSON chair fallback output: ${fallbackParseError}` : null) as any,
            score_json: JSON.stringify(fallbackResult.dimension_scores || {}),
            top_issues_json: JSON.stringify(fallbackResult.top_3_issues || []),
            rewritten_suggestions_json: JSON.stringify({
              what_works_well: fallbackResult.what_works_well || [],
              overall_verdict: fallbackResult.overall_verdict || '',
              rewritten_headline: fallbackResult.rewritten_headline_suggestion || '',
            }),
            completed_at: new Date().toISOString(),
          });

          return;
        } catch (e) {
          console.warn(`Council fallback direct analysis failed for ${persona.id}`, e);
          throw new Error('No usable candidate JSON produced by council members');
        }
      }

      // Reviewer step (best-effort)
      let reviewerJson: any = null;
      let reviewerMeta: CLIBridgeCompletionMeta | null = null;
      try {
        sendMessage({
          type: 'activity',
          session_id: sessionId,
          persona_id: persona.id,
          phase: 'council_reviewer_start',
          backend_provider: council.reviewer.provider,
          backend_model: council.reviewer.model,
          message: `Council reviewer: ${council.reviewer.provider}/${council.reviewer.model}`,
          at: new Date().toISOString(),
        });

        const reviewerCompletion = await this.clibridgeComplete({
          provider: council.reviewer.provider,
          model: council.reviewer.model,
          systemPrompt: this.buildCouncilReviewPrompt(persona),
          messages: [{
            role: 'user',
            content: JSON.stringify({
              persona_id: persona.id,
              candidates: usable.map((c) => ({ candidate_id: c.candidate_id, backend: c.backend, analysis: c.parsed })),
            }),
          }],
        });
        reviewerMeta = reviewerCompletion.meta;
        reviewerJson = this.parseJsonFlexible(reviewerCompletion.text);

        sendMessage({
          type: 'activity',
          session_id: sessionId,
          persona_id: persona.id,
          phase: 'council_reviewer_done',
          backend_provider: council.reviewer.provider,
          backend_model: council.reviewer.model,
          meta: reviewerMeta || null,
          message: 'Council reviewer done',
          at: new Date().toISOString(),
        });
      } catch (e) {
        reviewerJson = { error: String(e) };
        sendMessage({
          type: 'activity',
          session_id: sessionId,
          persona_id: persona.id,
          phase: 'council_reviewer_error',
          backend_provider: council.reviewer.provider,
          backend_model: council.reviewer.model,
          message: `Council reviewer error: ${String(e)}`,
          at: new Date().toISOString(),
        });
      }

      await db.createAnalysisArtifact({
        session_id: sessionId,
        persona_id: persona.id,
        artifact_type: 'council_peer_review',
        backend_provider: council.reviewer.provider,
        backend_model: council.reviewer.model,
        content_json: JSON.stringify({ meta: reviewerMeta || null, review: reviewerJson }),
      } as any);

      // Chair synthesis
      let finalResult: any;
      let chairMeta: CLIBridgeCompletionMeta | null = null;
      try {
        sendMessage({
          type: 'activity',
          session_id: sessionId,
          persona_id: persona.id,
          phase: 'council_chair_start',
          backend_provider: council.chair.provider,
          backend_model: council.chair.model,
          message: `Council chairman: ${council.chair.provider}/${council.chair.model}`,
          at: new Date().toISOString(),
        });

        const chairCompletion = await this.clibridgeComplete({
          provider: council.chair.provider,
          model: council.chair.model,
          systemPrompt: this.buildCouncilChairPrompt(persona),
          messages: [{
            role: 'user',
            content: JSON.stringify({
              persona_id: persona.id,
              candidates: usable.map((c) => ({ candidate_id: c.candidate_id, backend: c.backend, analysis: c.parsed })),
              reviewer: reviewerJson,
            }),
          }],
        });
        chairMeta = chairCompletion.meta;
        finalResult = await this.parseRoundtableResultFromText(chairCompletion.text, persona);

        sendMessage({
          type: 'activity',
          session_id: sessionId,
          persona_id: persona.id,
          phase: 'council_chair_done',
          backend_provider: council.chair.provider,
          backend_model: council.chair.model,
          meta: chairMeta || null,
          message: 'Council chairman synthesis done',
          at: new Date().toISOString(),
        });
      } catch (e) {
        console.warn(`Council chair synthesis failed for ${persona.id}; falling back to top candidate.`, e);
        finalResult = usable[0].parsed;
        sendMessage({
          type: 'activity',
          session_id: sessionId,
          persona_id: persona.id,
          phase: 'council_chair_error_fallback',
          backend_provider: council.chair.provider,
          backend_model: council.chair.model,
          message: `Council chairman failed; used best candidate instead (${String(e)})`,
          at: new Date().toISOString(),
        });
      }

      await db.createAnalysisArtifact({
        session_id: sessionId,
        persona_id: persona.id,
        artifact_type: 'council_chair_final',
        backend_provider: council.chair.provider,
        backend_model: council.chair.model,
        content_json: JSON.stringify({ meta: chairMeta || null, result: finalResult }),
      } as any);

      sendMessage({ type: 'complete', persona_id: persona.id, result: finalResult });

      await db.updateAnalysis(analysis.id, {
        status: 'completed',
        analysis_provider: council.chair.provider,
        analysis_model: council.chair.model,
        error_message: null as any,
        score_json: JSON.stringify(finalResult.dimension_scores || {}),
        top_issues_json: JSON.stringify(finalResult.top_3_issues || []),
        rewritten_suggestions_json: JSON.stringify({
          what_works_well: finalResult.what_works_well || [],
          overall_verdict: finalResult.overall_verdict || '',
          rewritten_headline: finalResult.rewritten_headline_suggestion || '',
        }),
        completed_at: new Date().toISOString(),
      });
    } catch (e) {
      const err = String(e);
      console.error(`Council analysis failed for persona ${persona.id}:`, err);
      sendMessage({ type: 'error', persona_id: persona.id, error: err });

      const analyses = await db.getAnalyses(sessionId);
      const analysis = analyses.find(a => a.persona_id === persona.id);
      if (analysis) {
        await db.updateAnalysis(analysis.id, {
          status: 'failed',
          error_message: err,
          completed_at: new Date().toISOString(),
        });
      }
    }
  }

  private buildDiscussionCritiquePrompt(persona: any): string {
    const profile = JSON.parse(persona.profile_json);
    return `You are ${profile.name}, a ${profile.role}.

You will be given:
- a candidate analysis JSON produced by another variant of the same role

TASK:
Critique the candidate analysis from your unique agenda and constraints. Focus on:
- missing risks or missing business context
- weak evidence or generic claims
- rubric misses (relevance, credibility, differentiation, actionability, trust, language fit)
- improvements to make it more specific and useful

OUTPUT FORMAT:
Respond with ONLY valid JSON:
{
  "key_disagreements": ["..."],
  "errors_or_weaknesses": ["..."],
  "improvements": ["..."],
  "overall_assessment": "...",
  "confidence": 0.7
}`;
  }

  private buildDiscussionChairPrompt(role: string): string {
    return `You are the chairman synthesizing a single final analysis for a focus-group discussion among multiple variants of the SAME job role: ${role}.

You will be given:
- candidates: an array of variant analyses (JSON)
- critiques: an array of cross-critiques (JSON)

TASK:
1) Produce ONE final Roundtable analysis JSON (same shape as standard Roundtable output).
2) Produce dissent notes capturing the main disagreements and which variant(s) raised them.

OUTPUT FORMAT:
Respond with ONLY valid JSON:
{
  "final": { ...Roundtable JSON... },
  "dissents": [
    {"who": ["variant_persona_id"], "point": "...", "why_not_in_final": "..."}
  ]
}`;
  }

  private async runRoleVariantDiscussionSynthesis(
    sessionId: string,
    variants: any[],
    personaGroupId: string,
    documentText: string,
    sendMessage: (msg: any) => void,
    db: D1Client,
    cfg: { variantBackend: Backend; chairBackend: Backend }
  ): Promise<void> {
    console.log(`Starting discussion synthesis for session ${sessionId}: variants=${variants.length}, group=${personaGroupId || 'n/a'}`);

    const analyses = await db.getAnalyses(sessionId);
    const byPersona: Record<string, any> = {};
    for (const a of analyses) {
      if (!a.persona_id) continue;
      byPersona[a.persona_id] = a;
    }

    const candidates: any[] = [];
    for (const v of variants) {
      const a = byPersona[v.id];
      if (!a || a.status !== 'completed') continue;

      let score: any = null;
      let issues: any = null;
      let suggestions: any = null;
      try { score = a.score_json ? (typeof a.score_json === 'string' ? JSON.parse(a.score_json) : a.score_json) : null; } catch {}
      try { issues = a.top_issues_json ? (typeof a.top_issues_json === 'string' ? JSON.parse(a.top_issues_json) : a.top_issues_json) : null; } catch {}
      try { suggestions = a.rewritten_suggestions_json ? (typeof a.rewritten_suggestions_json === 'string' ? JSON.parse(a.rewritten_suggestions_json) : a.rewritten_suggestions_json) : null; } catch {}

      candidates.push({
        persona_id: v.id,
        name: v.name,
        role: v.role,
        dimension_scores: score,
        top_3_issues: issues,
        feedback: suggestions,
      });
    }

    if (candidates.length === 0) {
      throw new Error('No completed variant analyses available for discussion synthesis');
    }

    // Cross critiques (all-against-all)
    const critiques: any[] = [];
    const MAX_TARGET_JSON_CHARS = 6000;

    for (const from of variants) {
      const fromCandidate = candidates.find((c) => c.persona_id === from.id);
      if (!fromCandidate) continue;

      for (const target of variants) {
        if (target.id === from.id) continue;
        const targetCandidate = candidates.find((c) => c.persona_id === target.id);
        if (!targetCandidate) continue;

        try {
          const critiqueText = await this.clibridgeCompleteText({
            provider: cfg.variantBackend.provider,
            model: cfg.variantBackend.model,
            systemPrompt: this.buildDiscussionCritiquePrompt(from),
            messages: [{
              role: 'user',
              content: JSON.stringify({
                target_persona_id: target.id,
                target_analysis: targetCandidate,
              }).slice(0, MAX_TARGET_JSON_CHARS),
            }],
          });

          const critiqueJson = this.parseJsonFlexible(critiqueText);
          const payload = {
            from_persona_id: from.id,
            target_persona_id: target.id,
            critique: critiqueJson,
          };
          critiques.push(payload);
          await db.createAnalysisArtifact({
            session_id: sessionId,
            persona_id: from.id,
            artifact_type: 'discussion_critique',
            backend_provider: cfg.variantBackend.provider,
            backend_model: cfg.variantBackend.model,
            content_json: JSON.stringify(payload),
          } as any);
        } catch (e) {
          const payload = {
            from_persona_id: from.id,
            target_persona_id: target.id,
            error: String(e),
          };
          critiques.push(payload);
          await db.createAnalysisArtifact({
            session_id: sessionId,
            persona_id: from.id,
            artifact_type: 'discussion_critique',
            backend_provider: cfg.variantBackend.provider,
            backend_model: cfg.variantBackend.model,
            content_json: JSON.stringify(payload),
          } as any);
        }
      }
    }

    // Chair synthesis
    const role = String(variants[0]?.role || 'Role').trim() || 'Role';
    let chairJson: any;
    try {
      const chairText = await this.clibridgeCompleteText({
        provider: cfg.chairBackend.provider,
        model: cfg.chairBackend.model,
        systemPrompt: this.buildDiscussionChairPrompt(role),
        messages: [{
          role: 'user',
          content: JSON.stringify({
            persona_group_id: personaGroupId || null,
            candidates,
            critiques,
            doc_excerpt: documentText.slice(0, 2000),
          }),
        }],
      });
      chairJson = this.parseJsonFlexible(chairText);
    } catch (e) {
      const err = String(e);
      console.error('Discussion chair synthesis failed:', err);
      await db.createAnalysisArtifact({
        session_id: sessionId,
        persona_id: 'discussion',
        artifact_type: 'discussion_chair_error',
        backend_provider: cfg.chairBackend.provider,
        backend_model: cfg.chairBackend.model,
        content_json: JSON.stringify({ error: err }),
      } as any);
      throw e;
    }

    const finalObj = chairJson?.final;
    const dissents = Array.isArray(chairJson?.dissents) ? chairJson.dissents : [];
    if (!finalObj || typeof finalObj !== 'object') {
      throw new Error('Discussion chair did not return a valid final object');
    }

    // Normalize final into the standard Roundtable shape (using first variant as schema anchor).
    const normalizedFinal = this.normalizeResult(finalObj, variants[0]);

    await db.createAnalysisArtifact({
      session_id: sessionId,
      persona_id: 'discussion',
      artifact_type: 'discussion_chair_final',
      backend_provider: cfg.chairBackend.provider,
      backend_model: cfg.chairBackend.model,
      content_json: JSON.stringify({ persona_group_id: personaGroupId || null, final: normalizedFinal }),
    } as any);

    await db.createAnalysisArtifact({
      session_id: sessionId,
      persona_id: 'discussion',
      artifact_type: 'discussion_dissents',
      backend_provider: cfg.chairBackend.provider,
      backend_model: cfg.chairBackend.model,
      content_json: JSON.stringify({ persona_group_id: personaGroupId || null, dissents }),
    } as any);

    sendMessage({ type: 'complete', persona_id: 'discussion', result: { final: normalizedFinal, dissents } });
  }

  private async retryPersonaAnalysis(sessionId: string, personaId: string): Promise<void> {
    const db = new D1Client(this.env.DB);

    const sendMessage = (msg: any) => {
      this.websockets.forEach((socket) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(msg));
        }
      });
    };

    try {
      const session = await db.getSession(sessionId);
      if (!session) {
        sendMessage({ type: 'error', error: 'Session not found' });
        return;
      }

      if (session.status === 'uploaded') {
        sendMessage({ type: 'error', error: 'Session has not started analysis yet' });
        return;
      }

      if (session.status === 'analyzing') {
        sendMessage({ type: 'error', error: 'Session is currently analyzing; wait for it to finish' });
        return;
      }

      const workflowRaw = (session.workflow || '').trim().toLowerCase();
      const workflow = (workflowRaw === 'roundtable_council' || workflowRaw === 'role_variant_discussion' || workflowRaw === 'roundtable_standard')
        ? workflowRaw
        : 'roundtable_standard';

      let analysisConfig: any = {};
      const rawConfig = (session.analysis_config_json || '').trim();
      if (rawConfig) {
        try {
          analysisConfig = JSON.parse(rawConfig);
        } catch (e) {
          console.warn(`Invalid analysis_config_json for session ${sessionId} (retry); ignoring.`, e);
        }
      }

      const parseBackend = (v: any): Backend | null => {
        if (!v || typeof v !== 'object') return null;
        const provider = typeof v.provider === 'string' ? v.provider.trim() : '';
        const model = typeof v.model === 'string' ? v.model.trim() : '';
        if (!provider || !model) return null;
        const validation = validateAnalysisBackend(this.env, provider, model);
        if (!validation.ok) return null;
        return validation.backend;
      };

      // Resolve the fallback backend similarly to startAnalysis.
      const DEFAULT_ANALYSIS_PROVIDER = 'claude';
      const DEFAULT_ANALYSIS_MODEL = 'sonnet';

      const sessionProvider = (session.analysis_provider || '').trim();
      const sessionModel = (session.analysis_model || '').trim();

      const configuredProvider = (await db.getSettingValue('analysis_provider'))?.trim();
      const configuredModel = (await db.getSettingValue('analysis_model'))?.trim();

      const requestedBackend = (sessionProvider && sessionModel)
        ? { provider: sessionProvider, model: sessionModel }
        : {
          provider: configuredProvider || DEFAULT_ANALYSIS_PROVIDER,
          model: configuredModel || DEFAULT_ANALYSIS_MODEL,
        };

      const backendValidation = validateAnalysisBackend(this.env, requestedBackend.provider, requestedBackend.model);
      if (!backendValidation.ok) {
        const errorMessage = backendValidation.error;
        sendMessage({ type: 'error', persona_id: personaId, error: errorMessage });

        const analyses = await db.getAnalyses(sessionId);
        const analysis = analyses.find((a) => a.persona_id === personaId);
        if (analysis) {
          await db.updateAnalysis(analysis.id, {
            status: 'failed',
            error_message: errorMessage,
            completed_at: new Date().toISOString(),
          });
        }

        await this.updateSessionFinalStatus(sessionId, db, sendMessage, errorMessage);
        return;
      }

      const fallbackBackend = backendValidation.backend;

      let analysisBackend: Backend = fallbackBackend;
      let councilCfg: { members: Backend[]; reviewer: Backend; chair: Backend } | null = null;
      let discussionCfg: { groupId: string; variantBackend: Backend; chairBackend: Backend } | null = null;

      if (workflow === 'roundtable_council') {
        const council = (analysisConfig && typeof analysisConfig === 'object')
          ? ((analysisConfig.council && typeof analysisConfig.council === 'object') ? analysisConfig.council : analysisConfig)
          : {};

        const membersRaw = Array.isArray(council.members) ? council.members : [];
        const members: Backend[] = [];
        for (const m of membersRaw) {
          const b = parseBackend(m);
          if (b) members.push(b);
        }
        const chair = parseBackend(council.chair_backend || council.chair) || fallbackBackend;
        const reviewer = parseBackend(council.reviewer_backend || council.reviewer) || chair;
        councilCfg = { members: members.length > 0 ? members : [fallbackBackend], reviewer, chair };
        analysisBackend = chair;
      } else if (workflow === 'role_variant_discussion') {
        const discussion = (analysisConfig && typeof analysisConfig === 'object')
          ? ((analysisConfig.discussion && typeof analysisConfig.discussion === 'object') ? analysisConfig.discussion : analysisConfig)
          : {};

        const variantBackend = parseBackend(discussion.variant_backend || discussion.variant) || fallbackBackend;
        const chairBackend = parseBackend(discussion.chair_backend || discussion.chair) || fallbackBackend;
        const groupId = typeof discussion.persona_group_id === 'string' ? discussion.persona_group_id.trim() : '';
        discussionCfg = { groupId, variantBackend, chairBackend };
        analysisBackend = variantBackend;
      }

      console.log(`Retry workflow/backend for session ${sessionId} persona ${personaId}:`, { workflow, analysisBackend });

      // Ensure the analysis exists for this persona and is reset.
      const analyses = await db.getAnalyses(sessionId);
      const analysis = analyses.find((a) => a.persona_id === personaId);
      if (!analysis) {
        sendMessage({ type: 'error', persona_id: personaId, error: 'Analysis not found for persona_id' });
        return;
      }

      await db.updateAnalysis(analysis.id, {
        status: 'pending',
        score_json: null as any,
        top_issues_json: null as any,
        rewritten_suggestions_json: null as any,
        error_message: null as any,
        started_at: null as any,
        completed_at: null as any,
        analysis_provider: analysisBackend.provider,
        analysis_model: analysisBackend.model,
      });

      // Update session status while retry is running.
      await db.updateSession(sessionId, {
        status: 'analyzing',
        analysis_provider: (councilCfg ? councilCfg.chair.provider : (discussionCfg ? discussionCfg.chairBackend.provider : analysisBackend.provider)),
        analysis_model: (councilCfg ? councilCfg.chair.model : (discussionCfg ? discussionCfg.chairBackend.model : analysisBackend.model)),
        error_message: null as any,
      });
      sendMessage({ type: 'status', session_id: sessionId, status: 'analyzing' });

      // Get document from R2 (re-extract; keeps retry self-contained).
      const r2Object = await this.env.R2.get(session.file_r2_key);
      if (!r2Object) {
        sendMessage({ type: 'error', persona_id: personaId, error: 'Document not found in storage' });
        await db.updateAnalysis(analysis.id, {
          status: 'failed',
          error_message: 'Document not found in storage',
          completed_at: new Date().toISOString(),
        });
        await this.updateSessionFinalStatus(sessionId, db, sendMessage);
        return;
      }

      const fileBuffer = await r2Object.arrayBuffer();
      const extractedDoc = await extractTextFromDocument(fileBuffer, session.file_extension);
      const documentText = extractedDoc.text;

      // Validate extraction output (mirrors startAnalysis behavior).
      if (documentText.startsWith('[') && documentText.includes('document:') && documentText.includes('error')) {
        const err = 'Failed to process document: ' + documentText;
        sendMessage({ type: 'error', persona_id: personaId, error: err });
        await db.updateAnalysis(analysis.id, {
          status: 'failed',
          error_message: err,
          completed_at: new Date().toISOString(),
        });
        await this.updateSessionFinalStatus(sessionId, db, sendMessage, err);
        return;
      }

      const persona = await db.getPersona(personaId);
      if (!persona) {
        const err = 'Persona not found';
        sendMessage({ type: 'error', persona_id: personaId, error: err });
        await db.updateAnalysis(analysis.id, {
          status: 'failed',
          error_message: err,
          completed_at: new Date().toISOString(),
        });
        await this.updateSessionFinalStatus(sessionId, db, sendMessage, err);
        return;
      }

      if (councilCfg) {
        await this.analyzePersonaCouncil(sessionId, persona, documentText, sendMessage, db, councilCfg);
        await this.updateSessionFinalStatus(sessionId, db, sendMessage);
        return;
      }

      await this.analyzePersona(sessionId, persona, documentText, sendMessage, db, analysisBackend);

      // If this session is a discussion workflow, re-run chair synthesis to update the final.
      if (discussionCfg) {
        let variantPersonas: any[] = [];
        try {
          const ids = JSON.parse(session.selected_persona_ids || '[]');
          if (Array.isArray(ids)) {
            for (const id of ids) {
              const p = await db.getPersona(String(id));
              if (p) variantPersonas.push(p);
            }
          }
        } catch {
          // ignore
        }
        if (variantPersonas.length > 0) {
          await this.runRoleVariantDiscussionSynthesis(sessionId, variantPersonas, discussionCfg.groupId, documentText, sendMessage, db, {
            variantBackend: discussionCfg.variantBackend,
            chairBackend: discussionCfg.chairBackend,
          });
        }
      }

      await this.updateSessionFinalStatus(sessionId, db, sendMessage);
    } catch (e) {
      const errorMessage = String(e);
      console.error(`Retry failed for session ${sessionId} persona ${personaId}:`, errorMessage);
      sendMessage({ type: 'error', persona_id: personaId, error: errorMessage });
      await this.updateSessionFinalStatus(sessionId, db, sendMessage, errorMessage);
    }
  }

  private async updateSessionFinalStatus(
    sessionId: string,
    db: D1Client,
    sendMessage: (msg: any) => void,
    errorMessage?: string
  ): Promise<void> {
    const finalAnalyses = await db.getAnalyses(sessionId);
    const failedCount = finalAnalyses.filter(a => a.status === 'failed').length;
    const completedCount = finalAnalyses.filter(a => a.status === 'completed').length;

    let finalStatus: 'completed' | 'failed' | 'partial' = 'completed';
    if (finalAnalyses.length > 0 && failedCount === finalAnalyses.length) {
      finalStatus = 'failed';
    } else if (completedCount === finalAnalyses.length) {
      finalStatus = 'completed';
    } else {
      // Covers mixes (some failed/some completed) and any unexpected leftovers (pending/running).
      finalStatus = 'partial';
    }

    await db.updateSession(sessionId, {
      status: finalStatus,
      ...(errorMessage !== undefined ? { error_message: errorMessage } : { error_message: null as any }),
    } as any);

    sendMessage({ type: 'status', session_id: sessionId, status: finalStatus });
  }

  private async analyzePersona(
    sessionId: string,
    persona: any,
    documentText: string,
    sendMessage: (msg: any) => void,
    db: D1Client,
    analysisBackend: { provider: string; model: string }
  ): Promise<void> {
    console.log(`Starting analyzePersona for ${persona.id} in session ${sessionId}`);
    console.log(`Document text length: ${documentText.length}`);
    console.log(`First 100 chars of document: ${documentText.substring(0, 100)}`);
    console.log(`Using provider/model for ${persona.id}:`, analysisBackend);
    
    try {
      // Get existing analysis or create new one
      let analyses = await db.getAnalyses(sessionId);
      let analysis = analyses.find(a => a.persona_id === persona.id);
      
      if (!analysis) {
        const analysisId = await db.createAnalysis({
          session_id: sessionId,
          persona_id: persona.id,
          status: 'pending',
        });
        // Refresh analyses to get the newly created analysis
        analyses = await db.getAnalyses(sessionId);
        analysis = analyses.find(a => a.persona_id === persona.id);
      }

      // Update status to running
      const startedAt = new Date().toISOString();
      if (analysis) {
        await db.updateAnalysis(analysis.id, {
          status: 'running',
          started_at: startedAt,
          completed_at: null as any,
          score_json: null as any,
          top_issues_json: null as any,
          rewritten_suggestions_json: null as any,
          error_message: null as any,
          analysis_provider: analysisBackend.provider,
          analysis_model: analysisBackend.model,
        });
      }
      sendMessage({
        type: 'status',
        persona_id: persona.id,
        status: 'running',
      });

      // Initialize CLIBridge client
      console.log(`Initializing CLIBridge client for persona ${persona.id}`);
      const clibridge = new CLIBridgeClient(this.env);

      // Call CLIBridge streaming endpoint
      const systemPrompt = this.buildSystemPrompt(persona);

      // Avoid huge prompts causing upstream failures/timeouts.
      const MAX_DOC_CHARS = 8000;
      const documentForAnalysis = documentText.length > MAX_DOC_CHARS
        ? documentText.slice(0, MAX_DOC_CHARS)
        : documentText;
      if (documentText.length > MAX_DOC_CHARS) {
        console.log(`Truncated document text for persona ${persona.id}: ${documentText.length} -> ${documentForAnalysis.length} chars`);
      }

      const analysisRequest = {
        provider: analysisBackend.provider,
        model: analysisBackend.model,
        systemPrompt: systemPrompt,
        messages: [
          { role: 'user', content: documentForAnalysis },
        ],
      };

      const modelCallStartedAt = Date.now();
      let firstChunkAt: number | null = null;
      let completionMeta: CLIBridgeCompletionMeta | null = null;

      console.log(`Calling CLIBridge for persona ${persona.id}`);
      console.log(`Document text length: ${documentText.length} (sent: ${documentForAnalysis.length})`);
      console.log(`System prompt length: ${systemPrompt.length}`);

      sendMessage({
        type: 'activity',
        session_id: sessionId,
        persona_id: persona.id,
        phase: 'clibridge_stream_start',
        backend_provider: analysisBackend.provider,
        backend_model: analysisBackend.model,
        message: `Starting model stream: ${analysisBackend.provider}/${analysisBackend.model}`,
        at: new Date().toISOString(),
      });

      const response = await clibridge.streamAnalysis(analysisRequest);
      console.log(`CLIBridge streamAnalysis returned for persona ${persona.id}:`, { 
        status: response.status, 
        statusText: response.statusText,
        contentType: response.headers.get('content-type'),
        hasBody: !!response.body
      });
      console.log(`CLIBridge response for persona ${persona.id}:`, { status: response.status, statusText: response.statusText, contentType: response.headers.get('content-type') });
      console.log(`CLIBridge response for persona ${persona.id}:`, { status: response.status, statusText: response.statusText });

      // Check if response is OK before streaming
      if (!response.ok) {
        const errorText = await response.text();
        console.error(`CLIBridge returned non-OK response for persona ${persona.id}:`, { 
          status: response.status, 
          statusText: response.statusText,
          errorText: errorText.substring(0, 500)
        });
        throw new Error(`CLIBridge returned ${response.status}: ${response.statusText} - ${errorText.substring(0, 200)}`);
      }

      const contentType = response.headers.get('content-type') || '';

      // Stream chunks (SSE) and accumulate the final model response
      let fullResponse = '';
      let receivedAnyBytes = false;
      let chunkCount = 0;
      let sseEventCount = 0;

      const isSse = contentType.includes('text/event-stream');
      const reader = isSse ? response.body?.getReader() : undefined;
      console.log(`Stream reader available for persona ${persona.id}: ${!!reader} (content-type: ${contentType || 'unknown'})`);

      // Guard against CLIBridge streams that never close (or stall mid-stream).
      const STREAM_IDLE_TIMEOUT_MS = 30_000;
      const STREAM_TOTAL_TIMEOUT_MS = 180_000;

      let streamTimedOut = false;

      if (reader) {
        const decoder = new TextDecoder();
        let buffer = '';
        let receivedDoneEvent = false;
        const streamStartedAt = Date.now();
        let lastActivityAt = streamStartedAt;

        const readWithTimeout = async (timeoutMs: number) => {
          return await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error(`CLIBridge stream timed out after ${timeoutMs}ms`));
            }, timeoutMs);

            reader.read().then(
              (res) => {
                clearTimeout(timer);
                resolve(res);
              },
              (err) => {
                clearTimeout(timer);
                reject(err);
              }
            );
          });
        };

        const handleEventData = (data: string) => {
          const trimmed = data.trim();
          if (!trimmed) return;
          if (trimmed === '[DONE]') {
            receivedDoneEvent = true;
            return;
          }

          let jsonData: any;
          try {
            jsonData = JSON.parse(trimmed);
          } catch (_parseError) {
            console.warn(`Failed to parse CLIBridge SSE data for persona ${persona.id}:`, trimmed.substring(0, 200));
            return;
          }

          if (jsonData.type === 'chunk') {
            const chunkText = typeof jsonData.text === 'string'
              ? jsonData.text
              : (typeof jsonData.response === 'string' ? jsonData.response : '');
            if (chunkText) {
              if (!firstChunkAt) {
                firstChunkAt = Date.now();
                sendMessage({
                  type: 'activity',
                  session_id: sessionId,
                  persona_id: persona.id,
                  phase: 'clibridge_first_chunk',
                  backend_provider: analysisBackend.provider,
                  backend_model: analysisBackend.model,
                  message: `First token received (${firstChunkAt - modelCallStartedAt}ms)`,
                  at: new Date().toISOString(),
                });
              }
              fullResponse += chunkText;
              sendMessage({
                type: 'chunk',
                persona_id: persona.id,
                text: chunkText,
              });
            }
            return;
          }

          if (jsonData.type === 'done') {
            const doneText = typeof jsonData.response === 'string'
              ? jsonData.response
              : (typeof jsonData.text === 'string' ? jsonData.text : '');
            if (doneText) {
              // Some stream implementations include the entire final response in the done event.
              // Avoid duplicating if chunk streaming already accumulated the prefix.
              if (!fullResponse) {
                fullResponse = doneText;
              } else if (doneText.startsWith(fullResponse)) {
                fullResponse = doneText;
              } else if (!fullResponse.endsWith(doneText)) {
                fullResponse += doneText;
              }
            }

            const meta: CLIBridgeCompletionMeta = {};
            if (typeof jsonData.provider === 'string' && jsonData.provider.trim()) meta.provider = jsonData.provider;
            if (typeof jsonData.model === 'string' && jsonData.model.trim()) meta.model = jsonData.model;
            if (typeof jsonData.session_id === 'string' && jsonData.session_id.trim()) meta.session_id = jsonData.session_id;
            if (jsonData.usage && typeof jsonData.usage === 'object') meta.usage = jsonData.usage as CLIBridgeUsage;
            if (typeof jsonData.duration_ms === 'number' && Number.isFinite(jsonData.duration_ms)) meta.duration_ms = jsonData.duration_ms;
            if (meta.duration_ms == null) meta.duration_ms = Date.now() - modelCallStartedAt;
            completionMeta = Object.keys(meta).length > 0 ? meta : null;

            sendMessage({
              type: 'activity',
              session_id: sessionId,
              persona_id: persona.id,
              phase: 'clibridge_stream_done',
              backend_provider: analysisBackend.provider,
              backend_model: analysisBackend.model,
              meta: completionMeta || null,
              message: 'Model stream complete',
              at: new Date().toISOString(),
            });
            receivedDoneEvent = true;
            return;
          }

          if (jsonData.type === 'error') {
            const err = typeof jsonData.error === 'string' ? jsonData.error : 'CLIBridge returned an error event';
            throw new Error(err);
          }
        };

        try {
          while (true) {
            const now = Date.now();
            const totalRemaining = STREAM_TOTAL_TIMEOUT_MS - (now - streamStartedAt);
            const idleRemaining = STREAM_IDLE_TIMEOUT_MS - (now - lastActivityAt);
            const timeoutMs = Math.min(totalRemaining, idleRemaining);

            if (timeoutMs <= 0) {
              streamTimedOut = true;
              break;
            }

            const { done, value } = await readWithTimeout(timeoutMs);

            if (done) {
              break;
            }

            if (!value) {
              continue;
            }

            lastActivityAt = Date.now();
            receivedAnyBytes = true;
            chunkCount++;
            buffer += decoder.decode(value, { stream: true });

            let newlineIndex = buffer.indexOf('\n');
            while (newlineIndex !== -1) {
              let line = buffer.slice(0, newlineIndex);
              buffer = buffer.slice(newlineIndex + 1);

              // Handle CRLF
              if (line.endsWith('\r')) line = line.slice(0, -1);

              if (line.startsWith('data:')) {
                // "data:" may or may not be followed by a single space.
                let payload = line.slice(5);
                if (payload.startsWith(' ')) payload = payload.slice(1);
                sseEventCount++;
                handleEventData(payload);
                if (receivedDoneEvent) break;
              }

              newlineIndex = buffer.indexOf('\n');
            }

            if (receivedDoneEvent) {
              break;
            }
          }

          // Process any remaining buffered data.
          if (!receivedDoneEvent && buffer.length > 0) {
            let line = buffer;
            if (line.endsWith('\r')) line = line.slice(0, -1);
            if (line.startsWith('data:')) {
              let payload = line.slice(5);
              if (payload.startsWith(' ')) payload = payload.slice(1);
              sseEventCount++;
              handleEventData(payload);
            }
          }
        } catch (streamError) {
          console.error(`Streaming failed for persona ${persona.id}:`, streamError);
          const msg = streamError instanceof Error ? streamError.message : String(streamError);
          if (msg.toLowerCase().includes('timed out') || msg.toLowerCase().includes('timeout')) {
            streamTimedOut = true;
          }
        } finally {
          try {
            await reader.cancel();
          } catch (_cancelError) {
            // Ignore cancellation errors
          }
        }
      } else {
        if (!isSse) {
          console.warn(`CLIBridge returned non-SSE response for persona ${persona.id}: content-type=${contentType || 'unknown'}`);
        }
        const text = await response.text();
        if (text) receivedAnyBytes = true;
        const payload = this.extractCompletionPayload(text);
        fullResponse = payload.text;
        completionMeta = payload.meta || null;
      }

      console.log(`CLIBridge response stats for persona ${persona.id}: chunks=${chunkCount}, sseEvents=${sseEventCount}, receivedAnyBytes=${receivedAnyBytes}, responseChars=${fullResponse.length}`);

      // Fallback: if streaming produced nothing usable, try /v1/complete.
      if (streamTimedOut || fullResponse.trim().length === 0) {
        console.warn(`No usable streaming response from CLIBridge for persona ${persona.id}${streamTimedOut ? ' (stream timeout)' : ''}; falling back to complete endpoint`);
        sendMessage({
          type: 'activity',
          session_id: sessionId,
          persona_id: persona.id,
          phase: 'clibridge_complete_fallback_start',
          backend_provider: analysisBackend.provider,
          backend_model: analysisBackend.model,
          message: 'Falling back to non-streaming completion',
          at: new Date().toISOString(),
        });
        const completeResponse = await clibridge.completeAnalysis(analysisRequest);

        if (!completeResponse.ok) {
          const errorText = await completeResponse.text();
          throw new Error(`CLIBridge complete returned ${completeResponse.status}: ${completeResponse.statusText} - ${errorText.substring(0, 200)}`);
        }

        const completeRaw = await completeResponse.text();
        const payload = this.extractCompletionPayload(completeRaw);
        fullResponse = payload.text;
        completionMeta = payload.meta || completionMeta;
        if (completionMeta && completionMeta.duration_ms == null) completionMeta.duration_ms = Date.now() - modelCallStartedAt;
        console.log(`CLIBridge complete fallback response length for persona ${persona.id}: ${fullResponse.length}`);

        sendMessage({
          type: 'activity',
          session_id: sessionId,
          persona_id: persona.id,
          phase: 'clibridge_complete_fallback_done',
          backend_provider: analysisBackend.provider,
          backend_model: analysisBackend.model,
          meta: completionMeta || null,
          message: 'Non-streaming completion done',
          at: new Date().toISOString(),
        });
      }

      if (fullResponse.trim().length === 0) {
        throw new Error('No response data received from CLIBridge');
      }

      // Parse final result
      console.log(`Parsing result for persona ${persona.id}, response length: ${fullResponse.length}`);
      let result: any;
      let parseError: string | null = null;
      try {
        result = await this.parseRoundtableResultFromText(fullResponse, persona);
      } catch (e) {
        // If parsing fails, treat the whole response as the verdict
        parseError = String(e);
        console.error(`Failed to parse JSON for persona ${persona.id}:`, parseError);
        console.log(`Full response was: ${fullResponse.substring(0, 500)}...`);
        result = this.fallbackResultFromText(fullResponse, persona);
      }

      // Only send complete message if we have a valid result
      if (result) {
        console.log(`Sending complete message for persona ${persona.id}`);
        // Send complete message
        sendMessage({
          type: 'complete',
          persona_id: persona.id,
          result,
        });

        // Save to D1
        if (analysis) {
          console.log(`Saving analysis to D1 for persona ${persona.id}`);
          await db.updateAnalysis(analysis.id, {
            status: 'completed',
            error_message: (parseError ? `Non-JSON model output: ${parseError}` : null) as any,
            score_json: JSON.stringify(result.dimension_scores || {}),
            top_issues_json: JSON.stringify(result.top_3_issues || []),
            rewritten_suggestions_json: JSON.stringify({
              what_works_well: result.what_works_well || [],
              overall_verdict: result.overall_verdict || '',
              rewritten_headline: result.rewritten_headline_suggestion || '',
            }),
            completed_at: new Date().toISOString(),
          });
          console.log(`Successfully saved analysis to D1 for persona ${persona.id}`);
        }
      }

    } catch (error) {
      console.error(`Error processing persona ${persona.id}:`, error);
      const errorString = String(error);
      let userFriendlyError = errorString;
      
      // Provide more context for common errors
      if (errorString.includes('Too many subrequests')) {
        userFriendlyError = 'System is busy processing requests. Please try again.';
      } else if (errorString.includes('520')) {
        userFriendlyError = 'Temporary connectivity issue with analysis service. Please try again.';
      }
      
      console.log(`Sending error message for persona ${persona.id}:`, userFriendlyError);
      sendMessage({
        type: 'error',
        persona_id: persona.id,
        error: userFriendlyError,
      });
      
      const analyses = await db.getAnalyses(sessionId);
      const analysis = analyses.find(a => a.persona_id === persona.id);
      if (analysis) {
        await db.updateAnalysis(analysis.id, {
          status: 'failed',
          error_message: String(error),
          completed_at: new Date().toISOString(),
          analysis_provider: analysisBackend.provider,
          analysis_model: analysisBackend.model,
        });
      }
    }
  }

  private buildSystemPrompt(persona: any): string {
    const profile = JSON.parse(persona.profile_json);
    
    return `You are ${profile.name}, a ${profile.role}.

BACKGROUND:
${profile.background}

PROFESSIONAL PRIORITIES:
${profile.professional_priorities.join('\n')}

MARKETING PET PEEVES:
${profile.marketing_pet_peeves.join('\n')}

EVALUATION RUBRIC:
${Object.entries(profile.evaluation_rubric).map(([k, v]) => `${k}: ${v}`).join('\n')}

CONVINCE ME CRITERIA:
${profile.convince_me_criteria}

VOICE AND TONE:
${profile.voice_and_tone}

TYPICAL OBJECTIONS:
${profile.typical_objections.join('\n')}

EVALUATION FRAMEWORK:
Score each dimension from 1-10 and provide specific commentary.
- relevance: Does this speak to my actual priorities and pain points?
- technical_credibility: Is it accurate? Does it avoid buzzword-stuffing?
- differentiation: Can I tell how this is different from competitors?
- actionability: Do I know what to do next after reading this?
- trust_signals: Does this build or erode my trust? Why?
- language_fit: Does this sound like it was written by someone who understands my world?

OUTPUT FORMAT:
Respond with ONLY valid JSON (no markdown, no code blocks, no extra text). Use this exact shape:
{
  "persona_role": "${profile.role}",
  "overall_score": 7,
  "dimension_scores": {
    "relevance": { "score": 8, "commentary": "..." },
    "technical_credibility": { "score": 6, "commentary": "..." },
    "differentiation": { "score": 5, "commentary": "..." },
    "actionability": { "score": 7, "commentary": "..." },
    "trust_signals": { "score": 6, "commentary": "..." },
    "language_fit": { "score": 7, "commentary": "..." }
  },
  "top_3_issues": [
    { "issue": "...", "specific_example_from_content": "...", "suggested_rewrite": "..." },
    { "issue": "...", "specific_example_from_content": "...", "suggested_rewrite": "..." },
    { "issue": "...", "specific_example_from_content": "...", "suggested_rewrite": "..." }
  ],
  "what_works_well": ["...", "..."],
  "overall_verdict": "...",
  "rewritten_headline_suggestion": "..."
}`;
  }

  private extractCompletionPayload(raw: string): CLIBridgeCompletion {
    const trimmed = (raw || '').trim();
    if (!trimmed) return { text: '', meta: null };

    // CLIBridge complete typically returns JSON:
    // { response, provider, model, session_id, usage, duration_ms }
    try {
      const parsed: any = JSON.parse(trimmed);
      if (typeof parsed === 'string') {
        return { text: parsed, meta: null };
      }

      if (parsed && typeof parsed === 'object') {
        const candidates = [
          parsed.response,
          parsed.text,
          parsed.completion,
          parsed.content,
          parsed.message,
          parsed.output,
        ];

        let text = '';
        for (const c of candidates) {
          if (typeof c === 'string' && c.trim()) {
            text = c;
            break;
          }
        }

        const meta: CLIBridgeCompletionMeta = {};
        if (typeof parsed.provider === 'string' && parsed.provider.trim()) meta.provider = parsed.provider;
        if (typeof parsed.model === 'string' && parsed.model.trim()) meta.model = parsed.model;
        if (typeof parsed.session_id === 'string' && parsed.session_id.trim()) meta.session_id = parsed.session_id;
        if (parsed.usage && typeof parsed.usage === 'object') meta.usage = parsed.usage as CLIBridgeUsage;
        if (typeof parsed.duration_ms === 'number' && Number.isFinite(parsed.duration_ms)) meta.duration_ms = parsed.duration_ms;

        return { text: text || raw, meta: Object.keys(meta).length > 0 ? meta : null };
      }
    } catch (_e) {
      // Not JSON.
    }

    return { text: raw, meta: null };
  }

  private extractCompletionText(raw: string): string {
    return this.extractCompletionPayload(raw).text;
  }

  private normalizeResult(result: any, persona: any): any {
    const role = persona?.role || 'Unknown Persona';

    if (!result || typeof result !== 'object') {
      return {
        persona_role: role,
        overall_score: 0,
        dimension_scores: {},
        top_3_issues: [],
        what_works_well: [],
        overall_verdict: '',
        rewritten_headline_suggestion: '',
      };
    }

    const normalized: any = { ...result };

    if (typeof normalized.persona_role !== 'string' || !normalized.persona_role.trim()) {
      normalized.persona_role = role;
    }

    if (typeof normalized.overall_score !== 'number') {
      const n = Number(normalized.overall_score);
      normalized.overall_score = Number.isFinite(n) ? n : 0;
    }

    const expectedDims = [
      'relevance',
      'technical_credibility',
      'differentiation',
      'actionability',
      'trust_signals',
      'language_fit',
    ];

    if (!normalized.dimension_scores || typeof normalized.dimension_scores !== 'object') {
      normalized.dimension_scores = {};
    }

    for (const dim of expectedDims) {
      const v = (normalized.dimension_scores as any)[dim];
      if (typeof v === 'number') {
        (normalized.dimension_scores as any)[dim] = { score: v, commentary: '' };
      } else if (typeof v === 'string') {
        const maybeScore = Number(v);
        (normalized.dimension_scores as any)[dim] = Number.isFinite(maybeScore)
          ? { score: maybeScore, commentary: '' }
          : { score: 0, commentary: v };
      } else if (v && typeof v === 'object') {
        const score = typeof v.score === 'number' ? v.score : Number(v.score);
        (normalized.dimension_scores as any)[dim] = {
          score: Number.isFinite(score) ? score : 0,
          commentary: typeof v.commentary === 'string' ? v.commentary : (typeof v.comment === 'string' ? v.comment : ''),
        };
      } else {
        (normalized.dimension_scores as any)[dim] = { score: 0, commentary: '' };
      }
    }

    if (!Array.isArray(normalized.top_3_issues)) {
      normalized.top_3_issues = [];
    }
    normalized.top_3_issues = (normalized.top_3_issues as any[]).slice(0, 3).map((issue: any) => {
      if (typeof issue === 'string') {
        return { issue, specific_example_from_content: '', suggested_rewrite: '' };
      }
      if (issue && typeof issue === 'object') {
        return {
          issue: typeof issue.issue === 'string' ? issue.issue : '',
          specific_example_from_content: typeof issue.specific_example_from_content === 'string' ? issue.specific_example_from_content : '',
          suggested_rewrite: typeof issue.suggested_rewrite === 'string' ? issue.suggested_rewrite : '',
        };
      }
      return { issue: '', specific_example_from_content: '', suggested_rewrite: '' };
    });

    if (!Array.isArray(normalized.what_works_well)) {
      normalized.what_works_well = typeof normalized.what_works_well === 'string'
        ? [normalized.what_works_well]
        : [];
    }

    if (typeof normalized.overall_verdict !== 'string') {
      normalized.overall_verdict = normalized.overall_verdict != null ? String(normalized.overall_verdict) : '';
    }

    if (typeof normalized.rewritten_headline_suggestion !== 'string') {
      normalized.rewritten_headline_suggestion = normalized.rewritten_headline_suggestion != null
        ? String(normalized.rewritten_headline_suggestion)
        : '';
    }

    return normalized;
  }
}
