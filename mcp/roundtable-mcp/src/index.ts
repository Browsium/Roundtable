#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import mime from 'mime-types';
import {
  buildExportModel,
  exportToCsv,
  exportToDocxBytes,
  exportToMarkdown,
  exportToPdfBytes,
  makeExportFilename,
  type ExportFormat,
  type Persona,
  type Session,
} from './export.js';

type JsonObject = Record<string, any>;

const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

const DEFAULT_API_URL = process.env.ROUNDTABLE_API_URL || 'https://roundtable-api.browsium.workers.dev';
const DEFAULT_FAST_PANEL = [
  'ciso_enterprise',
  'cio_enterprise',
  'cto_enterprise',
  'compliance_officer_enterprise',
  'security_consulting_leader',
];

function getEnv(key: string): string {
  return (process.env[key] || '').trim();
}

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};

  const clientId = getEnv('ROUNDTABLE_CF_ACCESS_CLIENT_ID');
  const clientSecret = getEnv('ROUNDTABLE_CF_ACCESS_CLIENT_SECRET');
  if (clientId && clientSecret) {
    headers['CF-Access-Client-Id'] = clientId;
    headers['CF-Access-Client-Secret'] = clientSecret;
  }

  // Optional: if you're using a service token (no user identity), you can pin
  // ownership to a specific email for Roundtable session isolation.
  const userEmail = getEnv('ROUNDTABLE_USER_EMAIL');
  if (userEmail) {
    headers['CF-Access-Authenticated-User-Email'] = userEmail;
  }

  return headers;
}

function joinUrl(base: string, p: string): string {
  const b = base.replace(/\/+$/, '');
  const pp = p.startsWith('/') ? p : `/${p}`;
  return `${b}${pp}`;
}

async function apiFetch(apiUrl: string, p: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {
    ...getAuthHeaders(),
    ...(init?.headers ? (init.headers as any) : {}),
  };

  const url = joinUrl(apiUrl, p);
  return await fetch(url, {
    ...init,
    headers,
  });
}

async function fetchJson<T>(apiUrl: string, p: string, init?: RequestInit): Promise<T> {
  const resp = await apiFetch(apiUrl, p, init);
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`API ${init?.method || 'GET'} ${p} failed: ${resp.status} ${resp.statusText}${text ? ` - ${text.slice(0, 500)}` : ''}`);
  }
  return await resp.json() as T;
}

function asStringArray(v: any): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function extFromFilename(filename: string): string {
  const ext = path.extname(filename || '').replace(/^\./, '').trim().toLowerCase();
  return ext || 'txt';
}

function contentTypeForFilename(filename: string): string {
  const mt = mime.lookup(filename || '');
  return (typeof mt === 'string' && mt.trim()) ? mt : 'application/octet-stream';
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buf = bytes.buffer as ArrayBuffer;
  return buf.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

async function readInputBytes(args: JsonObject): Promise<{ filename: string; bytes: Uint8Array; contentType: string }> {
  const filePath = typeof args.file_path === 'string' ? args.file_path.trim() : '';
  const content = typeof args.content === 'string' ? args.content : '';
  const filename = typeof args.filename === 'string' ? args.filename.trim() : '';

  if (filePath) {
    const resolved = path.resolve(process.cwd(), filePath);
    const data = await fs.readFile(resolved);
    const actualName = path.basename(resolved);
    return {
      filename: actualName,
      bytes: new Uint8Array(data),
      contentType: contentTypeForFilename(actualName),
    };
  }

  if (content && filename) {
    const enc = new TextEncoder();
    const bytes = enc.encode(content);
    return {
      filename,
      bytes,
      contentType: contentTypeForFilename(filename),
    };
  }

  throw new Error('Provide either file_path OR (content + filename).');
}

async function listPersonas(apiUrl: string): Promise<Persona[]> {
  return await fetchJson<Persona[]>(apiUrl, '/personas');
}

async function createPersona(apiUrl: string, profileJson: any): Promise<any> {
  if (!profileJson || typeof profileJson !== 'object') {
    throw new Error('profile_json must be an object');
  }
  return await fetchJson<any>(apiUrl, '/personas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile_json: profileJson }),
  });
}

async function updatePersona(apiUrl: string, personaId: string, profileJson: any): Promise<any> {
  if (!personaId) throw new Error('persona_id is required');
  if (!profileJson || typeof profileJson !== 'object') {
    throw new Error('profile_json must be an object');
  }
  return await fetchJson<any>(apiUrl, `/personas/${encodeURIComponent(personaId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile_json: profileJson }),
  });
}

async function deployPersona(apiUrl: string, personaId: string): Promise<any> {
  if (!personaId) throw new Error('persona_id is required');
  return await fetchJson<any>(apiUrl, `/personas/${encodeURIComponent(personaId)}/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

async function getSession(apiUrl: string, sessionId: string): Promise<Session> {
  return await fetchJson<Session>(apiUrl, `/sessions/${encodeURIComponent(sessionId)}`);
}

async function pollSessionUntilDone(apiUrl: string, sessionId: string, timeoutSeconds: number, pollIntervalSeconds: number): Promise<Session> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last: Session | null = null;

  while (Date.now() < deadline) {
    last = await getSession(apiUrl, sessionId);
    if (last.status === 'completed' || last.status === 'failed' || last.status === 'partial') {
      return last;
    }
    await new Promise((r) => setTimeout(r, Math.max(250, pollIntervalSeconds * 1000)));
  }

  throw new Error(`Timed out waiting for session ${sessionId} after ${timeoutSeconds}s. Last status: ${last?.status || 'unknown'}`);
}

async function focusGroup(args: JsonObject): Promise<JsonObject> {
  const apiUrl = (typeof args.api_url === 'string' && args.api_url.trim()) ? args.api_url.trim() : DEFAULT_API_URL;

  const { filename, bytes, contentType } = await readInputBytes(args);
  const fileExtension = extFromFilename(filename);

  const panel = (typeof args.panel === 'string' ? args.panel.trim().toLowerCase() : '') || 'full';
  const requestedPersonaIds = asStringArray(args.persona_ids);

  const personas = await listPersonas(apiUrl);
  const personasById = Object.fromEntries(personas.map((p) => [p.id, p]));

  let selectedPersonaIds: string[];
  if (requestedPersonaIds && requestedPersonaIds.length > 0) {
    selectedPersonaIds = requestedPersonaIds;
  } else if (panel === 'fast') {
    selectedPersonaIds = DEFAULT_FAST_PANEL.filter((id) => !!personasById[id]);
  } else {
    selectedPersonaIds = personas.map((p) => p.id);
  }

  if (selectedPersonaIds.length === 0) {
    throw new Error('No personas selected (persona_ids empty and panel produced no matches).');
  }

  const analysisProvider = typeof args.analysis_provider === 'string' ? args.analysis_provider.trim() : '';
  const analysisModel = typeof args.analysis_model === 'string' ? args.analysis_model.trim() : '';
  const hasBackendOverride = !!analysisProvider || !!analysisModel;
  if (hasBackendOverride && (!analysisProvider || !analysisModel)) {
    throw new Error('analysis_provider and analysis_model must be provided together (both non-empty).');
  }

  const createSessionBody: any = {
    file_name: filename,
    file_size_bytes: bytes.byteLength,
    file_extension: fileExtension,
    selected_persona_ids: selectedPersonaIds,
  };
  if (analysisProvider && analysisModel) {
    createSessionBody.analysis_provider = analysisProvider;
    createSessionBody.analysis_model = analysisModel;
  }

  const session = await fetchJson<any>(apiUrl, '/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createSessionBody),
  });

  const sessionId = String(session?.id || '').trim();
  if (!sessionId) {
    throw new Error('Session creation failed: missing id in response');
  }

  // Upload bytes to R2 (via Worker endpoint).
  const uploadPath = `/r2/upload/${encodeURIComponent(sessionId)}/${encodeURIComponent(filename)}`;
  await fetchJson<any>(apiUrl, uploadPath, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: toArrayBuffer(bytes),
  });

  // Trigger analysis.
  await fetchJson<any>(apiUrl, `/sessions/${encodeURIComponent(sessionId)}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });

  const wait = typeof args.wait === 'boolean' ? args.wait : true;
  if (!wait) {
    return {
      session_id: sessionId,
      api_url: apiUrl,
      status: 'started',
      selected_persona_ids: selectedPersonaIds,
    };
  }

  const timeoutSeconds = typeof args.timeout_seconds === 'number' && Number.isFinite(args.timeout_seconds)
    ? Math.max(30, Math.floor(args.timeout_seconds))
    : 900;
  const pollIntervalSeconds = typeof args.poll_interval_seconds === 'number' && Number.isFinite(args.poll_interval_seconds)
    ? Math.max(1, Math.floor(args.poll_interval_seconds))
    : 2;

  const finalSession = await pollSessionUntilDone(apiUrl, sessionId, timeoutSeconds, pollIntervalSeconds);
  const exportModel = buildExportModel(finalSession, personasById);

  return {
    session_id: sessionId,
    api_url: apiUrl,
    status: finalSession.status,
    analysis_backend: exportModel.analysis_backend,
    executive_summary: {
      stats: exportModel.stats,
      dimension_averages: exportModel.dimension_averages,
      common_themes: exportModel.common_themes,
      common_strengths: exportModel.common_strengths,
      recommendations: exportModel.recommendations,
    },
    analyses: exportModel.analyses,
  };
}

async function exportSession(args: JsonObject): Promise<JsonObject> {
  const apiUrl = (typeof args.api_url === 'string' && args.api_url.trim()) ? args.api_url.trim() : DEFAULT_API_URL;
  const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
  if (!sessionId) throw new Error('session_id is required');

  const format = (typeof args.format === 'string' ? args.format.trim().toLowerCase() : '') as ExportFormat;
  if (!format || !['pdf', 'docx', 'csv', 'md'].includes(format)) {
    throw new Error(`format must be one of: pdf, docx, csv, md`);
  }

  const personas = await listPersonas(apiUrl);
  const personasById = Object.fromEntries(personas.map((p) => [p.id, p]));
  const session = await getSession(apiUrl, sessionId);
  const model = buildExportModel(session, personasById);

  const outputDir = typeof args.output_dir === 'string' && args.output_dir.trim()
    ? path.resolve(process.cwd(), args.output_dir.trim())
    : process.cwd();

  await fs.mkdir(outputDir, { recursive: true });

  const outputPath = typeof args.output_path === 'string' && args.output_path.trim()
    ? path.resolve(process.cwd(), args.output_path.trim())
    : path.join(outputDir, makeExportFilename(session.file_name, format));

  if (format === 'md') {
    const md = exportToMarkdown(model);
    await fs.writeFile(outputPath, md, 'utf8');
    return { output_path: outputPath, bytes_written: Buffer.byteLength(md, 'utf8') };
  }

  if (format === 'csv') {
    const csv = exportToCsv(model);
    await fs.writeFile(outputPath, csv, 'utf8');
    return { output_path: outputPath, bytes_written: Buffer.byteLength(csv, 'utf8') };
  }

  if (format === 'pdf') {
    const bytes = await exportToPdfBytes(model);
    await fs.writeFile(outputPath, bytes);
    return { output_path: outputPath, bytes_written: bytes.byteLength };
  }

  if (format === 'docx') {
    const bytes = await exportToDocxBytes(model);
    await fs.writeFile(outputPath, bytes);
    return { output_path: outputPath, bytes_written: bytes.byteLength };
  }

  throw new Error(`Unsupported format: ${format}`);
}

const server = new Server(
  { name: 'roundtable-mcp', version: pkg.version },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'roundtable.list_personas',
        description: 'List Roundtable personas available on the configured Roundtable API.',
        inputSchema: {
          type: 'object',
          properties: {
            api_url: { type: 'string', description: `Override API URL (default: ${DEFAULT_API_URL})` },
          },
        },
      },
      {
        name: 'roundtable.create_persona',
        description: 'Create a new persona in Roundtable (stored in D1).',
        inputSchema: {
          type: 'object',
          properties: {
            api_url: { type: 'string', description: `Override API URL (default: ${DEFAULT_API_URL})` },
            profile_json: { type: 'object', description: 'Persona profile JSON object (must include id/name/role and required persona fields).' },
          },
          required: ['profile_json'],
        },
      },
      {
        name: 'roundtable.update_persona',
        description: 'Update an existing persona in Roundtable. This bumps version and marks it draft until redeployed.',
        inputSchema: {
          type: 'object',
          properties: {
            api_url: { type: 'string', description: `Override API URL (default: ${DEFAULT_API_URL})` },
            persona_id: { type: 'string', description: 'Persona ID to update.' },
            profile_json: { type: 'object', description: 'Updated persona profile JSON object.' },
          },
          required: ['persona_id', 'profile_json'],
        },
      },
      {
        name: 'roundtable.deploy_persona',
        description: 'Deploy a persona to CLIBridge as a generated skill via Roundtable API.',
        inputSchema: {
          type: 'object',
          properties: {
            api_url: { type: 'string', description: `Override API URL (default: ${DEFAULT_API_URL})` },
            persona_id: { type: 'string', description: 'Persona ID to deploy.' },
          },
          required: ['persona_id'],
        },
      },
      {
        name: 'roundtable.focus_group',
        description: 'Submit a document to Roundtable and optionally wait for the focus-group analysis to complete.',
        inputSchema: {
          type: 'object',
          properties: {
            api_url: { type: 'string', description: `Override API URL (default: ${DEFAULT_API_URL})` },
            file_path: { type: 'string', description: 'Path to a local file to analyze.' },
            content: { type: 'string', description: 'Raw content to analyze (if file_path not provided).' },
            filename: { type: 'string', description: 'Filename to use when content is provided (e.g. draft.md).' },
            persona_ids: { type: 'array', items: { type: 'string' }, description: 'Persona IDs to include (overrides panel).' },
            panel: { type: 'string', enum: ['fast', 'full'], description: 'Preset persona selection used when persona_ids is omitted.' },
            analysis_provider: { type: 'string', description: 'Override provider for this session (requires analysis_model).' },
            analysis_model: { type: 'string', description: 'Override model for this session (requires analysis_provider).' },
            wait: { type: 'boolean', description: 'If true, wait for completion and return results (default: true).' },
            timeout_seconds: { type: 'number', description: 'Max seconds to wait when wait=true (default: 900).' },
            poll_interval_seconds: { type: 'number', description: 'Polling interval in seconds (default: 2).' },
          },
        },
      },
      {
        name: 'roundtable.get_session',
        description: 'Fetch a Roundtable session (including per-persona analyses).',
        inputSchema: {
          type: 'object',
          properties: {
            api_url: { type: 'string', description: `Override API URL (default: ${DEFAULT_API_URL})` },
            session_id: { type: 'string', description: 'Session ID.' },
          },
          required: ['session_id'],
        },
      },
      {
        name: 'roundtable.export_session',
        description: 'Export a Roundtable session to pdf/docx/csv/md and write the file to disk.',
        inputSchema: {
          type: 'object',
          properties: {
            api_url: { type: 'string', description: `Override API URL (default: ${DEFAULT_API_URL})` },
            session_id: { type: 'string', description: 'Session ID.' },
            format: { type: 'string', enum: ['pdf', 'docx', 'csv', 'md'], description: 'Export format.' },
            output_dir: { type: 'string', description: 'Directory to write output file (default: cwd).' },
            output_path: { type: 'string', description: 'Explicit output path (overrides output_dir).' },
          },
          required: ['session_id', 'format'],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = (request.params.arguments || {}) as JsonObject;

  try {
    if (name === 'roundtable.list_personas') {
      const apiUrl = (typeof args.api_url === 'string' && args.api_url.trim()) ? args.api_url.trim() : DEFAULT_API_URL;
      const personas = await listPersonas(apiUrl);
      return { content: [{ type: 'text', text: JSON.stringify({ api_url: apiUrl, personas }, null, 2) }] };
    }

    if (name === 'roundtable.create_persona') {
      const apiUrl = (typeof args.api_url === 'string' && args.api_url.trim()) ? args.api_url.trim() : DEFAULT_API_URL;
      const profileJson = args.profile_json;
      const persona = await createPersona(apiUrl, profileJson);
      return { content: [{ type: 'text', text: JSON.stringify({ api_url: apiUrl, persona }, null, 2) }] };
    }

    if (name === 'roundtable.update_persona') {
      const apiUrl = (typeof args.api_url === 'string' && args.api_url.trim()) ? args.api_url.trim() : DEFAULT_API_URL;
      const personaId = typeof args.persona_id === 'string' ? args.persona_id.trim() : '';
      const profileJson = args.profile_json;
      const persona = await updatePersona(apiUrl, personaId, profileJson);
      return { content: [{ type: 'text', text: JSON.stringify({ api_url: apiUrl, persona }, null, 2) }] };
    }

    if (name === 'roundtable.deploy_persona') {
      const apiUrl = (typeof args.api_url === 'string' && args.api_url.trim()) ? args.api_url.trim() : DEFAULT_API_URL;
      const personaId = typeof args.persona_id === 'string' ? args.persona_id.trim() : '';
      const result = await deployPersona(apiUrl, personaId);
      return { content: [{ type: 'text', text: JSON.stringify({ api_url: apiUrl, result }, null, 2) }] };
    }

    if (name === 'roundtable.get_session') {
      const apiUrl = (typeof args.api_url === 'string' && args.api_url.trim()) ? args.api_url.trim() : DEFAULT_API_URL;
      const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
      if (!sessionId) throw new Error('session_id is required');
      const session = await getSession(apiUrl, sessionId);
      return { content: [{ type: 'text', text: JSON.stringify({ api_url: apiUrl, session }, null, 2) }] };
    }

    if (name === 'roundtable.focus_group') {
      const result = await focusGroup(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    if (name === 'roundtable.export_session') {
      const result = await exportSession(args);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: JSON.stringify({ error: msg }, null, 2) }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('roundtable-mcp fatal:', err);
  process.exit(1);
});
