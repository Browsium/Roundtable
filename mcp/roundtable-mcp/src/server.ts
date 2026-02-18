import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type MessageExtraInfo,
} from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import fs from 'node:fs/promises';
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

export type RoundtableMcpMode = 'stdio' | 'http';

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

function getAuthHeaders(options?: { userEmail?: string }): Record<string, string> {
  const headers: Record<string, string> = {};

  const clientId = getEnv('ROUNDTABLE_CF_ACCESS_CLIENT_ID');
  const clientSecret = getEnv('ROUNDTABLE_CF_ACCESS_CLIENT_SECRET');
  if (clientId && clientSecret) {
    headers['CF-Access-Client-Id'] = clientId;
    headers['CF-Access-Client-Secret'] = clientSecret;
  }

  // Optional: if you're using a service token (no user identity), you can pin
  // ownership to a specific email for Roundtable session isolation.
  const userEmail = (options?.userEmail || getEnv('ROUNDTABLE_USER_EMAIL')).trim();
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

async function apiFetch(apiUrl: string, p: string, init?: RequestInit, options?: { userEmail?: string }): Promise<Response> {
  const headers: Record<string, string> = {
    ...getAuthHeaders(options),
    ...(init?.headers ? (init.headers as any) : {}),
  };

  const url = joinUrl(apiUrl, p);
  return await fetch(url, {
    ...init,
    headers,
  });
}

async function fetchJson<T>(apiUrl: string, p: string, init?: RequestInit, options?: { userEmail?: string }): Promise<T> {
  const resp = await apiFetch(apiUrl, p, init, options);
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

function readHeader(extra: MessageExtraInfo | undefined, name: string): string | undefined {
  const headers = extra?.requestInfo?.headers || {};
  const v = headers[name.toLowerCase()] ?? headers[name] ?? undefined;
  if (Array.isArray(v)) return String(v[0] || '').trim() || undefined;
  if (typeof v === 'string') return v.trim() || undefined;
  return undefined;
}

function isProbablyBase64(s: string): boolean {
  // Best-effort; clients can still pass invalid base64 and we will throw.
  const trimmed = (s || '').trim();
  if (!trimmed) return false;
  if (trimmed.length < 16) return false;
  if (trimmed.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/=]+$/.test(trimmed);
}

async function readInputBytes(
  args: JsonObject,
  mode: RoundtableMcpMode,
): Promise<{ filename: string; bytes: Uint8Array; contentType: string }> {
  const filePath = typeof args.file_path === 'string' ? args.file_path.trim() : '';
  const fileBase64 = typeof args.file_base64 === 'string' ? args.file_base64.trim() : '';
  const content = typeof args.content === 'string' ? args.content : '';
  const filename = typeof args.filename === 'string' ? args.filename.trim() : '';

  if (filePath) {
    if (mode === 'http') {
      throw new Error('file_path is only supported in local (stdio) mode. For remote MCP, provide file_base64+filename or content+filename.');
    }
    const resolved = path.resolve(process.cwd(), filePath);
    const data = await fs.readFile(resolved);
    const actualName = path.basename(resolved);
    return {
      filename: actualName,
      bytes: new Uint8Array(data),
      contentType: contentTypeForFilename(actualName),
    };
  }

  if (fileBase64 && filename) {
    if (!isProbablyBase64(fileBase64)) {
      throw new Error('file_base64 does not look like valid base64 (expected standard base64, padded).');
    }
    const buf = Buffer.from(fileBase64, 'base64');
    return {
      filename,
      bytes: new Uint8Array(buf),
      contentType: contentTypeForFilename(filename),
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

  throw new Error('Provide either file_path OR (file_base64 + filename) OR (content + filename).');
}

async function listPersonas(apiUrl: string, options?: { userEmail?: string }): Promise<Persona[]> {
  return await fetchJson<Persona[]>(apiUrl, '/personas', undefined, options);
}

async function createPersona(apiUrl: string, profileJson: any, options?: { userEmail?: string }): Promise<any> {
  if (!profileJson || typeof profileJson !== 'object') {
    throw new Error('profile_json must be an object');
  }
  return await fetchJson<any>(apiUrl, '/personas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile_json: profileJson }),
  }, options);
}

async function updatePersona(apiUrl: string, personaId: string, profileJson: any, options?: { userEmail?: string }): Promise<any> {
  if (!personaId) throw new Error('persona_id is required');
  if (!profileJson || typeof profileJson !== 'object') {
    throw new Error('profile_json must be an object');
  }
  return await fetchJson<any>(apiUrl, `/personas/${encodeURIComponent(personaId)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ profile_json: profileJson }),
  }, options);
}

async function deployPersona(apiUrl: string, personaId: string, options?: { userEmail?: string }): Promise<any> {
  if (!personaId) throw new Error('persona_id is required');
  return await fetchJson<any>(apiUrl, `/personas/${encodeURIComponent(personaId)}/deploy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }, options);
}

async function listPersonaGroups(apiUrl: string, options?: { userEmail?: string }): Promise<any[]> {
  return await fetchJson<any[]>(apiUrl, '/persona-groups', undefined, options);
}

async function createPersonaGroup(apiUrl: string, data: { role_key: string; name: string; description?: string; base_persona_id?: string }, options?: { userEmail?: string }): Promise<any> {
  return await fetchJson<any>(apiUrl, '/persona-groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }, options);
}

async function getPersonaGroup(apiUrl: string, groupId: string, options?: { userEmail?: string }): Promise<any> {
  if (!groupId) throw new Error('persona_group_id is required');
  return await fetchJson<any>(apiUrl, `/persona-groups/${encodeURIComponent(groupId)}`, undefined, options);
}

async function generatePersonaGroupVariants(apiUrl: string, groupId: string, data: { count: number; base_persona_id?: string; seed_constraints?: any; generator_provider?: string; generator_model?: string }, options?: { userEmail?: string }): Promise<any> {
  if (!groupId) throw new Error('persona_group_id is required');
  return await fetchJson<any>(apiUrl, `/persona-groups/${encodeURIComponent(groupId)}/generate-variants`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }, options);
}

async function getSession(apiUrl: string, sessionId: string, options?: { userEmail?: string }): Promise<Session> {
  return await fetchJson<Session>(apiUrl, `/sessions/${encodeURIComponent(sessionId)}`, undefined, options);
}

async function pollSessionUntilDone(
  apiUrl: string,
  sessionId: string,
  timeoutSeconds: number,
  pollIntervalSeconds: number,
  options?: { userEmail?: string },
): Promise<Session> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let last: Session | null = null;

  while (Date.now() < deadline) {
    last = await getSession(apiUrl, sessionId, options);
    if (last.status === 'completed' || last.status === 'failed' || last.status === 'partial') {
      return last;
    }
    await new Promise((r) => setTimeout(r, Math.max(250, pollIntervalSeconds * 1000)));
  }

  throw new Error(`Timed out waiting for session ${sessionId} after ${timeoutSeconds}s. Last status: ${last?.status || 'unknown'}`);
}

async function focusGroup(
  args: JsonObject,
  mode: RoundtableMcpMode,
  options?: { userEmail?: string },
): Promise<JsonObject> {
  const apiUrl = (typeof args.api_url === 'string' && args.api_url.trim()) ? args.api_url.trim() : DEFAULT_API_URL;

  const { filename, bytes, contentType } = await readInputBytes(args, mode);
  const fileExtension = extFromFilename(filename);

  const workflowRaw = typeof args.workflow === 'string' ? args.workflow.trim().toLowerCase() : '';
  const workflow = workflowRaw || 'roundtable_standard';
  if (workflow !== 'roundtable_standard' && workflow !== 'roundtable_council') {
    throw new Error(`Invalid workflow '${workflowRaw}'. Allowed: roundtable_standard, roundtable_council`);
  }

  const panel = (typeof args.panel === 'string' ? args.panel.trim().toLowerCase() : '') || 'full';
  const requestedPersonaIds = asStringArray(args.persona_ids);

  const personas = await listPersonas(apiUrl, options);
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

  const evaluationPrompt = typeof args.evaluation_prompt === 'string' ? args.evaluation_prompt.trim() : '';

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
  if (evaluationPrompt) {
    createSessionBody.evaluation_prompt = evaluationPrompt;
  }

  if (workflow === 'roundtable_council') {
    const rawMembers = Array.isArray(args.council_members) ? args.council_members : [];
    const members: Array<{ provider: string; model: string }> = [];
    for (const m of rawMembers) {
      if (!m || typeof m !== 'object') continue;
      const provider = typeof (m as any).provider === 'string' ? String((m as any).provider).trim() : '';
      const model = typeof (m as any).model === 'string' ? String((m as any).model).trim() : '';
      if (!provider || !model) continue;
      members.push({ provider, model });
    }

    if (members.length === 0) {
      if (analysisProvider && analysisModel) {
        members.push({ provider: analysisProvider, model: analysisModel });
      } else {
        throw new Error('council_members is required when workflow=roundtable_council (or provide analysis_provider+analysis_model to use as a single council member).');
      }
    }

    const chairBackendArg = args.council_chair_backend;
    const reviewerBackendArg = args.council_reviewer_backend;
    const chairBackend = (chairBackendArg && typeof chairBackendArg === 'object')
      ? {
        provider: typeof (chairBackendArg as any).provider === 'string' ? String((chairBackendArg as any).provider).trim() : '',
        model: typeof (chairBackendArg as any).model === 'string' ? String((chairBackendArg as any).model).trim() : '',
      }
      : (analysisProvider && analysisModel ? { provider: analysisProvider, model: analysisModel } : null);

    const reviewerBackend = (reviewerBackendArg && typeof reviewerBackendArg === 'object')
      ? {
        provider: typeof (reviewerBackendArg as any).provider === 'string' ? String((reviewerBackendArg as any).provider).trim() : '',
        model: typeof (reviewerBackendArg as any).model === 'string' ? String((reviewerBackendArg as any).model).trim() : '',
      }
      : (chairBackend ? { ...chairBackend } : null);

    createSessionBody.workflow = 'roundtable_council';
    createSessionBody.analysis_config_json = {
      council: {
        members,
        ...(reviewerBackend && reviewerBackend.provider && reviewerBackend.model ? { reviewer_backend: reviewerBackend } : {}),
        ...(chairBackend && chairBackend.provider && chairBackend.model ? { chair_backend: chairBackend } : {}),
      },
    };
  } else if (workflow === 'roundtable_standard') {
    // Explicit workflow is optional, but useful for callers that want to be clear.
    createSessionBody.workflow = 'roundtable_standard';
  }

  const session = await fetchJson<any>(apiUrl, '/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createSessionBody),
  }, options);

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
  }, options);

  // Trigger analysis.
  await fetchJson<any>(apiUrl, `/sessions/${encodeURIComponent(sessionId)}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }, options);

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

  const finalSession = await pollSessionUntilDone(apiUrl, sessionId, timeoutSeconds, pollIntervalSeconds, options);
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

async function focusGroupDiscussion(
  args: JsonObject,
  mode: RoundtableMcpMode,
  options?: { userEmail?: string },
): Promise<JsonObject> {
  const apiUrl = (typeof args.api_url === 'string' && args.api_url.trim()) ? args.api_url.trim() : DEFAULT_API_URL;

  const { filename, bytes, contentType } = await readInputBytes(args, mode);
  const fileExtension = extFromFilename(filename);

  const variantCount = typeof args.variant_count === 'number' && Number.isFinite(args.variant_count)
    ? Math.max(2, Math.min(8, Math.floor(args.variant_count)))
    : 4;

  const basePersonaId = typeof args.base_persona_id === 'string' ? args.base_persona_id.trim() : '';
  const personaGroupIdArg = typeof args.persona_group_id === 'string' ? args.persona_group_id.trim() : '';

  const variantProvider = typeof args.variant_provider === 'string' ? args.variant_provider.trim() : '';
  const variantModel = typeof args.variant_model === 'string' ? args.variant_model.trim() : '';
  const chairProvider = typeof args.chair_provider === 'string' ? args.chair_provider.trim() : '';
  const chairModel = typeof args.chair_model === 'string' ? args.chair_model.trim() : '';

  // Defaults to configured analysis backend.
  const analysisProvider = variantProvider || (typeof args.analysis_provider === 'string' ? args.analysis_provider.trim() : '');
  const analysisModel = variantModel || (typeof args.analysis_model === 'string' ? args.analysis_model.trim() : '');
  const hasBackendOverride = !!analysisProvider || !!analysisModel;
  if (hasBackendOverride && (!analysisProvider || !analysisModel)) {
    throw new Error('analysis_provider and analysis_model must be provided together (both non-empty).');
  }

  // Use chair backend if specified; else use variant backend; else let server defaults apply.
  const chairBackend = (chairProvider && chairModel)
    ? { provider: chairProvider, model: chairModel }
    : (analysisProvider && analysisModel ? { provider: analysisProvider, model: analysisModel } : null);

  let groupId = personaGroupIdArg;
  let variantPersonaIds: string[] = [];

  if (groupId) {
    const group = await getPersonaGroup(apiUrl, groupId, options);
    const members = Array.isArray(group?.members) ? group.members : [];
    variantPersonaIds = members.map((p: any) => String(p?.id || '')).filter(Boolean);
  } else {
    if (!basePersonaId) throw new Error('Provide persona_group_id OR base_persona_id');
    const roleKey = basePersonaId.split('_')[0]?.trim().toLowerCase() || 'role';

    const created = await createPersonaGroup(apiUrl, {
      role_key: roleKey,
      name: `${roleKey} discussion variants`,
      base_persona_id: basePersonaId,
    }, options);

    groupId = String(created?.id || '').trim();
    if (!groupId) throw new Error('Failed to create persona group');

    const gen = await generatePersonaGroupVariants(apiUrl, groupId, {
      count: variantCount,
      base_persona_id: basePersonaId,
      generator_provider: analysisProvider || undefined,
      generator_model: analysisModel || undefined,
      seed_constraints: args.seed_constraints,
    }, options);

    variantPersonaIds = Array.isArray(gen?.created_persona_ids) ? gen.created_persona_ids : [];
  }

  if (variantPersonaIds.length < 2) {
    throw new Error(`Need at least 2 variants; got ${variantPersonaIds.length}`);
  }

  const createSessionBody: any = {
    file_name: filename,
    file_size_bytes: bytes.byteLength,
    file_extension: fileExtension,
    selected_persona_ids: variantPersonaIds,
    workflow: 'role_variant_discussion',
  };
  if (analysisProvider && analysisModel) {
    createSessionBody.analysis_provider = analysisProvider;
    createSessionBody.analysis_model = analysisModel;
  }

  createSessionBody.analysis_config_json = {
    discussion: {
      persona_group_id: groupId,
      variant_backend: (analysisProvider && analysisModel) ? { provider: analysisProvider, model: analysisModel } : null,
      chair_backend: chairBackend,
      critique_mode: 'all_against_all',
    },
  };

  const session = await fetchJson<any>(apiUrl, '/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(createSessionBody),
  }, options);

  const sessionId = String(session?.id || '').trim();
  if (!sessionId) throw new Error('Session creation failed: missing id in response');

  // Upload bytes
  const uploadPath = `/r2/upload/${encodeURIComponent(sessionId)}/${encodeURIComponent(filename)}`;
  await fetchJson<any>(apiUrl, uploadPath, {
    method: 'PUT',
    headers: { 'Content-Type': contentType },
    body: toArrayBuffer(bytes),
  }, options);

  // Trigger analysis
  await fetchJson<any>(apiUrl, `/sessions/${encodeURIComponent(sessionId)}/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  }, options);

  const wait = typeof args.wait === 'boolean' ? args.wait : true;
  if (!wait) {
    return { session_id: sessionId, api_url: apiUrl, status: 'started', persona_group_id: groupId, variant_persona_ids: variantPersonaIds };
  }

  const timeoutSeconds = typeof args.timeout_seconds === 'number' && Number.isFinite(args.timeout_seconds)
    ? Math.max(30, Math.floor(args.timeout_seconds))
    : 900;
  const pollIntervalSeconds = typeof args.poll_interval_seconds === 'number' && Number.isFinite(args.poll_interval_seconds)
    ? Math.max(1, Math.floor(args.poll_interval_seconds))
    : 2;

  const finalSession = await pollSessionUntilDone(apiUrl, sessionId, timeoutSeconds, pollIntervalSeconds, options);

  // Fetch chair artifacts
  const chairFinal = await fetchJson<any>(apiUrl, `/sessions/${encodeURIComponent(sessionId)}/artifacts?artifact_type=discussion_chair_final`, undefined, options);
  const dissents = await fetchJson<any>(apiUrl, `/sessions/${encodeURIComponent(sessionId)}/artifacts?artifact_type=discussion_dissents`, undefined, options);

  return {
    session_id: sessionId,
    api_url: apiUrl,
    status: finalSession.status,
    persona_group_id: groupId,
    variant_persona_ids: variantPersonaIds,
    chair_final_artifacts: chairFinal?.artifacts || [],
    dissent_artifacts: dissents?.artifacts || [],
    session: finalSession,
  };
}

function mimeTypeForExportFormat(format: ExportFormat): string {
  switch (format) {
    case 'md': return 'text/markdown; charset=utf-8';
    case 'csv': return 'text/csv; charset=utf-8';
    case 'pdf': return 'application/pdf';
    case 'docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    default: return 'application/octet-stream';
  }
}

async function exportSession(
  args: JsonObject,
  mode: RoundtableMcpMode,
  options?: { userEmail?: string },
): Promise<{
  output_path?: string;
  bytes_written?: number;
  resource?: { uri: string; mimeType: string; text?: string; blob?: string };
}> {
  const apiUrl = (typeof args.api_url === 'string' && args.api_url.trim()) ? args.api_url.trim() : DEFAULT_API_URL;
  const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
  if (!sessionId) throw new Error('session_id is required');

  const format = (typeof args.format === 'string' ? args.format.trim().toLowerCase() : '') as ExportFormat;
  if (!format || !['pdf', 'docx', 'csv', 'md'].includes(format)) {
    throw new Error('format must be one of: pdf, docx, csv, md');
  }

  const returnBlob = typeof args.return_blob === 'boolean'
    ? args.return_blob
    : mode === 'http';
  const writeToDisk = typeof args.write_to_disk === 'boolean'
    ? args.write_to_disk
    : mode === 'stdio';

  if (!returnBlob && !writeToDisk) {
    throw new Error('Nothing to do: set return_blob=true and/or write_to_disk=true.');
  }

  const personas = await listPersonas(apiUrl, options);
  const personasById = Object.fromEntries(personas.map((p) => [p.id, p]));
  const session = await getSession(apiUrl, sessionId, options);
  const model = buildExportModel(session, personasById);

  const result: { output_path?: string; bytes_written?: number; resource?: { uri: string; mimeType: string; text?: string; blob?: string } } = {};

  let exportText: string | null = null;
  let exportBytes: Uint8Array | null = null;
  if (format === 'md') exportText = exportToMarkdown(model);
  if (format === 'csv') exportText = exportToCsv(model);
  if (format === 'pdf') exportBytes = await exportToPdfBytes(model);
  if (format === 'docx') exportBytes = await exportToDocxBytes(model);

  if (writeToDisk) {
    const outputDir = typeof args.output_dir === 'string' && args.output_dir.trim()
      ? path.resolve(process.cwd(), args.output_dir.trim())
      : process.cwd();

    await fs.mkdir(outputDir, { recursive: true });

    const outputPath = typeof args.output_path === 'string' && args.output_path.trim()
      ? path.resolve(process.cwd(), args.output_path.trim())
      : path.join(outputDir, makeExportFilename(session.file_name, format));

    if (exportText !== null) {
      await fs.writeFile(outputPath, exportText, 'utf8');
      result.output_path = outputPath;
      result.bytes_written = Buffer.byteLength(exportText, 'utf8');
    } else if (exportBytes) {
      await fs.writeFile(outputPath, exportBytes);
      result.output_path = outputPath;
      result.bytes_written = exportBytes.byteLength;
    } else {
      throw new Error(`Failed to generate export for format: ${format}`);
    }
  }

  if (returnBlob) {
    const mimeType = mimeTypeForExportFormat(format);
    const filename = makeExportFilename(session.file_name, format);
    const uri = `roundtable://export/${encodeURIComponent(sessionId)}/${encodeURIComponent(filename)}`;

    if (exportText !== null) {
      result.resource = { uri, mimeType, text: exportText };
    } else if (exportBytes) {
      result.resource = { uri, mimeType, blob: Buffer.from(exportBytes).toString('base64') };
    } else {
      throw new Error(`Failed to generate export for format: ${format}`);
    }
  }

  return result;
}

export function createRoundtableMcpServer(options: { version: string; mode: RoundtableMcpMode; userEmail?: string }): Server {
  const server = new Server(
    { name: 'roundtable-mcp', version: options.version },
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
          description: 'Submit a document to Roundtable and optionally wait for analysis to complete. Supports standard and council workflows.',
          inputSchema: {
            type: 'object',
            properties: {
              api_url: { type: 'string', description: `Override API URL (default: ${DEFAULT_API_URL})` },
              file_path: { type: 'string', description: 'Path to a local file to analyze (local stdio only).' },
              file_base64: { type: 'string', description: 'Base64-encoded file bytes to analyze (remote-friendly).' },
              content: { type: 'string', description: 'Raw content to analyze (if file_path not provided).' },
              filename: { type: 'string', description: 'Filename to use when content or file_base64 is provided (e.g. draft.md).' },
              persona_ids: { type: 'array', items: { type: 'string' }, description: 'Persona IDs to include (overrides panel).' },
              panel: { type: 'string', enum: ['fast', 'full'], description: 'Preset persona selection used when persona_ids is omitted.' },
              analysis_provider: { type: 'string', description: 'Override provider for this session (requires analysis_model).' },
              analysis_model: { type: 'string', description: 'Override model for this session (requires analysis_provider).' },
              workflow: { type: 'string', enum: ['roundtable_standard', 'roundtable_council'], description: 'Workflow path (default: roundtable_standard).' },
              council_members: {
                type: 'array',
                description: 'Council member backends (required when workflow=roundtable_council unless analysis_provider+analysis_model are provided).',
                items: {
                  type: 'object',
                  properties: {
                    provider: { type: 'string' },
                    model: { type: 'string' },
                  },
                  required: ['provider', 'model'],
                },
              },
              council_chair_backend: {
                type: 'object',
                description: 'Optional chairman backend override. Defaults to analysis_provider+analysis_model if provided, else server defaults.',
                properties: {
                  provider: { type: 'string' },
                  model: { type: 'string' },
                },
                required: ['provider', 'model'],
              },
              council_reviewer_backend: {
                type: 'object',
                description: 'Optional reviewer backend override. Defaults to chairman.',
                properties: {
                  provider: { type: 'string' },
                  model: { type: 'string' },
                },
                required: ['provider', 'model'],
              },
              evaluation_prompt: { type: 'string', description: 'Optional evaluation prompt that scopes how personas evaluate the document. Example: "Does this messaging resonate with your role and priorities? Evaluate whether the positioning, claims, and language would influence your purchasing decision." When provided, personas evaluate through this lens rather than open-ended document review.' },
              wait: { type: 'boolean', description: 'If true, wait for completion and return results (default: true).' },
              timeout_seconds: { type: 'number', description: 'Max seconds to wait when wait=true (default: 900).' },
              poll_interval_seconds: { type: 'number', description: 'Polling interval in seconds (default: 2).' },
            },
          },
        },
        {
          name: 'roundtable.focus_group_discussion',
          description: 'Run a single-role variant discussion (cross-critique + chairman synthesis). Variants can be generated and saved as personas in a persona-group.',
          inputSchema: {
            type: 'object',
            properties: {
              api_url: { type: 'string', description: `Override API URL (default: ${DEFAULT_API_URL})` },
              file_path: { type: 'string', description: 'Path to a local file to analyze (local stdio only).' },
              file_base64: { type: 'string', description: 'Base64-encoded file bytes to analyze (remote-friendly).' },
              content: { type: 'string', description: 'Raw content to analyze (if file_path not provided).' },
              filename: { type: 'string', description: 'Filename to use when content or file_base64 is provided (e.g. draft.md).' },
              persona_group_id: { type: 'string', description: 'Existing persona group id to use (optional).' },
              base_persona_id: { type: 'string', description: 'Base persona id to generate variants from (required if persona_group_id not provided).' },
              variant_count: { type: 'number', description: 'Number of variants to generate (default: 4, max: 8).' },
              seed_constraints: { type: 'object', description: 'Optional constraints passed to the variant generator.' },
              analysis_provider: { type: 'string', description: 'Variant backend provider (requires analysis_model).' },
              analysis_model: { type: 'string', description: 'Variant backend model (requires analysis_provider).' },
              chair_provider: { type: 'string', description: 'Chairman backend provider (requires chair_model).' },
              chair_model: { type: 'string', description: 'Chairman backend model (requires chair_provider).' },
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
          description: 'Export a Roundtable session to pdf/docx/csv/md. In http mode, returns the export as an MCP resource by default.',
          inputSchema: {
            type: 'object',
            properties: {
              api_url: { type: 'string', description: `Override API URL (default: ${DEFAULT_API_URL})` },
              session_id: { type: 'string', description: 'Session ID.' },
              format: { type: 'string', enum: ['pdf', 'docx', 'csv', 'md'], description: 'Export format.' },
              return_blob: { type: 'boolean', description: 'If true, return the file as an MCP resource (recommended for remote MCP). Default: true in http mode, false in stdio mode.' },
              write_to_disk: { type: 'boolean', description: 'If true, write the file to disk on the MCP host. Default: true in stdio mode, false in http mode.' },
              output_dir: { type: 'string', description: 'Directory to write output file (default: cwd).' },
              output_path: { type: 'string', description: 'Explicit output path (overrides output_dir).' },
            },
            required: ['session_id', 'format'],
          },
        },
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;
    const args = (request.params.arguments || {}) as JsonObject;

    const apiUrl = (typeof args.api_url === 'string' && args.api_url.trim()) ? args.api_url.trim() : DEFAULT_API_URL;

    try {
      if (name === 'roundtable.list_personas') {
        const personas = await listPersonas(apiUrl, { userEmail: options.userEmail });
        return { content: [{ type: 'text', text: JSON.stringify({ api_url: apiUrl, personas }, null, 2) }] };
      }

      if (name === 'roundtable.create_persona') {
        const profileJson = args.profile_json;
        const persona = await createPersona(apiUrl, profileJson, { userEmail: options.userEmail });
        return { content: [{ type: 'text', text: JSON.stringify({ api_url: apiUrl, persona }, null, 2) }] };
      }

      if (name === 'roundtable.update_persona') {
        const personaId = typeof args.persona_id === 'string' ? args.persona_id.trim() : '';
        const profileJson = args.profile_json;
        const persona = await updatePersona(apiUrl, personaId, profileJson, { userEmail: options.userEmail });
        return { content: [{ type: 'text', text: JSON.stringify({ api_url: apiUrl, persona }, null, 2) }] };
      }

      if (name === 'roundtable.deploy_persona') {
        const personaId = typeof args.persona_id === 'string' ? args.persona_id.trim() : '';
        const result = await deployPersona(apiUrl, personaId, { userEmail: options.userEmail });
        return { content: [{ type: 'text', text: JSON.stringify({ api_url: apiUrl, result }, null, 2) }] };
      }

      if (name === 'roundtable.get_session') {
        const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
        if (!sessionId) throw new Error('session_id is required');
        const session = await getSession(apiUrl, sessionId, { userEmail: options.userEmail });
        return { content: [{ type: 'text', text: JSON.stringify({ api_url: apiUrl, session }, null, 2) }] };
      }

      if (name === 'roundtable.focus_group') {
        const result = await focusGroup(args, options.mode, { userEmail: options.userEmail });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (name === 'roundtable.focus_group_discussion') {
        const result = await focusGroupDiscussion(args, options.mode, { userEmail: options.userEmail });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      if (name === 'roundtable.export_session') {
        const result = await exportSession(args, options.mode, { userEmail: options.userEmail });
        const content: any[] = [{ type: 'text', text: JSON.stringify(result, null, 2) }];
        if (result.resource?.text !== undefined) {
          content.unshift({
            type: 'resource',
            resource: {
              uri: result.resource.uri,
              mimeType: result.resource.mimeType,
              text: result.resource.text,
            },
          });
        } else if (result.resource?.blob !== undefined) {
          content.unshift({
            type: 'resource',
            resource: {
              uri: result.resource.uri,
              mimeType: result.resource.mimeType,
              blob: result.resource.blob,
            },
          });
        }
        return { content };
      }

      throw new Error(`Unknown tool: ${name}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const userHint = options.mode === 'http'
        ? ' (Tip: remote MCP cannot read your local file system. Prefer file_base64+filename or content+filename.)'
        : '';
      const hint = options.mode === 'http' && /file_path/i.test(msg) ? userHint : '';
      const reqId = readHeader(extra, 'x-request-id');
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `${msg}${hint}`, request_id: reqId }, null, 2) }],
        isError: true,
      };
    }
  });

  return server;
}
