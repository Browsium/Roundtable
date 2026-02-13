'use client';

import { useEffect, useState } from 'react';
import { format } from 'date-fns';
import { FileText, Clock, CheckCircle, AlertCircle, XCircle, ArrowRight, Trash2 } from 'lucide-react';
import { sessionApi } from '@/lib/api';
import type { Session } from '@/lib/types';
import Link from 'next/link';

export default function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    loadSessions();
  }, []);

  const loadSessions = async () => {
    try {
      setLoading(true);
      const data = await sessionApi.getAll();
      setSessions(data);
    } catch (err) {
      setError('Failed to load sessions');
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent, sessionId: string) => {
    e.preventDefault();
    e.stopPropagation();
    
    if (!confirm('Are you sure you want to delete this session? This action cannot be undone.')) {
      return;
    }

    try {
      setDeletingId(sessionId);
      await sessionApi.delete(sessionId);
      setSessions(sessions.filter(s => s.id !== sessionId));
    } catch (err) {
      setError('Failed to delete session');
      console.error(err);
    } finally {
      setDeletingId(null);
    }
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="h-5 w-5 text-green-500" />;
      case 'partial':
        return <AlertCircle className="h-5 w-5 text-yellow-500" />;
      case 'failed':
        return <XCircle className="h-5 w-5 text-red-500" />;
      case 'analyzing':
        return <Clock className="h-5 w-5 text-blue-500 animate-spin" />;
      default:
        return <Clock className="h-5 w-5 text-gray-400" />;
    }
  };

  const getStatusText = (status: string) => {
    switch (status) {
      case 'completed':
        return 'Completed';
      case 'partial':
        return 'Partial';
      case 'failed':
        return 'Failed';
      case 'analyzing':
        return 'Analyzing...';
      default:
        return 'Uploaded';
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
        {error}
      </div>
    );
  }

  return (
    <div>
      <div className="mb-8">
        <h2 className="text-3xl font-bold text-gray-900 mb-2">Session History</h2>
        <p className="text-gray-600">
          View and manage your past roundtable analyses.
        </p>
      </div>

      {sessions.length === 0 ? (
        <div className="text-center py-16">
          <FileText className="mx-auto h-12 w-12 text-gray-400 mb-4" />
          <h3 className="text-lg font-medium text-gray-900 mb-2">No sessions yet</h3>
          <p className="text-gray-500 mb-4">
            Upload your first marketing document to get started.
          </p>
          <Link
            href="/"
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-blue-600 hover:bg-blue-700"
          >
            Upload Document
            <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </div>
      ) : (
        <div className="space-y-4">
          {sessions.map((session) => (
            <div
              key={session.id}
              className="block bg-white border rounded-lg p-6 hover:shadow-md transition-shadow group"
            >
              <div className="flex items-start justify-between">
                <Link
                  href={`/sessions/detail?id=${session.id}`}
                  className="flex items-start gap-4 flex-1"
                >
                  <FileText className="h-8 w-8 text-gray-400 flex-shrink-0" />
                  <div>
                    <h3 className="text-lg font-medium text-gray-900">
                      {session.file_name}
                    </h3>
                    <p className="text-sm text-gray-500 mt-1">
                      {format(new Date(session.created_at), 'MMM d, yyyy h:mm a')}
                    </p>
                    <div className="flex items-center gap-2 mt-2">
                      {getStatusIcon(session.status)}
                        <span className={`text-sm font-medium
                          ${session.status === 'completed' ? 'text-green-600' : ''}
                          ${session.status === 'partial' ? 'text-yellow-600' : ''}
                          ${session.status === 'failed' ? 'text-red-600' : ''}
                          ${session.status === 'analyzing' ? 'text-blue-600' : ''}
                        `}>
                          {getStatusText(session.status)}
                        </span>
                      <span className="text-gray-300">|</span>
                      <span className="text-sm text-gray-500">
                        {(() => {
                          try {
                            const ids = typeof session.selected_persona_ids === 'string'
                              ? JSON.parse(session.selected_persona_ids)
                              : session.selected_persona_ids;
                            return `${ids.length} personas`;
                          } catch {
                            return '0 personas';
                          }
                        })()}
                      </span>
                    </div>
                  </div>
                </Link>
                <div className="flex items-center gap-2">
                  <Link
                    href={`/sessions/detail?id=${session.id}`}
                    className="p-2 text-gray-400 hover:text-blue-600 transition-colors"
                  >
                    <ArrowRight className="h-5 w-5" />
                  </Link>
                  <button
                    onClick={(e) => handleDelete(e, session.id)}
                    disabled={deletingId === session.id}
                    className="p-2 text-gray-400 hover:text-red-600 transition-colors opacity-0 group-hover:opacity-100"
                    title="Delete session"
                  >
                    {deletingId === session.id ? (
                      <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-red-600" />
                    ) : (
                      <Trash2 className="h-5 w-5" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
