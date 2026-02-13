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
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    
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

      // Use global settings for the next analysis run.
      const DEFAULT_ANALYSIS_PROVIDER = 'claude';
      const DEFAULT_ANALYSIS_MODEL = 'sonnet';

      const configuredProvider = (await db.getSettingValue('analysis_provider'))?.trim();
      const configuredModel = (await db.getSettingValue('analysis_model'))?.trim();

      const analysisBackend = {
        provider: configuredProvider || DEFAULT_ANALYSIS_PROVIDER,
        model: configuredModel || DEFAULT_ANALYSIS_MODEL,
      };

      console.log(`Analysis backend for session ${sessionId}:`, analysisBackend);

      // Start analyses with limited concurrency to avoid Cloudflare subrequest limits
      const maxConcurrency = 2; // Reduce to 2 concurrent analyses to be more conservative
      for (let i = 0; i < personas.length; i += maxConcurrency) {
        const batch = personas.slice(i, i + maxConcurrency);
        const analysisPromises = batch.map(persona =>
          this.analyzePersona(sessionId, persona, documentText, sendMessage, db, analysisBackend)
        );
        await Promise.all(analysisPromises);
      }

      // All complete
      sendMessage({
        type: 'all_complete',
        session_id: sessionId,
      });

      // Set session status based on analysis outcomes
      const finalAnalyses = await db.getAnalyses(sessionId);
      const failedCount = finalAnalyses.filter(a => a.status === 'failed').length;
      const completedCount = finalAnalyses.filter(a => a.status === 'completed').length;

      let finalStatus: 'completed' | 'failed' | 'partial' = 'completed';
      if (finalAnalyses.length > 0 && failedCount === finalAnalyses.length) {
        finalStatus = 'failed';
      } else if (failedCount > 0) {
        finalStatus = 'partial';
      } else if (completedCount === finalAnalyses.length) {
        finalStatus = 'completed';
      }

      await db.updateSession(sessionId, { status: finalStatus });
      sendMessage({ type: 'status', session_id: sessionId, status: finalStatus });

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
      if (analysis) {
        await db.updateAnalysis(analysis.id, { status: 'running' });
      }
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

      console.log(`Calling CLIBridge for persona ${persona.id}`);
      console.log(`Document text length: ${documentText.length} (sent: ${documentForAnalysis.length})`);
      console.log(`System prompt length: ${systemPrompt.length}`);

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
              fullResponse += doneText;
            }
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
        fullResponse = text;
      }

      console.log(`CLIBridge response stats for persona ${persona.id}: chunks=${chunkCount}, sseEvents=${sseEventCount}, receivedAnyBytes=${receivedAnyBytes}, responseChars=${fullResponse.length}`);

      // Fallback: if streaming produced nothing usable, try /v1/complete.
      if (streamTimedOut || fullResponse.trim().length === 0) {
        console.warn(`No usable streaming response from CLIBridge for persona ${persona.id}${streamTimedOut ? ' (stream timeout)' : ''}; falling back to complete endpoint`);
        const completeResponse = await clibridge.completeAnalysis(analysisRequest);

        if (!completeResponse.ok) {
          const errorText = await completeResponse.text();
          throw new Error(`CLIBridge complete returned ${completeResponse.status}: ${completeResponse.statusText} - ${errorText.substring(0, 200)}`);
        }

        const completeRaw = await completeResponse.text();
        fullResponse = this.extractCompletionText(completeRaw);
        console.log(`CLIBridge complete fallback response length for persona ${persona.id}: ${fullResponse.length}`);
      }

      if (fullResponse.trim().length === 0) {
        throw new Error('No response data received from CLIBridge');
      }

      // Parse final result
      console.log(`Parsing result for persona ${persona.id}, response length: ${fullResponse.length}`);
      let result;
      try {
        // Try to extract JSON from the response
        const jsonMatch = fullResponse.match(/```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/);
        if (jsonMatch) {
          result = JSON.parse(jsonMatch[1]);
          console.log(`Parsed JSON result for persona ${persona.id}`);
        } else {
          const trimmed = fullResponse.trim();
          try {
            result = JSON.parse(trimmed);
            console.log(`Parsed direct JSON result for persona ${persona.id}`);
          } catch (_directParseError) {
            // Best-effort: extract a JSON object from surrounding text.
            const firstBrace = trimmed.indexOf('{');
            const lastBrace = trimmed.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
              const maybeJson = trimmed.slice(firstBrace, lastBrace + 1);
              result = JSON.parse(maybeJson);
              console.log(`Parsed extracted JSON object for persona ${persona.id}`);
            } else {
              throw _directParseError;
            }
          }
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

      result = this.normalizeResult(result, persona);

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

  private extractCompletionText(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return '';

    // CLIBridge complete may return plain text or JSON-wrapped text. Handle both.
    try {
      const parsed: any = JSON.parse(trimmed);
      if (typeof parsed === 'string') return parsed;
      if (parsed && typeof parsed === 'object') {
        const candidates = [
          parsed.response,
          parsed.text,
          parsed.completion,
          parsed.content,
          parsed.message,
          parsed.output,
        ];
        for (const c of candidates) {
          if (typeof c === 'string' && c.trim()) return c;
        }
      }
    } catch (_e) {
      // Not JSON.
    }

    return raw;
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
