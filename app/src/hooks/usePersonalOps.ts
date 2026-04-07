import { useState, useEffect, useCallback } from 'react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import type { GraphEmail, ScoredEmail, EmailFlagStatus, SessionType, EmailFlag } from '../types';

type ConnectionStatus = 'checking' | 'disconnected' | 'connected' | 'error';

function getCurrentSession(): SessionType {
  const hour = new Date().getHours();
  if (hour < 12) return 'morning';
  if (hour < 16) return 'midday';
  return 'eod';
}

function todayStr(): string {
  return new Date().toISOString().split('T')[0];
}

// Map DB row (snake_case) to EmailFlag type (camelCase)
function rowToFlag(row: Record<string, unknown>): EmailFlag {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    messageId: row.message_id as string,
    status: row.status as EmailFlagStatus,
    urgencyScore: row.urgency_score as number | null,
    urgencyReason: row.urgency_reason as string | null,
    sessionType: row.session_type as SessionType | null,
    deferredTo: row.deferred_to as SessionType | null,
    firstSeenAt: row.first_seen_at as string,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

export function usePersonalOps() {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('checking');
  const [emails, setEmails] = useState<ScoredEmail[]>([]);
  const [activeSession, setActiveSession] = useState<SessionType>(getCurrentSession);
  const [isLoadingEmails, setIsLoadingEmails] = useState(false);
  const [isTriaging, setIsTriaging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check if email is connected on mount
  useEffect(() => {
    if (!isSupabaseConfigured()) {
      setConnectionStatus('disconnected');
      return;
    }
    checkConnection();
  }, []);

  const checkConnection = useCallback(async () => {
    setConnectionStatus('checking');
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setConnectionStatus('disconnected'); return; }

      const { data } = await supabase
        .from('ms_graph_tokens')
        .select('id, expires_at')
        .eq('user_id', user.id)
        .maybeSingle();

      setConnectionStatus(data ? 'connected' : 'disconnected');
    } catch {
      setConnectionStatus('error');
    }
  }, []);

  const initiateOAuth = useCallback(async () => {
    setError(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke('ms-graph-auth', {
        body: { action: 'authorize' },
      });

      if (fnError) throw fnError;
      if (data?.authorizeUrl) {
        window.location.href = data.authorizeUrl;
      } else {
        throw new Error('No authorize URL returned');
      }
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const disconnectEmail = useCallback(async () => {
    try {
      await supabase.functions.invoke('ms-graph-auth?action=disconnect', {
        method: 'GET',
      });
      setConnectionStatus('disconnected');
      setEmails([]);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const fetchEmails = useCallback(async (session: SessionType, date?: string) => {
    setIsLoadingEmails(true);
    setError(null);
    try {
      const { data, error: fnError } = await supabase.functions.invoke('ms-graph-emails', {
        body: { session, date: date || todayStr() },
      });

      if (fnError) throw fnError;

      const rawEmails: GraphEmail[] = data?.emails || [];

      if (rawEmails.length === 0) {
        setEmails([]);
        setIsLoadingEmails(false);
        return;
      }

      // Fetch existing flags for these emails
      const messageIds = rawEmails.map((e) => e.id);
      const { data: flagRows } = await supabase
        .from('personal_ops_email_flags')
        .select('*')
        .in('message_id', messageIds);

      const flagMap = new Map<string, EmailFlag>();
      (flagRows || []).forEach((row: Record<string, unknown>) => {
        const flag = rowToFlag(row);
        flagMap.set(flag.messageId, flag);
      });

      // Merge into ScoredEmail (scores will be populated by triage)
      const merged: ScoredEmail[] = rawEmails.map((email) => {
        const flag = flagMap.get(email.id);
        return {
          ...email,
          urgencyScore: flag?.urgencyScore ?? 50,
          urgencyReason: flag?.urgencyReason ?? '',
          draftReply: null,
          flagStatus: flag?.status ?? 'active',
          deferredTo: flag?.deferredTo ?? undefined,
          firstSeenAt: flag?.firstSeenAt,
        };
      });

      // Sort by urgency (highest first), then by received time
      merged.sort((a, b) => b.urgencyScore - a.urgencyScore);
      setEmails(merged);

      // Auto-triage if we have emails without scores
      const needsTriage = merged.some((e) => !flagMap.has(e.id));
      if (needsTriage) {
        triageEmails(rawEmails, session);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoadingEmails(false);
    }
  }, []);

  const triageEmails = useCallback(async (rawEmails: GraphEmail[], session: SessionType) => {
    setIsTriaging(true);
    try {
      // Prepare simplified email data for Claude
      const emailsForTriage = rawEmails.map((e) => ({
        id: e.id,
        subject: e.subject,
        from: `${e.from.emailAddress.name} <${e.from.emailAddress.address}>`,
        bodyPreview: e.bodyPreview,
        receivedDateTime: e.receivedDateTime,
        importance: e.importance,
        isRead: e.isRead,
      }));

      const { data, error: fnError } = await supabase.functions.invoke('email-triage', {
        body: { emails: emailsForTriage },
      });

      if (fnError) throw fnError;

      const scored: Array<{ id: string; urgencyScore: number; urgencyReason: string; draftReply: string | null }> = data?.scored || [];
      const scoreMap = new Map(scored.map((s) => [s.id, s]));

      // Upsert flags with scores
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      for (const s of scored) {
        await supabase.from('personal_ops_email_flags').upsert({
          user_id: user.id,
          message_id: s.id,
          urgency_score: s.urgencyScore,
          urgency_reason: s.urgencyReason,
          session_type: session,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,message_id', ignoreDuplicates: false });
      }

      // Update local state
      setEmails((prev) =>
        prev
          .map((email) => {
            const score = scoreMap.get(email.id);
            if (!score) return email;
            return {
              ...email,
              urgencyScore: score.urgencyScore,
              urgencyReason: score.urgencyReason,
              draftReply: score.draftReply ?? null,
            };
          })
          .sort((a, b) => b.urgencyScore - a.urgencyScore),
      );
    } catch (err) {
      console.warn('[usePersonalOps] Triage error:', err);
    } finally {
      setIsTriaging(false);
    }
  }, []);

  const updateEmailFlag = useCallback(async (messageId: string, status: EmailFlagStatus, deferredTo?: SessionType) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    await supabase.from('personal_ops_email_flags').upsert({
      user_id: user.id,
      message_id: messageId,
      status,
      deferred_to: deferredTo || null,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,message_id', ignoreDuplicates: false });

    setEmails((prev) =>
      prev.map((e) =>
        e.id === messageId ? { ...e, flagStatus: status, deferredTo } : e,
      ),
    );
  }, []);

  const flagEmail = useCallback((messageId: string) => updateEmailFlag(messageId, 'flagged'), [updateEmailFlag]);
  const deferEmail = useCallback((messageId: string, toSession: SessionType) => updateEmailFlag(messageId, 'deferred', toSession), [updateEmailFlag]);
  const dismissEmail = useCallback((messageId: string) => updateEmailFlag(messageId, 'dismissed'), [updateEmailFlag]);
  const unflagEmail = useCallback((messageId: string) => updateEmailFlag(messageId, 'active'), [updateEmailFlag]);

  return {
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
  };
}
