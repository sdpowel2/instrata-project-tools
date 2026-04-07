import { useState } from 'react';
import { Paperclip, Eye, EyeOff, MessageSquareText, Copy, Check, ChevronDown, ChevronUp } from 'lucide-react';
import type { ScoredEmail, SessionType } from '../../types';
import { EmailActionBar } from './EmailActionBar';

interface Props {
  email: ScoredEmail;
  onFlag: (id: string) => void;
  onDefer: (id: string, to: SessionType) => void;
  onDismiss: (id: string) => void;
  onUnflag: (id: string) => void;
}

function urgencyColor(score: number): string {
  if (score >= 75) return 'bg-red-100 text-red-700 border-red-200';
  if (score >= 50) return 'bg-orange-100 text-orange-700 border-orange-200';
  if (score >= 25) return 'bg-yellow-100 text-yellow-700 border-yellow-200';
  return 'bg-green-100 text-green-700 border-green-200';
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function EmailDigestCard({ email, onFlag, onDefer, onDismiss, onUnflag }: Props) {
  const isDismissed = email.flagStatus === 'dismissed';
  const [replyExpanded, setReplyExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!email.draftReply) return;
    await navigator.clipboard.writeText(email.draftReply);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={`bg-white rounded-xl border border-border shadow-sm transition-all ${
      isDismissed ? 'opacity-40' : ''
    } ${email.flagStatus === 'flagged' ? 'ring-2 ring-blue-200' : ''}`}>
      <div className="p-4">
        {/* Top row: urgency badge + sender + time */}
        <div className="flex items-start gap-3 mb-2">
          <span className={`inline-flex items-center justify-center text-xs font-bold px-2 py-1 rounded-md border min-w-[36px] ${urgencyColor(email.urgencyScore)}`}>
            {email.urgencyScore}
          </span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-primary truncate">
                {email.from.emailAddress.name || email.from.emailAddress.address}
              </span>
              {email.importance === 'high' && (
                <span className="text-[10px] font-bold uppercase px-1.5 py-0.5 rounded bg-red-50 text-red-600">
                  Important
                </span>
              )}
              {email.hasAttachments && (
                <Paperclip size={13} className="text-gray-400 shrink-0" />
              )}
              {email.isRead ? (
                <Eye size={13} className="text-gray-300 shrink-0" />
              ) : (
                <EyeOff size={13} className="text-blue-400 shrink-0" />
              )}
            </div>
            <div className="text-xs text-secondary truncate">
              {email.from.emailAddress.address}
            </div>
          </div>
          <span className="text-xs text-tertiary whitespace-nowrap">
            {timeAgo(email.receivedDateTime)}
          </span>
        </div>

        {/* Subject */}
        <h4 className="text-sm font-medium text-primary mb-1 line-clamp-1">
          {email.subject || '(no subject)'}
        </h4>

        {/* Body preview */}
        <p className="text-xs text-secondary line-clamp-2 mb-2">
          {email.bodyPreview || '(no preview available)'}
        </p>

        {/* Urgency reason from Claude */}
        {email.urgencyReason && (
          <div className="text-xs text-tertiary italic mb-3 flex items-start gap-1.5">
            <span className="shrink-0 mt-0.5 w-3 h-3 rounded-full bg-violet-100 flex items-center justify-center text-[8px] text-violet-600 font-bold">AI</span>
            {email.urgencyReason}
          </div>
        )}

        {/* Draft reply */}
        {email.draftReply && (
          <div className="mb-3">
            <button
              onClick={() => setReplyExpanded(!replyExpanded)}
              className="flex items-center gap-1.5 text-xs font-medium text-violet-600 hover:text-violet-700 transition-colors"
            >
              <MessageSquareText size={13} />
              Suggested Reply
              {replyExpanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>
            {replyExpanded && (
              <div className="mt-2 bg-violet-50 border border-violet-100 rounded-lg p-3 relative">
                <p className="text-xs text-primary leading-relaxed whitespace-pre-wrap pr-8">
                  {email.draftReply}
                </p>
                <button
                  onClick={handleCopy}
                  className="absolute top-2 right-2 p-1.5 rounded-md hover:bg-violet-100 transition-colors"
                  title="Copy to clipboard"
                >
                  {copied ? (
                    <Check size={13} className="text-green-600" />
                  ) : (
                    <Copy size={13} className="text-violet-400" />
                  )}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Deferred indicator */}
        {email.flagStatus === 'deferred' && email.deferredTo && (
          <div className="text-xs text-amber-600 bg-amber-50 rounded-md px-2 py-1 mb-3 inline-block">
            Deferred to {email.deferredTo} session
          </div>
        )}
      </div>

      {/* Actions */}
      <EmailActionBar
        messageId={email.id}
        currentStatus={email.flagStatus}
        onFlag={onFlag}
        onDefer={onDefer}
        onDismiss={onDismiss}
        onUnflag={onUnflag}
      />
    </div>
  );
}
