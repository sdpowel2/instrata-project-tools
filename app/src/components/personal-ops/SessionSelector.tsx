import { Sun, Clock, Sunset } from 'lucide-react';
import type { SessionType } from '../../types';

interface Props {
  activeSession: SessionType;
  onSessionChange: (session: SessionType) => void;
  emailCounts: Record<SessionType, number>;
}

const sessions: Array<{
  key: SessionType;
  label: string;
  time: string;
  icon: typeof Sun;
  activeColor: string;
  badgeColor: string;
}> = [
  {
    key: 'morning',
    label: 'Morning',
    time: '~8:00 AM',
    icon: Sun,
    activeColor: 'border-blue-500 bg-blue-50 text-blue-700',
    badgeColor: 'bg-blue-100 text-blue-700',
  },
  {
    key: 'midday',
    label: 'Midday',
    time: '~12:00 PM',
    icon: Clock,
    activeColor: 'border-emerald-500 bg-emerald-50 text-emerald-700',
    badgeColor: 'bg-emerald-100 text-emerald-700',
  },
  {
    key: 'eod',
    label: 'End of Day',
    time: '~4:30 PM',
    icon: Sunset,
    activeColor: 'border-amber-500 bg-amber-50 text-amber-700',
    badgeColor: 'bg-amber-100 text-amber-700',
  },
];

export function SessionSelector({ activeSession, onSessionChange, emailCounts }: Props) {
  return (
    <div className="grid grid-cols-3 gap-3 mb-6">
      {sessions.map((s) => {
        const isActive = activeSession === s.key;
        const Icon = s.icon;
        return (
          <button
            key={s.key}
            onClick={() => onSessionChange(s.key)}
            className={`flex items-center gap-3 px-4 py-3 rounded-xl border-2 transition-all text-left ${
              isActive
                ? s.activeColor
                : 'border-border bg-white text-secondary hover:border-gray-300'
            }`}
          >
            <Icon size={20} />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold">{s.label}</div>
              <div className="text-xs opacity-70">{s.time}</div>
            </div>
            {emailCounts[s.key] > 0 && (
              <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                isActive ? s.badgeColor : 'bg-gray-100 text-gray-600'
              }`}>
                {emailCounts[s.key]}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
