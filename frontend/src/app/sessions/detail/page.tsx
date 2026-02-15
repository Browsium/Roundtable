'use client';

import { Suspense } from 'react';
import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { format } from 'date-fns';
import {
  Clock,
  CheckCircle,
  AlertCircle,
  XCircle,
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Share2,
  Download,
  User,
  Trash2
} from 'lucide-react';
import { sessionApi, personaApi, AnalysisWebSocket } from '@/lib/api';
import type { Session, Analysis, Persona } from '@/lib/types';
import HourglassSpinner from '@/components/HourglassSpinner';
import ScannerBar from '@/components/ScannerBar';
import {
  buildExportModel,
  downloadBlob,
  exportToCsv,
  exportToDocxBlob,
  exportToMarkdown,
  exportToPdfBlob,
  makeExportFilename,
  type ExportFormat,
} from '@/lib/export';

function SessionDetailContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const sessionId = searchParams.get('id') || '';

  const [session, setSession] = useState<Session | null>(null);
  const [personas, setPersonas] = useState<Record<string, Persona>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [expandedAnalysis, setExpandedAnalysis] = useState<number | null>(null);
  const [retryingId, setRetryingId] = useState<number | null>(null);
  const [wsConnected, setWsConnected] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [shareInput, setShareInput] = useState('');
  const [sharing, setSharing] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('pdf');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [discussionFinal, setDiscussionFinal] = useState<any | null>(null);
  const [discussionDissents, setDiscussionDissents] = useState<any[] | null>(null);
  const [discussionLoading, setDiscussionLoading] = useState(false);

  // Load personas to get names
  const loadPersonas = useCallback(async () => {
    try {
      const data = await personaApi.getAll();
      const personaMap: Record<string, Persona> = {};
      data.forEach(p => {
        personaMap[p.id] = p;
      });
      setPersonas(personaMap);
    } catch (err) {
      console.error('Failed to load personas:', err);
    }
  }, []);

  // Load session data
  const loadSession = useCallback(async () => {
    try {
      const data = await sessionApi.get(sessionId);
      setSession(data);
    } catch (_err) {
      setError('Failed to load session');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  // Start WebSocket connection for analysis
  const startAnalysis = useCallback(() => {
    if (!sessionId || wsConnected) return;

    setWsConnected(true);
    const ws = new AnalysisWebSocket(
      sessionId,
      (data) => {
        console.log('WebSocket message:', data);
        // Avoid hammering the API for high-frequency chunk events.
        if (data?.type !== 'chunk') {
          loadSession();
        }
      },
      (err) => {
        console.error('WebSocket error:', err);
      }
    );

    ws.connect();

    return () => {
      ws.close();
    };
  }, [sessionId, wsConnected, loadSession]);

  useEffect(() => {
    loadPersonas();
    loadSession();
  }, [loadPersonas, loadSession]);

  useEffect(() => {
    (async () => {
      if (!sessionId || !session) return;
      if (session.workflow !== 'role_variant_discussion') return;

        try {
          setDiscussionLoading(true);
          const [finalResp, dissentResp] = await Promise.all([
            sessionApi.getArtifacts(sessionId, { persona_id: 'discussion', artifact_type: 'discussion_chair_final' }),
            sessionApi.getArtifacts(sessionId, { persona_id: 'discussion', artifact_type: 'discussion_dissents' }),
          ]);

        const parseContent = (a: any) => {
          const raw = a?.content_json;
          if (raw == null) return null;
          if (typeof raw === 'object') return raw;
          if (typeof raw === 'string') {
            try { return JSON.parse(raw); } catch { return raw; }
          }
          return raw;
        };

          const pickLatest = (artifacts: any[] | undefined) => {
            if (!Array.isArray(artifacts) || artifacts.length === 0) return null;
            // API currently returns artifacts ordered by increasing id; pick the newest.
            return artifacts[artifacts.length - 1];
          };

          const finalArtifact = pickLatest(finalResp?.artifacts);
          const dissentArtifact = pickLatest(dissentResp?.artifacts);

        const finalPayload = finalArtifact ? parseContent(finalArtifact) : null;
        const dissentsPayload = dissentArtifact ? parseContent(dissentArtifact) : null;

        const finalObj = finalPayload?.final || finalPayload?.result || finalPayload || null;
        const dissentsArr = Array.isArray(dissentsPayload?.dissents)
          ? dissentsPayload.dissents
          : (Array.isArray(dissentsPayload) ? dissentsPayload : null);

        setDiscussionFinal(finalObj && typeof finalObj === 'object' ? finalObj : null);
        setDiscussionDissents(dissentsArr);
      } catch (e) {
        console.error('Failed to load discussion artifacts:', e);
      } finally {
        setDiscussionLoading(false);
      }
    })();
  }, [sessionId, session]);

  // Trigger analysis when session is uploaded
  useEffect(() => {
    if (session && session.status === 'uploaded' && !wsConnected && session.is_owner) {
      // First try to trigger analysis via API
      sessionApi.startAnalysis(sessionId).then(() => {
        console.log('Analysis triggered via API');
        // Then connect WebSocket for real-time updates
        const cleanup = startAnalysis();
        return cleanup;
      }).catch((err) => {
        console.error('Failed to trigger analysis:', err);
        // Still try WebSocket even if API fails
        const cleanup = startAnalysis();
        return cleanup;
      });
    }
  }, [session, wsConnected, startAnalysis, sessionId]);

  useEffect(() => {
    // Poll for updates if analyzing
    if (session?.status === 'analyzing') {
      const interval = setInterval(() => {
        loadSession();
      }, 3000);
      return () => clearInterval(interval);
    }
  }, [session?.status, loadSession]);

  const handleRetry = async (_personaId: string, _analysisId: number) => {
    try {
      setError(null);
      setRetryingId(_analysisId);
      await sessionApi.retryPersona(sessionId, _personaId);
      setSession((s) => (s ? { ...s, status: 'analyzing' } : s));
      setNotice('Retry started');
      setTimeout(() => setNotice(null), 3000);
      await loadSession();
    } catch (e: any) {
      setError(e?.message || 'Failed to retry analysis');
    } finally {
      setRetryingId(null);
    }
  };

  const handleDelete = async () => {
    if (!confirm('Are you sure you want to delete this session? This action cannot be undone.')) {
      return;
    }

    try {
      setIsDeleting(true);
      await sessionApi.delete(sessionId);
      router.push('/sessions');
    } catch (err) {
      setError('Failed to delete session');
      setIsDeleting(false);
    }
  };

  const showNotice = (message: string) => {
    setNotice(message);
    setTimeout(() => setNotice(null), 3000);
  };

  const handleShare = async () => {
    if (!session?.is_owner) return;
    setShareError(null);
    setShareInput('');
    setShareOpen(true);
  };

  const parseEmails = (raw: string) => {
    const parts = raw
      .split(/[,\s;]+/)
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
    const unique = Array.from(new Set(parts));

    // Basic email sanity check (not RFC-perfect).
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return unique.filter(e => emailRe.test(e));
  };

  const handleShareSave = async () => {
    try {
      if (!session?.is_owner) return;
      setShareError(null);
      setSharing(true);

      const emails = parseEmails(shareInput);
      if (emails.length === 0) {
        setShareError('Enter one or more valid email addresses (comma or space separated).');
        return;
      }

      const resp = await sessionApi.share(sessionId, emails);
      showNotice(resp.message || 'Session shared');
      await loadSession();
      setShareOpen(false);
    } catch (e: any) {
      setShareError(e?.message || 'Failed to share session');
    } finally {
      setSharing(false);
    }
  };

  const handleExport = () => {
    setExportError(null);
    setExportOpen(true);
  };

  const handleExportDownload = async () => {
    try {
      if (!session) return;
      setExportError(null);
      setExporting(true);

      const model = buildExportModel(session, personas);
      const filename = makeExportFilename(session.file_name, exportFormat);

      if (exportFormat === 'md') {
        const md = exportToMarkdown(model);
        downloadBlob(new Blob([md], { type: 'text/markdown; charset=utf-8' }), filename);
      } else if (exportFormat === 'csv') {
        const csv = exportToCsv(model);
        downloadBlob(new Blob([csv], { type: 'text/csv; charset=utf-8' }), filename);
      } else if (exportFormat === 'pdf') {
        const pdfBlob = await exportToPdfBlob(model);
        downloadBlob(pdfBlob, filename);
      } else if (exportFormat === 'docx') {
        const docxBlob = await exportToDocxBlob(model);
        downloadBlob(docxBlob, filename);
      } else {
        setExportError('Unsupported export format');
        return;
      }

      showNotice('Export downloaded');
      setExportOpen(false);
    } catch (e: any) {
      setExportError(e?.message || 'Failed to export session');
    } finally {
      setExporting(false);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="h-5 w-5 text-green-500" />;
      case 'failed':
        return <XCircle className="h-5 w-5 text-red-500" />;
      case 'running':
        return null;
      default:
        return <Clock className="h-5 w-5 text-gray-400" />;
    }
  };

  const calculateOverallScore = (analysis: Analysis) => {
    if (!analysis.score_json) return 0;
    try {
      const scoreData = typeof analysis.score_json === 'string'
        ? JSON.parse(analysis.score_json)
        : analysis.score_json;
      const scores = [
        scoreData.relevance?.score || 0,
        scoreData.technical_credibility?.score || 0,
        scoreData.differentiation?.score || 0,
        scoreData.actionability?.score || 0,
        scoreData.trust_signals?.score || 0,
        scoreData.language_fit?.score || 0,
      ];
      return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
    } catch {
      return 0;
    }
  };

  const getPersonaName = (personaId: string) => {
    const persona = personas[personaId];
    return persona?.name || 'Unknown Persona';
  };

  const getPersonaRole = (personaId: string) => {
    const persona = personas[personaId];
    return persona?.role || '';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
        {error || 'Session not found'}
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="mb-8">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-3xl font-bold text-gray-900 mb-2">{session.file_name}</h2>
            <p className="text-gray-600">
              {format(new Date(session.created_at), 'MMM d, yyyy h:mm a')}
            </p>
            {session.is_shared && (
              <p className="text-sm text-gray-500 mt-1">Shared with you</p>
            )}
          </div>
<div className="flex gap-2">
          {session.is_owner && (
            <button
              onClick={handleShare}
              className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
            >
              <Share2 className="h-4 w-4 mr-2" />
              Share
            </button>
          )}
          <button
            onClick={handleExport}
            className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
          >
            <Download className="h-4 w-4 mr-2" />
            Export
          </button>
          {session.is_owner && (
            <button
              onClick={handleDelete}
              disabled={isDeleting}
              className="inline-flex items-center px-4 py-2 border border-red-300 rounded-md text-sm font-medium text-red-700 bg-white hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isDeleting ? (
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-red-700 mr-2" />
              ) : (
                <Trash2 className="h-4 w-4 mr-2" />
              )}
              Delete
            </button>
          )}
        </div>
        </div>

        {/* Notice */}
        {notice && (
          <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-800 text-sm">
            {notice}
          </div>
        )}

        {/* Share Modal */}
        {shareOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
            onClick={() => setShareOpen(false)}
          >
            <div
              className="w-full max-w-lg rounded-lg bg-white border shadow-lg p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">Share Session</h3>
                  <p className="text-sm text-gray-600 mt-1">
                    Add Access-authenticated users by email.
                  </p>
                </div>
                <button
                  onClick={() => setShareOpen(false)}
                  className="text-gray-400 hover:text-gray-600"
                  aria-label="Close"
                  title="Close"
                >
                  <span className="text-xl leading-none">×</span>
                </button>
              </div>

              <div className="mt-4 space-y-3">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Emails
                  </label>
                  <textarea
                    value={shareInput}
                    onChange={(e) => setShareInput(e.target.value)}
                    placeholder="alice@company.com, bob@company.com"
                    rows={3}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono text-sm"
                  />
                  <p className="text-xs text-gray-500 mt-2">
                    Separate multiple emails with commas or spaces.
                  </p>
                </div>

                {Array.isArray(session.share_with_emails) && session.share_with_emails.length > 0 && (
                  <div>
                    <p className="text-xs font-medium text-gray-700">Currently shared with</p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {session.share_with_emails.map((email) => (
                        <span
                          key={email}
                          className="px-2 py-1 rounded-full bg-gray-100 text-gray-700 text-xs font-mono"
                        >
                          {email}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {shareError && (
                  <div className="flex items-center gap-2 text-red-600 text-sm">
                    <AlertCircle className="h-4 w-4" />
                    {shareError}
                  </div>
                )}
              </div>

              <div className="mt-6 flex justify-end gap-3">
                <button
                  onClick={() => setShareOpen(false)}
                  className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 font-medium"
                >
                  Cancel
                </button>
                <button
                  onClick={handleShareSave}
                  disabled={sharing}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 font-medium disabled:opacity-50"
                >
                  {sharing ? 'Sharing...' : 'Share'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Export Modal */}
        {exportOpen && (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
            onClick={() => {
              if (!exporting) setExportOpen(false);
            }}
          >
            <div
              className="w-full max-w-lg rounded-lg bg-white border shadow-lg p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">Export Results</h3>
                  <p className="text-sm text-gray-600 mt-1">
                    Includes an executive summary (common themes and recommendations) and full persona-by-persona details.
                  </p>
                </div>
                <button
                  onClick={() => setExportOpen(false)}
                  disabled={exporting}
                  className="text-gray-400 hover:text-gray-600 disabled:opacity-50"
                  aria-label="Close"
                  title="Close"
                >
                  <span className="text-xl leading-none">×</span>
                </button>
              </div>

              <div className="mt-5 space-y-3">
                <div>
                  <p className="text-sm font-medium text-gray-700 mb-2">Format</p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setExportFormat('pdf')}
                      className={`p-3 border rounded-md text-left ${
                        exportFormat === 'pdf'
                          ? 'border-blue-600 bg-blue-50'
                          : 'border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      <div className="font-medium text-gray-900">PDF</div>
                      <div className="text-xs text-gray-600 mt-0.5">Printable report</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setExportFormat('docx')}
                      className={`p-3 border rounded-md text-left ${
                        exportFormat === 'docx'
                          ? 'border-blue-600 bg-blue-50'
                          : 'border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      <div className="font-medium text-gray-900">DOCX</div>
                      <div className="text-xs text-gray-600 mt-0.5">Editable document</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setExportFormat('csv')}
                      className={`p-3 border rounded-md text-left ${
                        exportFormat === 'csv'
                          ? 'border-blue-600 bg-blue-50'
                          : 'border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      <div className="font-medium text-gray-900">CSV</div>
                      <div className="text-xs text-gray-600 mt-0.5">Spreadsheet-friendly</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setExportFormat('md')}
                      className={`p-3 border rounded-md text-left ${
                        exportFormat === 'md'
                          ? 'border-blue-600 bg-blue-50'
                          : 'border-gray-200 hover:bg-gray-50'
                      }`}
                    >
                      <div className="font-medium text-gray-900">Markdown</div>
                      <div className="text-xs text-gray-600 mt-0.5">Portable text</div>
                    </button>
                  </div>
                </div>

                {exportError && (
                  <div className="flex items-center gap-2 text-red-600 text-sm">
                    <AlertCircle className="h-4 w-4" />
                    {exportError}
                  </div>
                )}
              </div>

              <div className="mt-6 flex justify-end gap-3">
                <button
                  onClick={() => setExportOpen(false)}
                  disabled={exporting}
                  className="px-4 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 font-medium disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  onClick={handleExportDownload}
                  disabled={exporting}
                  className="px-4 py-2 bg-gray-900 text-white rounded-md hover:bg-gray-800 font-medium disabled:opacity-50"
                >
                  {exporting ? 'Exporting...' : 'Download'}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Status */}
        <div className="mt-6 p-4 bg-gray-50 rounded-lg">
          <div className="flex items-center gap-4">
            {session.status === 'completed' && (
              <CheckCircle className="h-8 w-8 text-green-500" />
            )}
            {session.status === 'partial' && (
              <AlertCircle className="h-8 w-8 text-yellow-500" />
            )}
            {session.status === 'failed' && (
              <XCircle className="h-8 w-8 text-red-500" />
            )}
            {session.status === 'analyzing' && (
              <HourglassSpinner className="h-8 w-8 text-blue-500" />
            )}
            {session.status === 'uploaded' && (
              <AlertCircle className="h-8 w-8 text-yellow-500" />
            )}
            <div>
              <p className="font-medium text-gray-900">
                {session.status === 'completed' && 'All analyses complete'}
                {session.status === 'partial' && 'Partial results available'}
                {session.status === 'failed' && 'Analysis failed'}
                {session.status === 'analyzing' && 'Analysis in progress...'}
                {session.status === 'uploaded' && 'Starting analysis...'}
              </p>
              <p className="text-sm text-gray-600">
                {session.analyses?.filter(a => a.status === 'completed').length || 0} of {(() => {
                  try {
                    const ids = typeof session.selected_persona_ids === 'string'
                      ? JSON.parse(session.selected_persona_ids)
                      : session.selected_persona_ids;
                    return ids.length;
                  } catch {
                    return 0;
                  }
                })()} complete
              </p>
              {(session.analysis_provider || session.analysis_model) && (
                <p className="text-sm text-gray-600 mt-1">
                  Backend:{' '}
                  <span className="font-mono">
                    {(session.analysis_provider || 'unknown').trim() || 'unknown'} / {(session.analysis_model || 'unknown').trim() || 'unknown'}
                  </span>
                </p>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 flex items-center gap-2">
          <AlertCircle className="h-5 w-5" />
          {error}
        </div>
      )}

      {/* Analyses */}
      {session.workflow === 'role_variant_discussion' && (
        <div className="mb-6 bg-white border rounded-lg overflow-hidden">
          <div className="p-6 border-b bg-gray-50">
            <h3 className="text-lg font-semibold text-gray-900">Chairman Synthesis</h3>
            <p className="text-sm text-gray-600 mt-1">
              The final output below is synthesized from the role-variant discussion. Variant analyses are shown afterward.
            </p>
          </div>

          <div className="p-6">
            {discussionLoading && (
              <div className="text-sm text-gray-500">Loading discussion synthesis...</div>
            )}

            {!discussionLoading && !discussionFinal && session.status === 'analyzing' && (
              <div className="text-sm text-gray-500">Waiting for chairman synthesis...</div>
            )}

            {!discussionLoading && !discussionFinal && session.status !== 'analyzing' && (
              <div className="text-sm text-gray-500">No chairman synthesis found for this session.</div>
            )}

            {discussionFinal && (
              <div className="space-y-6">
                {discussionFinal.dimension_scores && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-900 mb-3">Dimension Scores</h4>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                      {Object.entries(discussionFinal.dimension_scores).map(([key, value]: [string, any]) => (
                        <div key={key} className="bg-white p-3 rounded border">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs text-gray-600 capitalize">
                              {key.replace('_', ' ')}
                            </span>
                            <span className="text-lg font-bold text-blue-600">
                              {value?.score || 0}/10
                            </span>
                          </div>
                          <p className="text-xs text-gray-500">{value?.commentary || ''}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {Array.isArray(discussionFinal.top_3_issues) && discussionFinal.top_3_issues.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-900 mb-3">Top Issues</h4>
                    <div className="space-y-3">
                      {discussionFinal.top_3_issues.map((issue: any, idx: number) => (
                        <div key={idx} className="bg-white p-4 rounded border">
                          <p className="font-medium text-red-700 mb-2">{issue?.issue || ''}</p>
                          <div className="text-sm text-gray-600 mb-2">
                            <span className="font-medium">Original:</span> &ldquo;{issue?.specific_example_from_content || ''}&rdquo;
                          </div>
                          <div className="text-sm text-green-700">
                            <span className="font-medium">Suggested:</span> &ldquo;{issue?.suggested_rewrite || ''}&rdquo;
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="bg-white p-4 rounded border">
                  {Array.isArray(discussionFinal.what_works_well) && discussionFinal.what_works_well.length > 0 && (
                    <div className="mb-3">
                      <p className="text-sm font-medium text-green-700 mb-1">What Works Well:</p>
                      <ul className="list-disc list-inside text-sm text-gray-600">
                        {discussionFinal.what_works_well.map((item: string, idx: number) => (
                          <li key={idx}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  <div className="mb-3">
                    <p className="text-sm font-medium text-gray-900 mb-1">Overall Verdict:</p>
                    <p className="text-sm text-gray-600">{discussionFinal.overall_verdict || ''}</p>
                  </div>
                  {discussionFinal.rewritten_headline_suggestion && (
                    <div>
                      <p className="text-sm font-medium text-blue-700 mb-1">Rewritten Headline Suggestion:</p>
                      <p className="text-sm text-gray-600 italic">&ldquo;{discussionFinal.rewritten_headline_suggestion}&rdquo;</p>
                    </div>
                  )}
                </div>

                {Array.isArray(discussionDissents) && discussionDissents.length > 0 && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-900 mb-3">Dissent Notes</h4>
                    <div className="space-y-2">
                      {discussionDissents.map((d: any, idx: number) => (
                        <div key={idx} className="p-3 rounded border bg-gray-50 text-sm text-gray-700">
                          <div className="font-medium">{d?.point || 'Dissent'}</div>
                          {Array.isArray(d?.who) && d.who.length > 0 && (
                            <div className="text-xs text-gray-500 mt-1 font-mono">
                              {d.who.join(', ')}
                            </div>
                          )}
                          {d?.why_not_in_final && (
                            <div className="text-xs text-gray-600 mt-1">
                              {d.why_not_in_final}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="space-y-4">
        {session.analyses?.map((analysis) => (
          <div
            key={analysis.id}
            className="bg-white border rounded-lg overflow-hidden"
          >
            {/* Analysis Header */}
            <div
              className="p-6 cursor-pointer hover:bg-gray-50"
              onClick={() => setExpandedAnalysis(expandedAnalysis === analysis.id ? null : analysis.id)}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-start gap-4">
                  <div className="h-10 w-10 rounded-full bg-blue-100 flex items-center justify-center flex-shrink-0">
                    <User className="h-5 w-5 text-blue-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <h3 className="text-lg font-semibold text-gray-900">
                      {getPersonaName(analysis.persona_id)}
                    </h3>
                    <p className="text-sm text-gray-600">{getPersonaRole(analysis.persona_id)}</p>

                    {analysis.status === 'running' ? (
                      <div className="mt-3">
                        <ScannerBar className="text-red-600" title="Analyzing" />
                      </div>
                    ) : (
                      <p className="text-sm text-gray-500 mt-1">
                        {analysis.status === 'completed' && `Overall Score: ${calculateOverallScore(analysis)}/10`}
                        {analysis.status === 'failed' && 'Analysis failed'}
                        {analysis.status === 'pending' && 'Waiting to start...'}
                      </p>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {getStatusIcon(analysis.status)}
                  {analysis.status === 'failed' && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleRetry(analysis.persona_id, analysis.id);
                      }}
                      disabled={retryingId === analysis.id}
                      className="ml-2 inline-flex items-center px-3 py-1 border border-transparent text-sm font-medium rounded text-blue-700 bg-blue-100 hover:bg-blue-200"
                    >
                      {retryingId === analysis.id ? (
                        <RefreshCw className="h-4 w-4 animate-spin mr-1" />
                      ) : (
                        <RefreshCw className="h-4 w-4 mr-1" />
                      )}
                      Retry
                    </button>
                  )}
                  {expandedAnalysis === analysis.id ? (
                    <ChevronUp className="h-5 w-5 text-gray-400" />
                  ) : (
                    <ChevronDown className="h-5 w-5 text-gray-400" />
                  )}
                </div>
              </div>
            </div>

             {/* Analysis Details */}
            {expandedAnalysis === analysis.id && (
              <>
                {analysis.status === 'completed' && (
                  <div className="border-t px-6 py-6 bg-gray-50">
                    {analysis.score_json && (() => {
                      try {
                        const scores = typeof analysis.score_json === 'string'
                          ? JSON.parse(analysis.score_json)
                          : analysis.score_json;
                        return (
                          <div className="mb-6">
                            <h4 className="text-sm font-medium text-gray-900 mb-3">Dimension Scores</h4>
                            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                              {Object.entries(scores).map(([key, value]: [string, any]) => (
                                <div key={key} className="bg-white p-3 rounded border">
                                  <div className="flex items-center justify-between mb-1">
                                    <span className="text-xs text-gray-600 capitalize">
                                      {key.replace('_', ' ')}
                                    </span>
                                    <span className="text-lg font-bold text-blue-600">
                                      {value?.score || 0}/10
                                    </span>
                                  </div>
                                  <p className="text-xs text-gray-500">{value?.commentary || ''}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      } catch { return null; }
                    })()}

                    {analysis.top_issues_json && (() => {
                      try {
                        const issues = typeof analysis.top_issues_json === 'string'
                          ? JSON.parse(analysis.top_issues_json)
                          : analysis.top_issues_json;
                        if (!Array.isArray(issues) || issues.length === 0) return null;
                        return (
                          <div className="mb-6">
                            <h4 className="text-sm font-medium text-gray-900 mb-3">Top Issues</h4>
                            <div className="space-y-3">
                              {issues.map((issue: any, idx: number) => (
                                <div key={idx} className="bg-white p-4 rounded border">
                                  <p className="font-medium text-red-700 mb-2">{issue?.issue || ''}</p>
                                  <div className="text-sm text-gray-600 mb-2">
                                    <span className="font-medium">Original:</span> &ldquo;{issue?.specific_example_from_content || ''}&rdquo;
                                  </div>
                                  <div className="text-sm text-green-700">
                                    <span className="font-medium">Suggested:</span> &ldquo;{issue?.suggested_rewrite || ''}&rdquo;
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        );
                      } catch { return null; }
                    })()}

                    {analysis.rewritten_suggestions_json && (() => {
                      try {
                        const suggestions = typeof analysis.rewritten_suggestions_json === 'string'
                          ? JSON.parse(analysis.rewritten_suggestions_json)
                          : analysis.rewritten_suggestions_json;
                        return (
                          <div>
                            <h4 className="text-sm font-medium text-gray-900 mb-3">Additional Feedback</h4>
                            <div className="bg-white p-4 rounded border">
                              {suggestions?.what_works_well?.length > 0 && (
                                <div className="mb-3">
                                  <p className="text-sm font-medium text-green-700 mb-1">What Works Well:</p>
                                  <ul className="list-disc list-inside text-sm text-gray-600">
                                    {suggestions.what_works_well.map((item: string, idx: number) => (
                                      <li key={idx}>{item}</li>
                                    ))}
                                  </ul>
                                </div>
                              )}
                              <div className="mb-3">
                                <p className="text-sm font-medium text-gray-900 mb-1">Overall Verdict:</p>
                                <p className="text-sm text-gray-600">{suggestions?.overall_verdict || ''}</p>
                              </div>
                              {suggestions?.rewritten_headline && (
                                <div>
                                  <p className="text-sm font-medium text-blue-700 mb-1">Rewritten Headline Suggestion:</p>
                                  <p className="text-sm text-gray-600 italic">&ldquo;{suggestions.rewritten_headline}&rdquo;</p>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      } catch { return null; }
                    })()}

                    {analysis.error_message && (
                      <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
                        Error: {analysis.error_message}
                      </div>
                    )}
                  </div>
                )}
                {analysis.status === 'failed' && (
                  <div className="border-t px-6 py-6 bg-red-50">
                    <div className="text-sm text-red-800">
                      <span className="font-medium">Error:</span>{' '}
                      {analysis.error_message || 'Analysis failed'}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function SessionDetailPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    }>
      <SessionDetailContent />
    </Suspense>
  );
}
