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

  // Trigger analysis when session is uploaded
  useEffect(() => {
    if (session && session.status === 'uploaded' && !wsConnected) {
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
    // Retry not implemented yet - would reconnect WebSocket and restart analysis
    setError('Retry functionality coming soon');
    setTimeout(() => setError(null), 3000);
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
    try {
      const url = window.location.href;
      const title = `Roundtable Analysis: ${session?.file_name || 'Session'}`;

      if (navigator.share) {
        await navigator.share({ title, url });
        return;
      }

      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        showNotice('Share link copied to clipboard');
        return;
      }

      window.prompt('Copy this link:', url);
    } catch (e: any) {
      const msg = String(e?.message || e);
      // Ignore user-cancelled share sheets.
      if (msg.toLowerCase().includes('abort')) return;
      setError('Failed to share session link');
    }
  };

  const handleExport = async () => {
    try {
      if (!session) return;

      const enrichedAnalyses = (session.analyses || []).map(a => ({
        ...a,
        persona_name: getPersonaName(a.persona_id),
        persona_role: getPersonaRole(a.persona_id),
      }));

      const exportPayload = {
        exported_at: new Date().toISOString(),
        session: {
          ...session,
          analyses: enrichedAnalyses,
        },
      };

      const safeBase = (session.file_name || 'roundtable')
        .replace(/[^a-z0-9._-]+/gi, '_')
        .replace(/^_+|_+$/g, '');
      const filename = `${safeBase || 'roundtable'}.roundtable.json`;

      const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);

      showNotice('Export downloaded');
    } catch (e: any) {
      setError(e?.message || 'Failed to export session');
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
          </div>
<div className="flex gap-2">
          <button
            onClick={handleShare}
            className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
          >
            <Share2 className="h-4 w-4 mr-2" />
            Share
          </button>
          <button
            onClick={handleExport}
            className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50"
          >
            <Download className="h-4 w-4 mr-2" />
            Export
          </button>
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
        </div>
        </div>

        {/* Notice */}
        {notice && (
          <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg text-green-800 text-sm">
            {notice}
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
