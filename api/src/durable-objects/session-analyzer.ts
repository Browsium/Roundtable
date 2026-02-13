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
  private analysisStarted: boolean = false;

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
    // Prevent duplicate analysis starts
    if (this.analysisStarted) {
      console.log(`Analysis already started for session ${sessionId}, ignoring duplicate request`);
      return;
    }
    
    this.analysisStarted = true;
    console.log(`Starting analysis for session ${sessionId}`);
    
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
      console.log(`Extracting text from document, buffer size: ${fileBuffer.byteLength} bytes`);
      const extractedDoc = await extractTextFromDocument(
        fileBuffer,
        session.file_extension
      );
      const documentText = extractedDoc.text;
      console.log(`Extracted document text, length: ${documentText.length}`);
      console.log(`First 200 chars of document: ${documentText.substring(0, 200)}`);
      
      // Check if extraction returned an error message
      if (documentText.startsWith('[') && documentText.includes('document:') && documentText.includes('error')) {
        console.warn('Document extraction appears to have failed, sending error to frontend');
        sendMessage({
          type: 'error',
          error: 'Failed to process document: ' + documentText,
        });
        await db.updateSession(sessionId, { status: 'failed' });
        return;
      }

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

      // Start analyses with limited concurrency to avoid Cloudflare subrequest limits
      const maxConcurrency = 2; // Reduce to 2 concurrent analyses to be more conservative
      for (let i = 0; i < personas.length; i += maxConcurrency) {
        const batch = personas.slice(i, i + maxConcurrency);
        const analysisPromises = batch.map(persona =>
          this.analyzePersona(sessionId, persona, documentText, sendMessage, db)
        );
        await Promise.all(analysisPromises);
      }

      // All complete
      sendMessage({
        type: 'all_complete',
        session_id: sessionId,
      });

      await db.updateSession(sessionId, { status: 'completed' });

  } catch (error) {
    const errorMessage = String(error);
    console.error('Analysis failed:', errorMessage);
    
    // Provide more context for common errors
    let userFriendlyError = errorMessage;
    if (errorMessage.includes('Too many subrequests')) {
      userFriendlyError = 'System is processing too many requests simultaneously. Please try again with fewer personas selected.';
    }
    
    console.log('Sending session error message:', userFriendlyError);
    sendMessage({
      type: 'error',
      error: userFriendlyError,
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
    console.log(`Starting analyzePersona for ${persona.id} in session ${sessionId}`);
    
    try {
      // Get existing analysis or create new one
      let analyses = await db.getAnalyses(sessionId);
      let analysis = analyses.find(a => a.persona_id === persona.id);
      
      if (!analysis) {
        analysis = await db.createAnalysis({
          session_id: sessionId,
          persona_id: persona.id,
          status: 'pending',
        });
      }

      // Update status to running
      await db.updateAnalysis(analysis.id, { status: 'running' });
      sendMessage({
        type: 'status',
        persona_id: persona.id,
        status: 'running',
      });

      // Initialize CLIBridge client
      console.log(`Initializing CLIBridge client for persona ${persona.id}`);
      const clibridge = new CLIBridgeClient(this.env);

      // Update analysis status
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
      const systemPrompt = this.buildSystemPrompt(persona);
      console.log(`Calling CLIBridge for persona ${persona.id}`);
      console.log(`Document text length: ${documentText.length}`);
      console.log(`System prompt length: ${systemPrompt.length}`);
      console.log(`First 200 chars of document: ${documentText.substring(0, 200)}`);
      console.log(`First 200 chars of system prompt: ${systemPrompt.substring(0, 200)}`);
      
      const response = await clibridge.streamAnalysis({
        provider: 'claude',
        model: 'sonnet',
        systemPrompt: systemPrompt,
        messages: [
          { role: 'user', content: documentText },
        ],
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

      // Stream chunks
      console.log(`Starting to stream response for persona ${persona.id}`);
      let fullResponse = '';
      const reader = response.body?.getReader();
      let streamingCompleted = false;
      let chunkCount = 0;

      if (reader) {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              console.log(`Stream completed normally for persona ${persona.id}, chunks: ${chunkCount}, response length: ${fullResponse.length}`);
              streamingCompleted = true;
              break;
            }

            chunkCount++;
            const chunk = new TextDecoder().decode(value);
            console.log(`Received chunk ${chunkCount} for persona ${persona.id} (${chunk.length} bytes)`);
            
            // Process SSE format directly
            const lines = chunk.split('\n');
            for (const line of lines) {
              if (line.startsWith('data: ')) {
                try {
                  const jsonData = JSON.parse(line.substring(6));
                  console.log(`Parsed SSE data for ${persona.id}:`, jsonData.type);
                  if (jsonData.type === 'chunk' && jsonData.text) {
                    fullResponse += jsonData.text;
                    console.log(`Added chunk text for ${persona.id}, total length: ${fullResponse.length}`);
                    // Send chunk to frontend
                    sendMessage({
                      type: 'chunk',
                      persona_id: persona.id,
                      text: jsonData.text,
                    });
                  } else if (jsonData.type === 'done' && jsonData.response) {
                    fullResponse += jsonData.response;
                    console.log(`Added done response for ${persona.id}, total length: ${fullResponse.length}`);
                  }
                } catch (parseError) {
                  console.warn(`Failed to parse SSE data for persona ${persona.id}:`, line.substring(0, 100));
                }
              }
            }
          }
        } catch (streamError) {
          console.error(`Streaming failed for persona ${persona.id}:`, streamError);
          // Even if streaming failed, we might have partial content
          console.log(`Streaming failed but had content length: ${fullResponse.length} for persona ${persona.id}`);
          // Continue with whatever content we have
        } finally {
          try {
            await reader.cancel();
            console.log(`Reader cancelled for persona ${persona.id}`);
          } catch (cancelError) {
            console.error(`Failed to cancel reader for persona ${persona.id}:`, cancelError);
          }
        }
      } else {
        console.warn(`No readable stream for persona ${persona.id}`);
      }
      
      console.log(`Final response stats for persona ${persona.id}: chunks=${chunkCount}, length=${fullResponse.length}, completed=${streamingCompleted}`);
      
      // Always attempt to parse what we have, even if streaming didn't complete normally
      if (fullResponse.length === 0) {
        console.warn(`No response data received for persona ${persona.id}`);
        throw new Error('No response data received from CLIBridge');
      }
      console.log(`Final full response length for persona ${persona.id}: ${fullResponse.length}`);

      // Only proceed with parsing if streaming was successful
      if (!streamingSuccess && fullResponse.length === 0) {
        console.warn(`No response data received for persona ${persona.id}`);
        throw new Error('No response data received from CLIBridge');
      }

      // Parse final result
      console.log(`Parsing result for persona ${persona.id}, response length: ${fullResponse.length}`);
      let result;
      try {
        // Try to extract JSON from the response
        const jsonMatch = fullResponse.match(/```json\n([\s\S]*?)\n```/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[1]);
          console.log(`Parsed JSON result for persona ${persona.id}`);
        } else {
          result = JSON.parse(fullResponse);
          console.log(`Parsed direct JSON result for persona ${persona.id}`);
        }
      } catch (parseError) {
        // If parsing fails, treat the whole response as the verdict
        console.error(`Failed to parse JSON for persona ${persona.id}:`, parseError);
        console.log(`Full response was: ${fullResponse.substring(0, 500)}...`);
        result = {
          persona_role: persona.role,
          overall_score: 0,
          dimension_scores: {},
          top_3_issues: [],
          what_works_well: [],
          overall_verdict: fullResponse || 'No response received',
          rewritten_headline_suggestion: '',
        };
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
