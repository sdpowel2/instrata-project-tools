import { useEffect, useRef, useState } from 'react';
import { Bell, X } from 'lucide-react';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

interface Notification {
  id: string;
  type: string;
  title: string;
  message: string | null;
  related_id: string | null;
  read: boolean;
  created_at: string;
}

export function NotificationBell() {
  const { user } = useAuth();
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Load on mount
  useEffect(() => {
    if (!user || !isSupabaseConfigured()) return;
    let cancelled = false;

    supabase
      .from('notifications')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(30)
      .then(({ data }) => {
        if (!cancelled && data) setNotifications(data as Notification[]);
      });

    return () => { cancelled = true; };
  }, [user]);

  // Realtime — new notifications pushed to this user
  useEffect(() => {
    if (!user || !isSupabaseConfigured()) return;

    const channel = supabase
      .channel(`notifications:${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'notifications',
          filter: `user_id=eq.${user.id}`,
        },
        (payload) => {
          setNotifications((prev) => [payload.new as Notification, ...prev]);
        },
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user]);

  // Close panel on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const unreadCount = notifications.filter((n) => !n.read).length;

  const markAllRead = async () => {
    const ids = notifications.filter((n) => !n.read).map((n) => n.id);
    if (ids.length === 0) return;
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
    await supabase.from('notifications').update({ read: true }).in('id', ids);
  };

  const handleOpen = () => {
    const next = !open;
    setOpen(next);
    if (next) markAllRead();
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={handleOpen}
        title="Notifications"
        className="relative p-1.5 rounded-md text-white/50 hover:text-white hover:bg-white/10 transition-colors"
      >
        <Bell size={15} />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 rounded-full bg-orange text-white text-[9px] font-bold flex items-center justify-center leading-none">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="fixed bottom-20 left-64 w-80 max-h-[480px] bg-white border border-border rounded-xl shadow-2xl z-50 flex flex-col">
          <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
            <span className="text-sm font-semibold text-navy">Notifications</span>
            <button
              onClick={() => setOpen(false)}
              className="p-1 rounded-md text-text-secondary hover:bg-surface transition-colors"
            >
              <X size={14} />
            </button>
          </div>

          <div className="overflow-y-auto flex-1">
            {notifications.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-text-secondary">
                No notifications yet
              </div>
            ) : (
              <div>
                {notifications.map((n, i) => (
                  <div
                    key={n.id}
                    className={[
                      'px-4 py-3',
                      i > 0 ? 'border-t border-border' : '',
                      !n.read ? 'bg-blue-50/50' : '',
                    ].join(' ')}
                  >
                    <div className="flex items-start gap-2.5">
                      {!n.read && (
                        <div className="w-1.5 h-1.5 rounded-full bg-navy mt-[5px] flex-shrink-0" />
                      )}
                      <div className={!n.read ? 'flex-1' : 'flex-1 pl-4'}>
                        <div className="text-sm font-medium text-text-primary leading-snug">
                          {n.title}
                        </div>
                        {n.message && (
                          <p className="text-xs text-text-secondary mt-1 leading-relaxed">
                            {n.message}
                          </p>
                        )}
                        <div className="text-[11px] text-text-secondary mt-1.5">
                          {new Date(n.created_at).toLocaleString()}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
