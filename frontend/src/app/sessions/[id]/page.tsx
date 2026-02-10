'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { format } from 'date-fns';
import { 
  FileText, 
  Clock, 
  CheckCircle, 
  AlertCircle, 
  XCircle, 
  RefreshCw,
  ChevronDown,
  ChevronUp,
  Share2,
  Download
} from 'lucide-react';
import { sessionApi, Session, Analysis } from '@/lib/api';

export default function SessionDetailPage() {
  const params = useParams();
  const sessionId = params.id as string;
  
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedAnalysis, setExpandedAnalysis] = useState<number | null>(null);
  const [retryingId, setRetryingId] = useState<number | null>(null);

  useEffect(() => {
    loadSession();
    // Poll for updates if still analyzing
    const interval = setInterval(() => {
      if (session?.status === 'analyzing') {
        loadSession();
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [sessionId, session?.status]);

  const loadSession = async () => {
    try {
      const data = await sessionApi.get(sessionId);
      setSession(data);
    } catch (err) {
      setError('Failed to load session');
    } finally {
      setLoading(false);
    }
  };

  const handleRetry = async (personaId: string, analysisId: number) => {
    setRetryingId(analysisId);
    try {
      await sessionApi.retryAnalysis(sessionId, personaId);
      await loadSession();
    } catch (err) {
      setError('Failed to retry analysis');
    } finally {
      setRetryingId(null);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="h-5 w-5 text-green-500" />;
      case 'failed':
        return <XCircle className="h-5 w-5 text-red-500" />;
      case 'running':
        return <Clock className="h-5 w-5 text-blue-500 animate-spin" />;
      default:
        return <Clock className="h-5 w-5 text-gray-400" />;
    }
  };

  const calculateOverallScore = (analysis: Analysis) => {
    if (!analysis.score_json) return 0;
    const scores = [
      analysis.score_json.relevance?.score || 0,
      analysis.score_json.technical_credibility?.score || 0,
      analysis.score_json.differentiation?.score || 0,
      analysis.score_json.actionability?.score || 0,
      analysis.score_json.trust_signals?.score || 0,
      analysis.score_json.language_fit?.score || 0,
    ];
    return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
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
            <button className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50">
              <Share2 className="h-4 w-4 mr-2" />
              Share
            </button>
            <button className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 bg-white hover:bg-gray-50">
              <Download className="h-4 w-4 mr-2" />
              Export
            </button>
          </div>
        </div>

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
              <Clock className="h-8 w-8 text-blue-500 animate-spin" />
            )}
            <div>
              <p className="font-medium text-gray-900">
                {session.status === 'completed' && 'All analyses complete'}
                {session.status === 'partial' && 'Some analyses failed'}
                {session.status === 'failed' && 'All analyses failed'}
                {session.status === 'analyzing' && 'Analysis in progress...'}
              </p>
              <p className="text-sm text-gray-600">
                {session.analyses?.filter(a => a.status === 'completed').length || 0} of {session.selected_persona_ids.length} complete
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Analyses */}
      <div className="space-y-4">
        {session.analyses?.map((analysis) => (
          <div 
            key={analysis.id} 
            className="bg-white border rounded-lg overflow-hidden"
          >
            {/* Analysis Header */}
            <div 
              className="p-6 flex items-start justify-between cursor-pointer hover:bg-gray-50"
              onClick={() => setExpandedAnalysis(expandedAnalysis === analysis.id ? null : analysis.id)}
            >
              <div className="flex items-start gap-4">
                {getStatusIcon(analysis.status)}
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">
                    {analysis.persona_name || 'Unknown Persona'}
                  </h3>
                  <p className="text-sm text-gray-600">
                    {analysis.status === 'completed' && `Overall Score: ${calculateOverallScore(analysis)}/10`}
                    {analysis.status === 'failed' && 'Analysis failed'}
                    {analysis.status === 'running' && 'Analyzing...'}
                    {analysis.status === 'pending' && 'Waiting to start...'}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {analysis.status === 'failed' && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleRetry(analysis.persona_id, analysis.id);
                    }}
                    disabled={retryingId === analysis.id}
                    className="mr-2 inline-flex items-center px-3 py-1 border border-transparent text-sm font-medium rounded text-blue-700 bg-blue-100 hover:bg-blue-200"
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

            {/* Analysis Details */}
            {expandedAnalysis === analysis.id && analysis.status === 'completed' && (
              <div className="border-t px-6 py-6 bg-gray-50">
                {analysis.score_json && (
                  <div className="mb-6">
                    <h4 className="text-sm font-medium text-gray-900 mb-3">Dimension Scores</h4>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                      {Object.entries(analysis.score_json).map(([key, value]) => (
                        <div key={key} className="bg-white p-3 rounded border">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-xs text-gray-600 capitalize">
                              {key.replace('_', ' ')}
                            </span>
                            <span className="text-lg font-bold text-blue-600">
                              {value.score}/10
                            </span>
                          </div>
                          <p className="text-xs text-gray-500">{value.commentary}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {analysis.top_issues_json && analysis.top_issues_json.length > 0 && (
                  <div className="mb-6">
                    <h4 className="text-sm font-medium text-gray-900 mb-3">Top Issues</h4>
                    <div className="space-y-3">
                      {analysis.top_issues_json.map((issue, idx) => (
                        <div key={idx} className="bg-white p-4 rounded border">
                          <p className="font-medium text-red-700 mb-2">{issue.issue}</p>
                          <div className="text-sm text-gray-600 mb-2">
                            <span className="font-medium">Original:</span> "{issue.specific_example_from_content}"
                          </div>
                          <div className="text-sm text-green-700">
                            <span className="font-medium">Suggested:</span> "{issue.suggested_rewrite}"
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {analysis.rewritten_suggestions_json && (
                  <div>
                    <h4 className="text-sm font-medium text-gray-900 mb-3">Additional Feedback</h4>
                    <div className="bg-white p-4 rounded border">
                      {analysis.rewritten_suggestions_json.what_works_well?.length > 0 && (
                        <div className="mb-3">
                          <p className="text-sm font-medium text-green-700 mb-1">What Works Well:</p>
                          <ul className="list-disc list-inside text-sm text-gray-600">
                            {analysis.rewritten_suggestions_json.what_works_well.map((item, idx) => (
                              <li key={idx}>{item}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      <div className="mb-3">
                        <p className="text-sm font-medium text-gray-900 mb-1">Overall Verdict:</p>
                        <p className="text-sm text-gray-600">{analysis.rewritten_suggestions_json.overall_verdict}</p>
                      </div>
                      {analysis.rewritten_suggestions_json.rewritten_headline && (
                        <div>
                          <p className="text-sm font-medium text-blue-700 mb-1">Rewritten Headline Suggestion:</p>
                          <p className="text-sm text-gray-600 italic">"{analysis.rewritten_suggestions_json.rewritten_headline}"</p>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {analysis.error_message && (
                  <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded text-red-700 text-sm">
                    Error: {analysis.error_message}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}