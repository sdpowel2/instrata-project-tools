import { useState } from 'react';
import { Bookmark, Clock, X, RotateCcw } from 'lucide-react';
import type { EmailFlagStatus, SessionType } from '../../types';

interface Props {
  messageId: string;
  currentStatus: EmailFlagStatus;
  onFlag: (id: string) => void;
  onDefer: (id: string, to: SessionType) => void;
  onDismiss: (id: string) => void;
  onUnflag: (id: string) => void;
}

const deferOptions: Array<{ key: SessionType; label: string }> = [
  { key: 'morning', label: 'Morning' },
  { key: 'midday', label: 'Midday' },
  { key: 'eod', label: 'End of Day' },
];

export function EmailActionBar({ messageId, currentStatus, onFlag, onDefer, onDismiss, onUnflag }: Props) {
  const [showDefer, setShowDefer] = useState(false);

  const btnClass = 'flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md transition-colors';

  return (
    <div className="border-t border-border px-4 py-2 flex items-center gap-2 relative">
      {currentStatus === 'dismissed' || currentStatus === 'flagged' || currentStatus === 'deferred' ? (
        <button
          onClick={() => onUnflag(messageId)}
          className={`${btnClass} text-gray-500 hover:bg-gray-100`}
        >
          <RotateCcw size={13} />
          Restore
        </button>
      ) : (
        <>
          <button
            onClick={() => onFlag(messageId)}
            className={`${btnClass} text-blue-600 hover:bg-blue-50`}
          >
            <Bookmark size={13} />
            Flag
          </button>

          <div className="relative">
            <button
              onClick={() => setShowDefer(!showDefer)}
              className={`${btnClass} text-amber-600 hover:bg-amber-50`}
            >
              <Clock size={13} />
              Defer
            </button>
            {showDefer && (
              <div className="absolute bottom-full left-0 mb-1 bg-white border border-border rounded-lg shadow-lg py-1 z-10 min-w-[140px]">
                {deferOptions.map((opt) => (
                  <button
                    key={opt.key}
                    onClick={() => { onDefer(messageId, opt.key); setShowDefer(false); }}
                    className="block w-full text-left px-3 py-1.5 text-xs text-primary hover:bg-gray-50"
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            onClick={() => onDismiss(messageId)}
            className={`${btnClass} text-gray-400 hover:bg-gray-50`}
          >
            <X size={13} />
            Dismiss
          </button>
        </>
      )}
    </div>
  );
}
