import { useState, useEffect, useCallback } from 'react';
import { UserPlus, Trash2, ShieldCheck, Shield, Loader2 } from 'lucide-react';
import { Modal } from './Modal';
import { supabase, isSupabaseConfigured } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

interface ProjectMember {
  user_id: string;
  email: string;
  full_name: string | null;
  role: string;
}

interface AvailableUser {
  id: string;
  email: string;
  full_name: string | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  projectId: string;
  projectName: string;
}

export function ProjectMembersModal({ open, onClose, projectId, projectName }: Props) {
  const { isAdmin } = useAuth();
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [availableUsers, setAvailableUsers] = useState<AvailableUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState('');

  const fetchMembers = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase
      .from('project_members')
      .select('user_id, profiles(email, full_name, role)')
      .eq('project_id', projectId);

    if (error) {
      console.error('[ProjectMembers] Failed to fetch members:', error);
      setMembers([]);
    } else {
      const mapped: ProjectMember[] = (data ?? []).map((row: any) => ({
        user_id: row.user_id,
        email: row.profiles?.email ?? 'Unknown',
        full_name: row.profiles?.full_name ?? null,
        role: row.profiles?.role ?? 'member',
      }));
      setMembers(mapped);
    }
    setLoading(false);
  }, [projectId]);

  const fetchAvailableUsers = useCallback(async () => {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, email, full_name');

    if (error) {
      console.error('[ProjectMembers] Failed to fetch profiles:', error);
      return;
    }
    setAvailableUsers(data ?? []);
  }, []);

  useEffect(() => {
    if (open && isSupabaseConfigured()) {
      fetchMembers();
      fetchAvailableUsers();
    }
  }, [open, fetchMembers, fetchAvailableUsers]);

  const handleAdd = async () => {
    if (!selectedUserId) return;
    setAdding(true);
    const { error } = await supabase
      .from('project_members')
      .insert({ project_id: projectId, user_id: selectedUserId });

    if (error) {
      console.error('[ProjectMembers] Failed to add member:', error);
      if (error.code === '23505') {
        alert('This user is already a member of this project.');
      } else {
        alert('Failed to add member.');
      }
    } else {
      setSelectedUserId('');
      await fetchMembers();
    }
    setAdding(false);
  };

  const handleRemove = async (userId: string) => {
    setRemoving(userId);
    const { error } = await supabase
      .from('project_members')
      .delete()
      .eq('project_id', projectId)
      .eq('user_id', userId);

    if (error) {
      console.error('[ProjectMembers] Failed to remove member:', error);
      alert('Failed to remove member.');
    } else {
      await fetchMembers();
    }
    setRemoving(null);
  };

  // Users not yet in the project
  const memberIds = new Set(members.map((m) => m.user_id));
  const nonMembers = availableUsers.filter((u) => !memberIds.has(u.id));

  if (!isSupabaseConfigured()) {
    return (
      <Modal open={open} onClose={onClose} title="Project Team">
        <p className="text-sm text-text-secondary">
          Team management requires Supabase to be configured.
        </p>
      </Modal>
    );
  }

  return (
    <Modal open={open} onClose={onClose} title={`Team — ${projectName}`}>
      {/* Add member */}
      {isAdmin && (
        <div className="flex items-center gap-2 mb-5">
          <select
            value={selectedUserId}
            onChange={(e) => setSelectedUserId(e.target.value)}
            className="flex-1 text-sm border border-border rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-navy/20 focus:border-navy"
          >
            <option value="">Select a user to add...</option>
            {nonMembers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.full_name || u.email} ({u.email})
              </option>
            ))}
          </select>
          <button
            onClick={handleAdd}
            disabled={!selectedUserId || adding}
            className="flex items-center gap-1.5 px-4 py-2 bg-navy text-white text-sm font-medium rounded-lg hover:bg-navy-light transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {adding ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
            Add
          </button>
        </div>
      )}

      {/* Members list */}
      {loading ? (
        <div className="flex items-center justify-center py-8 text-text-secondary">
          <Loader2 size={20} className="animate-spin mr-2" />
          Loading members...
        </div>
      ) : members.length === 0 ? (
        <p className="text-sm text-text-secondary text-center py-6">
          No members assigned to this project yet.
        </p>
      ) : (
        <div className="space-y-2">
          {members.map((member) => (
            <div
              key={member.user_id}
              className="flex items-center justify-between p-3 rounded-lg border border-border bg-surface/30"
            >
              <div className="flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-navy/10 flex items-center justify-center">
                  {member.role === 'admin' ? (
                    <ShieldCheck size={14} className="text-navy" />
                  ) : (
                    <Shield size={14} className="text-text-secondary" />
                  )}
                </div>
                <div>
                  <div className="text-sm font-medium text-text-primary">
                    {member.full_name || member.email}
                  </div>
                  <div className="text-xs text-text-secondary">{member.email}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs px-2 py-0.5 rounded-full bg-navy/10 text-navy font-medium capitalize">
                  {member.role}
                </span>
                {isAdmin && (
                  <button
                    onClick={() => handleRemove(member.user_id)}
                    disabled={removing === member.user_id}
                    className="p-1.5 rounded-lg text-text-secondary hover:text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
                    title="Remove from project"
                  >
                    {removing === member.user_id ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Trash2 size={14} />
                    )}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
