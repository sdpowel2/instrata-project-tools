import { useEffect } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { Mail, Loader2, RefreshCw, Sparkles, Unlink } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { usePersonalOps } from '../hooks/usePersonalOps';
import { ConnectEmailBanner } from '../components/personal-ops/ConnectEmailBanner';
import { SessionSelector } from '../components/personal-ops/SessionSelector';
import { EmailDigestCard } from '../components/personal-ops/EmailDigestCard';
import type { SessionType } from '../types';

const SESSION_LABELS: Record<SessionType, string> = {
  morning: 'Morning Briefing',
  midday: 'Midday Check-in',
  eod: 'End of Day Recap',
};

export function PersonalOpsPage() {
  const { isAdmin } = useAuth();
  const [searchParams] = useSearchParams();
  const {
    connectionStatus,
    emails,
    activeSession,
    setActiveSession,
    isLoadingEmails,
    isTriaging,
    error,
    initiateOAuth,
    disconnectEmail,
    fetchEmails,
    flagEmail,
    deferEmail,
    dismissEmail,
    unflagEmail,
    checkConnection,
  } = usePersonalOps();

  // Handle OAuth callback redirect
  useEffect(() => {
    if (searchParams.get('connected') === 'true') {
      checkConnection();
    }
  }, [searchParams, checkConnection]);

  // Auto-fetch emails when connected and session changes
  useEffect(() => {
    if (connectionStatus === 'connected') {
      fetchEmails(activeSession);
    }
  }, [connectionStatus, activeSession, fetchEmails]);

  // Gate: admin only
  if (!isAdmin) return <Navigate to="/" replace />;

  // Compute email counts by filtering active emails visible in each session
  const emailCounts: Record<SessionType, number> = {
    morning: 0,
    midday: 0,
    eod: 0,
  };
  // Current session emails count
  const activeEmails = emails.filter((e) => e.flagStatus !== 'dismissed');
  emailCounts[activeSession] = activeEmails.length;

  return (
    <div className="p-8 max-w-[1000px]">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-3">
            <Mail size={22} className="text-navy" />
            <h1 className="text-xl font-semibold text-primary">Personal Ops</h1>
          </div>
          <p className="text-sm text-secondary mt-1">
            Email triage & daily briefing — {SESSION_LABELS[activeSession]}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {isTriaging && (
            <span className="flex items-center gap-1.5 text-xs text-violet-600 bg-violet-50 px-3 py-1.5 rounded-full">
              <Sparkles size={13} className="animate-pulse" />
              Scoring urgency…
            </span>
          )}
          {connectionStatus === 'connected' && (
            <>
              <button
                onClick={() => fetchEmails(activeSession)}
                disabled={isLoadingEmails}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-secondary bg-white border border-border rounded-lg hover:bg-gray-50 transition-colors disabled:opacity-50"
              >
                <RefreshCw size={13} className={isLoadingEmails ? 'animate-spin' : ''} />
                Refresh
              </button>
              <button
                onClick={disconnectEmail}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-red-500 bg-white border border-border rounded-lg hover:bg-red-50 transition-colors"
                title="Disconnect email"
              >
                <Unlink size={13} />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Connection states */}
      {connectionStatus === 'checking' && (
        <div className="flex items-center justify-center py-20">
          <Loader2 size={24} className="animate-spin text-gray-400" />
        </div>
      )}

      {connectionStatus === 'disconnected' && (
        <ConnectEmailBanner
          onConnect={initiateOAuth}
          error={error}
        />
      )}

      {connectionStatus === 'error' && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-6 text-center">
          <p className="text-sm text-red-600 mb-2">Failed to check email connection.</p>
          <button
            onClick={checkConnection}
            className="text-xs text-red-500 underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* Connected: session selector + email list */}
      {connectionStatus === 'connected' && (
        <>
          <SessionSelector
            activeSession={activeSession}
            onSessionChange={setActiveSession}
            emailCounts={emailCounts}
          />

          {/* Error banner */}
          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 mb-4 text-sm text-red-600">
              {error}
            </div>
          )}

          {/* Loading */}
          {isLoadingEmails && emails.length === 0 && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Loader2 size={24} className="animate-spin text-gray-400" />
              <p className="text-sm text-secondary">Fetching emails…</p>
            </div>
          )}

          {/* Empty state */}
          {!isLoadingEmails && emails.length === 0 && (
            <div className="text-center py-16">
              <Mail size={32} className="mx-auto text-gray-300 mb-3" />
              <p className="text-sm text-secondary">No emails for this session window.</p>
              <p className="text-xs text-tertiary mt-1">Try a different session or refresh.</p>
            </div>
          )}

          {/* Email list */}
          {emails.length > 0 && (
            <div className="space-y-3">
              {/* Stats bar */}
              <div className="flex items-center gap-4 text-xs text-secondary mb-2">
                <span>{activeEmails.length} active</span>
                <span>{emails.filter((e) => e.flagStatus === 'flagged').length} flagged</span>
                <span>{emails.filter((e) => e.flagStatus === 'deferred').length} deferred</span>
                <span className="text-tertiary">
                  {emails.filter((e) => e.flagStatus === 'dismissed').length} dismissed
                </span>
              </div>

              {/* Active emails first, then flagged, then deferred, dismissed last */}
              {emails
                .filter((e) => e.flagStatus !== 'dismissed')
                .map((email) => (
                  <EmailDigestCard
                    key={email.id}
                    email={email}
                    onFlag={flagEmail}
                    onDefer={deferEmail}
                    onDismiss={dismissEmail}
                    onUnflag={unflagEmail}
                  />
                ))}

              {/* Dismissed (collapsed) */}
              {emails.filter((e) => e.flagStatus === 'dismissed').length > 0 && (
                <details className="mt-4">
                  <summary className="text-xs text-tertiary cursor-pointer hover:text-secondary">
                    {emails.filter((e) => e.flagStatus === 'dismissed').length} dismissed emails
                  </summary>
                  <div className="space-y-3 mt-3">
                    {emails
                      .filter((e) => e.flagStatus === 'dismissed')
                      .map((email) => (
                        <EmailDigestCard
                          key={email.id}
                          email={email}
                          onFlag={flagEmail}
                          onDefer={deferEmail}
                          onDismiss={dismissEmail}
                          onUnflag={unflagEmail}
                        />
                      ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
