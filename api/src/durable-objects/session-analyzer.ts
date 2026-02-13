import type { DurableObjectState, WebSocket } from '@cloudflare/workers-types';
import type { Env } from '../index';
import { D1Client } from '../lib/d1';
import { CLIBridgeClient } from '../lib/clibridge';
import { extractTextFromDocument } from '../lib/document-processor';

interface AnalysisMessage {
  type: 'chunk' | 'complete' | 'error' | 'all_complete';
  persona_id?: string;
  text?: string;
  result?: any;
  error?: string;
  session_id?: string;
}

export class SessionAnalyzer {
  private state: DurableObjectState;
  private env: Env;
  private websockets: Set<WebSocket> = new Set();

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
      const body = await request.json() as { session_id: string };
      // Start analysis asynchronously
      this.startAnalysis(body.session_id);
      return new Response(JSON.stringify({ message: 'Analysis started' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair()) as [WebSocket, WebSocket];
    
    this.websockets.add(server);
    
    server.accept();
    
    server.addEventListener('message', async (event) => {
      try {
        const data = JSON.parse(event.data as string);
        
        if (data.action === 'start_analysis') {
          await this.startAnalysis(data.session_id, server);
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
    });
    
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  private async startAnalysis(sessionId: string, ws?: WebSocket): Promise<void> {
    const db = new D1Client(this.env.DB);

    const sendMessage = (msg: any) => {
      // Send to specific WebSocket if provided and open
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
        return;
      }
      
      // Otherwise broadcast to all connected websockets (excluding the specific one if it exists)
      this.websockets.forEach(socket => {
        if (socket !== ws && socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify(msg));
        }
      });
    };

    try {
      // Get session
      const session = await db.getSession(sessionId);
      if (!session) {
        sendMessage({
          type: 'error',
          error: 'Session not found',
        });
        return;
      }

      // Update session status
      await db.updateSession(sessionId, { status: 'analyzing' });
      sendMessage({ type: 'status', session_id: sessionId, status: 'analyzing' });

      // Get document from R2
      const r2Object = await this.env.R2.get(session.file_r2_key);
      if (!r2Object) {
        sendMessage({
          type: 'error',
          error: 'Document not found in storage',
        });
        await db.updateSession(sessionId, { status: 'failed' });
        return;
      }

      // Extract text
      const fileBuffer = await r2Object.arrayBuffer();
      const { text: documentText } = await extractTextFromDocument(
        fileBuffer,
        session.file_extension
      );

      // Get personas
      const selectedPersonaIds = JSON.parse(session.selected_persona_ids);
      const personas = [];
      for (const personaId of selectedPersonaIds) {
        const persona = await db.getPersona(personaId);
        if (persona) {
          personas.push(persona);
        }
      }

      if (personas.length === 0) {
        sendMessage({
          type: 'error',
          error: 'No valid personas found',
        });
        await db.updateSession(sessionId, { status: 'failed' });
        return;
      }

      // Start analyses concurrently
      const analysisPromises = personas.map(persona =>
        this.analyzePersona(sessionId, persona, documentText, sendMessage, db)
      );

      await Promise.all(analysisPromises);

      // All complete
      sendMessage({
        type: 'all_complete',
        session_id: sessionId,
      });

      await db.updateSession(sessionId, { status: 'completed' });

  } catch (error) {
    const errorMessage = String(error);
    console.error('Analysis failed:', errorMessage);
    sendMessage({
      type: 'error',
      error: errorMessage,
    });
    await db.updateSession(sessionId, { status: 'failed', error_message: errorMessage });
    
    // Mark all pending analyses as failed
    const analyses = await db.getAnalyses(sessionId);
    for (const analysis of analyses) {
      if (analysis.status === 'pending' || analysis.status === 'running') {
        await db.updateAnalysis(analysis.id, {
          status: 'failed',
          error_message: errorMessage,
          completed_at: new Date().toISOString(),
        });
      }
    }
  }
}

  private async analyzePersona(
    sessionId: string,
    persona: any,
    documentText: string,
    sendMessage: (msg: any) => void,
    db: D1Client
  ): Promise<void> {
    const clibridge = new CLIBridgeClient(this.env);

    try {
      // Update analysis status
      const analyses = await db.getAnalyses(sessionId);
      const analysis = analyses.find(a => a.persona_id === persona.id);
      if (analysis) {
        await db.updateAnalysis(analysis.id, {
          status: 'running',
          started_at: new Date().toISOString(),
        });
      }

      sendMessage({
        type: 'status',
        persona_id: persona.id,
        status: 'running',
      });

      // Call CLIBridge streaming endpoint
      const response = await clibridge.streamAnalysis({
        provider: 'claude',
        model: 'sonnet',
        systemPrompt: this.buildSystemPrompt(persona),
        messages: [
          { role: 'user', content: documentText },
        ],
      });

      // Stream chunks
      let fullResponse = '';
      const reader = response.body?.getReader();

      if (reader) {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = new TextDecoder().decode(value);
          fullResponse += chunk;

          // Send chunk to frontend
          sendMessage({
            type: 'chunk',
            persona_id: persona.id,
            text: chunk,
          });
        }
      }

      // Parse final result
      let result;
      try {
        // Try to extract JSON from the response
        const jsonMatch = fullResponse.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[1]);
        } else {
          result = JSON.parse(fullResponse);
        }
      } catch {
        // If parsing fails, treat the whole response as the verdict
        result = {
          persona_role: persona.role,
          overall_score: 0,
          dimension_scores: {},
          top_3_issues: [],
          what_works_well: [],
          overall_verdict: fullResponse,
          rewritten_headline_suggestion: '',
        };
      }

      // Send complete message
      sendMessage({
        type: 'complete',
        persona_id: persona.id,
        result,
      });

      // Save to D1
      if (analysis) {
        await db.updateAnalysis(analysis.id, {
          status: 'completed',
          score_json: JSON.stringify(result.dimension_scores || {}),
          top_issues_json: JSON.stringify(result.top_3_issues || []),
          rewritten_suggestions_json: JSON.stringify({
            what_works_well: result.what_works_well || [],
            overall_verdict: result.overall_verdict || '',
            rewritten_headline: result.rewritten_headline_suggestion || '',
          }),
          completed_at: new Date().toISOString(),
        });
      }

    } catch (error) {
      sendMessage({
        type: 'error',
        persona_id: persona.id,
        error: String(error),
      });
      
      const analyses = await db.getAnalyses(sessionId);
      const analysis = analyses.find(a => a.persona_id === persona.id);
      if (analysis) {
        await db.updateAnalysis(analysis.id, {
          status: 'failed',
          error_message: String(error),
          completed_at: new Date().toISOString(),
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

Please evaluate the marketing content and provide your analysis in JSON format with these fields:
- persona_role
- overall_score (1-10)
- dimension_scores (with relevance, technical_credibility, differentiation, actionability, trust_signals, language_fit)
- top_3_issues
- what_works_well
- overall_verdict
- rewritten_headline_suggestion`;
  }
}
