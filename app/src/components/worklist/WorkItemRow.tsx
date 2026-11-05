import type { ReactNode } from 'react';
import { Check, Clock, X, ExternalLink, Mail, MessageSquare, LayoutGrid, PenLine, Sparkles, RotateCcw } from 'lucide-react';
import type { WorkItem, WorkItemSource, Urgency } from './types';
import { KIND_LABEL, URGENCY_LABEL } from './types';
import { formatDue, URGENCY_STYLE } from './format';

const SOURCE_ICON: Record<WorkItemSource, typeof Mail> = {
  email: Mail,
  teams: MessageSquare,
  monday: LayoutGrid,
  manual: PenLine,
  claude: Sparkles,
};

const SOURCE_LABEL: Record<WorkItemSource, string> = {
  email: 'Email',
  teams: 'Teams',
  monday: 'monday',
  manual: 'Manual',
  claude: 'Claude',
};

const KIND_STYLE: Record<WorkItem['kind'], string> = {
  respond: 'text-blue border-blue/30',
  do: 'text-navy border-navy/25',
  decide: 'text-orange-dark border-orange/40',
  question: 'text-violet-700 border-violet-300',
};

interface Props {
  item: WorkItem;
  today: string;
  onStatus: (id: string, status: WorkItem['status']) => void;
  onUrgency: (id: string, urgency: Urgency) => void;
  /** Questions: record the picked option (falls back to marking done). */
  onAnswer?: (id: string, option: string) => void;
}

export function WorkItemRow({ item, today, onStatus, onUrgency, onAnswer }: Props) {
  const SourceIcon = SOURCE_ICON[item.source];
  const due = item.due ? formatDue(item.due, today) : null;
  const isDone = item.status === 'done';

  return (
    <div className="group flex items-start gap-3 px-5 py-3 border-b border-border-soft last:border-b-0 hover:bg-surface/60 transition-colors">
      {/* Done checkbox */}
      <button
        onClick={() => onStatus(item.id, isDone ? 'open' : 'done')}
        className={[
          'mt-0.5 w-[18px] h-[18px] rounded-md border flex items-center justify-center flex-shrink-0 transition-colors',
          isDone ? 'bg-status-success-fg border-status-success-fg text-white' : 'border-gray-300 hover:border-navy',
        ].join(' ')}
        title={isDone ? 'Mark not done' : 'Mark done'}
        aria-label={isDone ? 'Mark not done' : 'Mark done'}
      >
        {isDone && <Check size={12} strokeWidth={3} />}
      </button>

      {/* Body */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[10px] font-bold uppercase tracking-[0.08em] border rounded px-1.5 py-px ${KIND_STYLE[item.kind]}`}>
            {KIND_LABEL[item.kind]}
          </span>
          <span
            className={`text-sm font-medium leading-snug ${isDone ? 'line-through text-fg-3' : 'text-fg'}`}
            title={item.summary}
          >
            {item.title}
          </span>
        </div>

        <div className="flex items-center gap-x-3 gap-y-1 flex-wrap mt-1 text-xs text-fg-2">
          <span className="flex items-center gap-1">
            <SourceIcon size={12} className="text-fg-3" aria-label={SOURCE_LABEL[item.source]} />
            {item.from}
          </span>
          {due && (
            <span
              className={due.overdue ? 'text-status-danger-fg font-medium' : ''}
              title={item.dueBasis === 'inferred' ? 'Inferred from the message – no date was stated' : 'Due date'}
            >
              Due {item.dueBasis === 'inferred' ? '~' : ''}{due.label}
            </span>
          )}
          {!due && <span className="text-fg-3">No date</span>}
          <span className="text-fg-3 italic truncate max-w-[340px]" title={item.urgencyReason}>
            {item.urgencyReason}
          </span>
          {item.carriedDays > 0 && (
            <span
              className={[
                'px-1.5 py-px rounded text-[10px] font-semibold',
                item.carriedDays >= 4 ? 'bg-status-danger-bg text-status-danger-fg' : 'bg-status-neutral-bg text-status-neutral-fg',
              ].join(' ')}
              title="Briefings this has been carried over"
            >
              day {item.carriedDays + 1}
            </span>
          )}
        </div>

        {/* Phase 2: Claude's question options */}
        {item.options && !isDone && (
          <div className="flex gap-2 mt-2.5 flex-wrap">
            {item.options.map((opt) => (
              <button
                key={opt}
                onClick={() => (onAnswer ? onAnswer(item.id, opt) : onStatus(item.id, 'done'))}
                className="text-xs font-medium px-2.5 py-1 rounded-lg border border-violet-200 text-violet-700 bg-violet-50 hover:bg-violet-100 transition-colors"
              >
                {opt}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Right side: urgency + actions */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <select
          value={item.urgency}
          onChange={(e) => onUrgency(item.id, Number(e.target.value) as Urgency)}
          className={`text-[11px] font-semibold rounded-full pl-2 pr-1 py-0.5 border-0 cursor-pointer appearance-none text-center ${URGENCY_STYLE[item.urgency]}`}
          title={item.userOverridden ? 'You changed this – Claude will learn from it' : 'Change urgency'}
          aria-label="Urgency"
        >
          {([1, 2, 3, 4] as Urgency[]).map((u) => (
            <option key={u} value={u}>{URGENCY_LABEL[u]}</option>
          ))}
        </select>
        {item.userOverridden && <span className="w-1.5 h-1.5 rounded-full bg-orange" title="Changed by you" />}

        <div className="flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
          {isDone ? (
            <IconButton title="Undo" onClick={() => onStatus(item.id, 'open')}><RotateCcw size={14} /></IconButton>
          ) : (
            <>
              <IconButton title="Snooze until tomorrow" onClick={() => onStatus(item.id, 'snoozed')}><Clock size={14} /></IconButton>
              <IconButton title="Dismiss" onClick={() => onStatus(item.id, 'dismissed')}><X size={14} /></IconButton>
            </>
          )}
          {item.link && (
            <a
              href={item.link}
              target="_blank"
              rel="noreferrer"
              className="p-1.5 rounded-md text-fg-3 hover:text-navy hover:bg-white"
              title={`Open in ${SOURCE_LABEL[item.source]}`}
              aria-label={`Open in ${SOURCE_LABEL[item.source]}`}
            >
              <ExternalLink size={14} />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function IconButton({ title, onClick, children }: { title: string; onClick: () => void; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="p-1.5 rounded-md text-fg-3 hover:text-navy hover:bg-white"
      title={title}
      aria-label={title}
    >
      {children}
    </button>
  );
}
