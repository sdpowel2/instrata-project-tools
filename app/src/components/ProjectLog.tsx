// Project Log — three tabbed sub-views (Comments, Files, Client / GC Log).
// Comments are live as of this commit. Files and Client / GC Log render
// styled empty states until the underlying features land. The Comments
// view follows the design originally staged in this file: an avatar chip
// with the author's name + timestamp, threaded replies that default to
// collapsed behind a notification badge showing the reply count, and a
// scrollable history bounded to a fixed height that the user can expand
// when the thread outgrows it.
import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import {
  MessageSquareWarning, Folder, ClipboardCheck, BookOpen,
  Download, Smile, Send, Reply, ChevronRight, ChevronDown,
  Pencil, Trash2, Check, X, Loader2,
} from 'lucide-react';
import type { Project, ProjectComment } from '../types';
import { Eyebrow } from './ui';
import { useStore } from '../store';
import { isSupabaseConfigured } from '../lib/supabase';
import { useAuth } from '../contexts/AuthContext';

type TabKey = 'comments' | 'files' | 'client';

interface TabDef {
  key: TabKey;
  label: string;
  icon: ComponentType<{ size?: number }>;
  count: number;
}

export function ProjectLog({ project }: { project: Project }) {
  const [tab, setTab] = useState<TabKey>('comments');

  // Pre-fetch comments on mount so the tab badge count is accurate even
  // before the user opens the tab. The store dedupes by projectId on the
  // commentsLoadedFor set, so re-mounts are cheap.
  const fetchProjectComments = useStore((s) => s.fetchProjectComments);
  useEffect(() => {
    fetchProjectComments(project.id);
  }, [project.id, fetchProjectComments]);

  const allComments = useStore((s) => s.projectComments);
  const projectCommentCount = useMemo(
    () => allComments.filter((c) => c.projectId === project.id).length,
    [allComments, project.id],
  );

  const tabs: TabDef[] = [
    { key: 'comments', label: 'Comments',          icon: MessageSquareWarning, count: projectCommentCount },
    { key: 'files',    label: 'Files',             icon: Folder,               count: 0 },
    { key: 'client',   label: 'Client / GC Log',   icon: ClipboardCheck,       count: 0 },
  ];

  return (
    <div className="bg-white border border-border rounded-xl shadow-sm overflow-hidden">
      <div className="px-5.5 pt-4.5 border-b border-border" style={{ paddingLeft: 22, paddingRight: 22, paddingTop: 18 }}>
        <div className="flex items-start justify-between gap-4 flex-wrap mb-3.5">
          <div className="flex items-center gap-3.5">
            <div className="w-11 h-11 rounded-[10px] bg-navy/[0.06] text-navy flex items-center justify-center">
              <BookOpen size={22} />
            </div>
            <div>
              <Eyebrow>Project Log</Eyebrow>
              <h2 className="text-lg font-bold text-navy m-0 mt-0.5">Activity, Files &amp; History</h2>
              <div className="text-xs text-fg-2 mt-0.5">
                Auto-generated. Comments and files are appended by the team; the Client/GC Log is read-only.
              </div>
            </div>
          </div>
          {/* Per-tab CTAs — Export PDF on Client/GC Log, Download all on Files,
              nothing on Comments. Buttons are visual only until generation /
              archive endpoints exist. */}
          {tab === 'client' && (
            <button className="btn-secondary text-sm" disabled>
              <Download size={14} /> Export PDF
            </button>
          )}
          {tab === 'files' && (
            <button className="btn-secondary text-sm" disabled>
              <Download size={14} /> Download all (.zip)
            </button>
          )}
        </div>

        <div className="flex gap-1">
          {tabs.map((t) => {
            const active = tab === t.key;
            const Icon = t.icon;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className="appearance-none border-0 bg-transparent cursor-pointer font-inherit inline-flex items-center gap-2 px-3.5 pt-2.5 pb-3 text-[13px] font-semibold"
                style={{
                  color: active ? 'var(--color-navy)' : 'var(--color-fg-2)',
                  borderBottom: active ? '2px solid var(--color-orange)' : '2px solid transparent',
                  marginBottom: -1,
                }}
              >
                <Icon size={14} />
                <span>{t.label}</span>
                <span
                  className="text-[11px] font-semibold font-mono px-[7px] py-px rounded-full"
                  style={{
                    background: active ? 'rgba(246,141,46,0.12)' : 'var(--color-surface)',
                    color: active ? 'var(--color-orange)' : 'var(--color-fg-2)',
                  }}
                >
                  {t.count}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        {tab === 'comments' && <CommentsTab projectId={project.id} />}
        {tab === 'files'    && <FilesTabPlaceholder />}
        {tab === 'client'   && <ClientLogTabPlaceholder />}
      </div>
    </div>
  );
}

// =============================================================================
// CommentsTab — live chat thread for the project. Top-level comments + flat
// replies (no nesting beyond one level), reactions, edit/delete on your own,
// scrollable history bounded by a fixed height that can be expanded.
// =============================================================================

const COLLAPSED_HEIGHT = 480;
const EXPANDED_HEIGHT = 820;
const REACTION_PALETTE = ['👍', '❤️', '😂', '🎉', '🚀', '👀'];

function CommentsTab({ projectId }: { projectId: string }) {
  const { user } = useAuth();

  const allComments = useStore((s) => s.projectComments);
  const loaded = useStore((s) => s.commentsLoadedFor.has(projectId));
  const addProjectComment = useStore((s) => s.addProjectComment);
  const updateProjectComment = useStore((s) => s.updateProjectComment);
  const deleteProjectComment = useStore((s) => s.deleteProjectComment);
  const toggleCommentReaction = useStore((s) => s.toggleCommentReaction);

  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  const scrollRef = useRef<HTMLDivElement>(null);

  const projectComments = useMemo(
    () => allComments.filter((c) => c.projectId === projectId),
    [allComments, projectId],
  );

  // Top-level threads, oldest first (chat-style: scroll down for newer).
  const topLevel = useMemo(
    () =>
      projectComments
        .filter((c) => !c.parentId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    [projectComments],
  );

  // Index replies by their top-level parent so each thread can render its
  // own reply list without re-scanning the full comment array.
  const repliesByParent = useMemo(() => {
    const map = new Map<string, ProjectComment[]>();
    for (const c of projectComments) {
      if (!c.parentId) continue;
      const arr = map.get(c.parentId) ?? [];
      arr.push(c);
      map.set(c.parentId, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }
    return map;
  }, [projectComments]);

  // Detect whether the thread overflows the collapsed height. Re-runs on
  // every comments / expanded change so the toggle button surfaces and
  // hides as the thread grows or shrinks.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      setOverflowing(false);
      return;
    }
    setOverflowing(el.scrollHeight > el.clientHeight + 1);
  }, [projectComments, expanded]);

  if (!isSupabaseConfigured()) {
    return (
      <div className="px-6 py-14 text-center">
        <div className="w-12 h-12 rounded-xl bg-navy/[0.06] text-navy flex items-center justify-center mx-auto mb-3.5">
          <MessageSquareWarning size={22} />
        </div>
        <div className="text-base font-semibold text-navy">Comments require Supabase</div>
        <div className="text-[13px] text-fg-2 max-w-[440px] mx-auto mt-1.5">
          Configure VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to enable the project chat.
          Demo mode runs without persistence.
        </div>
      </div>
    );
  }

  const handlePost = async () => {
    const trimmed = draft.trim();
    if (!trimmed || posting) return;
    setPosting(true);
    const id = await addProjectComment({ projectId, parentId: null, body: trimmed });
    setPosting(false);
    if (id) setDraft('');
  };

  const handleComposerKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // ⌘/Ctrl-Enter posts; plain Enter inserts a newline so multi-line
    // comments work like every other chat tool.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handlePost();
    }
  };

  const meId = user?.id ?? '';
  const isAdmin = user?.role === 'admin';
  const myInitials = initialsOf(user?.fullName || user?.email || 'You');
  const myColor = userColor(meId || user?.email || 'guest');

  return (
    <div className="flex flex-col">
      {/* Composer */}
      <div className="px-5.5 py-4.5 border-b border-border bg-surface/40" style={{ paddingLeft: 22, paddingRight: 22 }}>
        <div className="flex gap-3">
          <Avatar initials={myInitials} color={myColor} />
          <div className="flex-1">
            <textarea
              rows={2}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleComposerKey}
              placeholder="Post a comment to the project log..."
              className="w-full px-3 py-2.5 text-[13px] border border-border rounded-lg bg-white resize-y outline-none box-border focus:border-navy/50"
            />
            <div className="mt-2 flex items-center justify-between">
              <div className="text-[11px] text-fg-2">
                <kbd className="px-1.5 py-px rounded border border-border bg-white font-mono text-[10px]">⌘</kbd>
                {' '}+{' '}
                <kbd className="px-1.5 py-px rounded border border-border bg-white font-mono text-[10px]">Enter</kbd>
                {' '}to post
              </div>
              <button
                onClick={handlePost}
                disabled={!draft.trim() || posting}
                className="btn-orange text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {posting ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Post
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* History — scrollable bounded container */}
      <div
        ref={scrollRef}
        style={{ maxHeight: expanded ? EXPANDED_HEIGHT : COLLAPSED_HEIGHT, overflowY: 'auto' }}
      >
        {!loaded ? (
          <div className="px-6 py-14 flex items-center justify-center text-sm text-fg-2 gap-2">
            <Loader2 size={14} className="animate-spin" /> Loading comments…
          </div>
        ) : topLevel.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <div className="w-12 h-12 rounded-xl bg-navy/[0.06] text-navy flex items-center justify-center mx-auto mb-3.5">
              <MessageSquareWarning size={22} />
            </div>
            <div className="text-base font-semibold text-navy">Start the conversation</div>
            <div className="text-[13px] text-fg-2 max-w-[440px] mx-auto mt-1.5">
              No comments yet. Post a question, share a status update, or kick off a discussion above.
            </div>
          </div>
        ) : (
          <div>
            {topLevel.map((c, i) => (
              <CommentRow
                key={c.id}
                comment={c}
                replies={repliesByParent.get(c.id) ?? []}
                isFirst={i === 0}
                isLast={i === topLevel.length - 1}
                projectId={projectId}
                meId={meId}
                isAdmin={isAdmin}
                onAddReply={(body) => addProjectComment({ projectId, parentId: c.id, body })}
                onEdit={updateProjectComment}
                onDelete={deleteProjectComment}
                onToggleReaction={toggleCommentReaction}
              />
            ))}
          </div>
        )}
      </div>

      {/* Expand / Collapse toggle — shows once content exceeds the
          default container, or any time the thread is currently expanded. */}
      {(overflowing || expanded) && (
        <div className="border-t border-border bg-surface/40 px-5.5 py-2 flex items-center justify-center" style={{ paddingLeft: 22, paddingRight: 22 }}>
          <button
            onClick={() => setExpanded((e) => !e)}
            className="appearance-none border-0 bg-transparent cursor-pointer text-xs font-semibold text-navy hover:underline inline-flex items-center gap-1.5"
          >
            <ChevronDown
              size={12}
              style={{ transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform .15s' }}
            />
            {expanded ? 'Collapse' : 'Expand'} history
          </button>
        </div>
      )}
    </div>
  );
}

// =============================================================================
// CommentRow — one top-level comment plus its (collapsed-by-default) replies.
// =============================================================================

interface CommentRowProps {
  comment: ProjectComment;
  replies: ProjectComment[];
  isFirst: boolean;
  isLast: boolean;
  projectId: string;
  meId: string;
  isAdmin: boolean;
  onAddReply: (body: string) => Promise<string | null>;
  onEdit: (commentId: string, body: string) => Promise<void>;
  onDelete: (commentId: string) => Promise<void>;
  onToggleReaction: (commentId: string, emoji: string) => Promise<void>;
}

function CommentRow({
  comment, replies, isFirst, isLast, meId, isAdmin,
  onAddReply, onEdit, onDelete, onToggleReaction,
}: CommentRowProps) {
  const [showReplies, setShowReplies] = useState(false);
  const [showReplyComposer, setShowReplyComposer] = useState(false);
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const replyCount = replies.length;

  return (
    <div
      className="px-5.5 py-4"
      style={{
        paddingLeft: 22,
        paddingRight: 22,
        borderTop: isFirst ? 'none' : '1px solid var(--color-border)',
        borderBottom: isLast ? 'none' : undefined,
      }}
    >
      <CommentBody
        comment={comment}
        meId={meId}
        isAdmin={isAdmin}
        size="md"
        onEdit={onEdit}
        onDelete={onDelete}
        onToggleReaction={onToggleReaction}
        showReactionPicker={showReactionPicker}
        setShowReactionPicker={setShowReactionPicker}
        actionRow={
          <>
            <button
              onClick={() => {
                setShowReplyComposer((s) => !s);
                if (!showReplies && replyCount > 0) setShowReplies(true);
              }}
              className="appearance-none border-0 bg-transparent cursor-pointer p-0 inline-flex items-center gap-1.5 text-xs font-medium text-fg-2 hover:text-navy transition-colors"
            >
              <Reply size={12} /> Reply
            </button>
            {replyCount > 0 && (
              <button
                onClick={() => setShowReplies((s) => !s)}
                className="appearance-none border-0 bg-transparent cursor-pointer text-xs font-semibold inline-flex items-center gap-1.5 p-0"
                style={{ color: '#0072CE' }}
                title={`${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`}
              >
                <span
                  className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-[5px] rounded-[9px] text-white text-[10.5px] font-bold font-mono"
                  style={{ background: '#0072CE' }}
                >
                  {replyCount}
                </span>
                <span>{showReplies ? 'Hide' : 'Show'} {replyCount === 1 ? 'reply' : 'replies'}</span>
                <ChevronRight size={11} style={{ transform: showReplies ? 'rotate(90deg)' : undefined, transition: 'transform .15s' }} />
              </button>
            )}
          </>
        }
      />

      {(showReplies || showReplyComposer) && (
        <div className="mt-3.5 pl-3.5 border-l-2 border-border flex flex-col gap-3.5">
          {showReplies && replies.map((r) => (
            <CommentBody
              key={r.id}
              comment={r}
              meId={meId}
              isAdmin={isAdmin}
              size="sm"
              onEdit={onEdit}
              onDelete={onDelete}
              onToggleReaction={onToggleReaction}
              actionRow={null}
            />
          ))}

          {showReplyComposer && (
            <ReplyComposer
              onCancel={() => setShowReplyComposer(false)}
              onSubmit={async (body) => {
                const id = await onAddReply(body);
                if (id) {
                  setShowReplyComposer(false);
                  setShowReplies(true);
                }
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

// =============================================================================
// CommentBody — shared chrome for top-level comments and replies. Owns the
// avatar, header, body (edit-in-place), reactions, and actions row.
// =============================================================================

interface CommentBodyProps {
  comment: ProjectComment;
  meId: string;
  isAdmin: boolean;
  size: 'md' | 'sm';
  onEdit: (commentId: string, body: string) => Promise<void>;
  onDelete: (commentId: string) => Promise<void>;
  onToggleReaction: (commentId: string, emoji: string) => Promise<void>;
  showReactionPicker?: boolean;
  setShowReactionPicker?: (v: boolean) => void;
  actionRow: React.ReactNode;
}

function CommentBody({
  comment, meId, isAdmin, size, onEdit, onDelete, onToggleReaction,
  showReactionPicker, setShowReactionPicker, actionRow,
}: CommentBodyProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const [saving, setSaving] = useState(false);
  // Local state for replies that don't share a picker with their parent.
  const [localPickerOpen, setLocalPickerOpen] = useState(false);
  const pickerOpen = setShowReactionPicker ? !!showReactionPicker : localPickerOpen;
  const setPickerOpen = setShowReactionPicker ?? setLocalPickerOpen;

  const canManage = comment.authorId === meId || isAdmin;
  const avatarSize = size === 'sm' ? 26 : 32;
  const initials = initialsOf(comment.authorName || comment.authorEmail || 'U');
  const color = userColor(comment.authorId);

  const startEdit = () => {
    setDraft(comment.body);
    setEditing(true);
  };

  const saveEdit = async () => {
    const trimmed = draft.trim();
    if (!trimmed || saving) return;
    if (trimmed === comment.body.trim()) {
      setEditing(false);
      return;
    }
    setSaving(true);
    await onEdit(comment.id, trimmed);
    setSaving(false);
    setEditing(false);
  };

  const cancelEdit = () => {
    setDraft(comment.body);
    setEditing(false);
  };

  const handleDelete = async () => {
    if (!window.confirm('Delete this comment? This cannot be undone.')) return;
    await onDelete(comment.id);
  };

  return (
    <div className="flex gap-2.5">
      <Avatar initials={initials} color={color} size={avatarSize} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span
            className="font-semibold text-fg"
            style={{ fontSize: size === 'sm' ? 12.5 : 13 }}
          >
            {comment.authorName}
          </span>
          <span
            className="text-fg-2 font-mono"
            style={{ fontSize: size === 'sm' ? 11 : 12 }}
            title={new Date(comment.createdAt).toLocaleString()}
          >
            {formatTimestamp(comment.createdAt)}
            {comment.edited && <span className="ml-1.5 italic">(edited)</span>}
          </span>
        </div>

        {editing ? (
          <div className="mt-1.5">
            <textarea
              autoFocus
              rows={3}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="w-full px-3 py-2 text-[13px] border border-border rounded-lg bg-white resize-y outline-none box-border focus:border-navy/50"
            />
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={saveEdit}
                disabled={saving || !draft.trim()}
                className="btn-orange text-xs disabled:opacity-50"
              >
                {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />} Save
              </button>
              <button
                onClick={cancelEdit}
                className="btn-secondary text-xs"
              >
                <X size={12} /> Cancel
              </button>
            </div>
          </div>
        ) : (
          <div
            className="mt-1 leading-[1.55] text-fg whitespace-pre-wrap break-words"
            style={{ fontSize: size === 'sm' ? 13 : 13.5 }}
          >
            {comment.body}
          </div>
        )}

        {/* Reactions */}
        {!editing && comment.reactions.length > 0 && (
          <div className="mt-2 flex gap-1.5 flex-wrap">
            {comment.reactions.map((r) => {
              const mine = !!meId && r.userIds.includes(meId);
              return (
                <button
                  key={r.emoji}
                  onClick={() => onToggleReaction(comment.id, r.emoji)}
                  className="appearance-none cursor-pointer inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs text-fg transition-colors"
                  style={{
                    background: mine ? 'rgba(0,114,206,0.16)' : 'rgba(0,114,206,0.08)',
                    border: `1px solid ${mine ? 'rgba(0,114,206,0.5)' : 'rgba(0,114,206,0.18)'}`,
                  }}
                  title={mine ? 'Remove your reaction' : 'Add your reaction'}
                >
                  <span>{r.emoji}</span>
                  <span className="font-mono font-semibold" style={{ color: '#0072CE' }}>{r.userIds.length}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Action row */}
        {!editing && (
          <div className="mt-2 flex items-center gap-3.5 text-xs flex-wrap relative">
            <button
              onClick={() => setPickerOpen(!pickerOpen)}
              className="appearance-none border-0 bg-transparent cursor-pointer p-0 inline-flex items-center gap-1.5 text-xs font-medium text-fg-2 hover:text-navy transition-colors"
            >
              <Smile size={12} /> React
            </button>
            {actionRow}
            {canManage && (
              <>
                <button
                  onClick={startEdit}
                  className="appearance-none border-0 bg-transparent cursor-pointer p-0 inline-flex items-center gap-1.5 text-xs font-medium text-fg-2 hover:text-navy transition-colors"
                >
                  <Pencil size={12} /> Edit
                </button>
                <button
                  onClick={handleDelete}
                  className="appearance-none border-0 bg-transparent cursor-pointer p-0 inline-flex items-center gap-1.5 text-xs font-medium text-fg-2 hover:text-red-700 transition-colors"
                >
                  <Trash2 size={12} /> Delete
                </button>
              </>
            )}

            {pickerOpen && (
              <div
                className="absolute z-10 left-0 top-full mt-1 bg-white border border-border rounded-lg shadow-md flex gap-1 px-2 py-1.5"
              >
                {REACTION_PALETTE.map((emoji) => (
                  <button
                    key={emoji}
                    onClick={() => {
                      onToggleReaction(comment.id, emoji);
                      setPickerOpen(false);
                    }}
                    className="appearance-none border-0 bg-transparent cursor-pointer text-base hover:bg-surface rounded p-1 leading-none"
                    title={emoji}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// ReplyComposer — inline reply textarea under a top-level comment.
// =============================================================================

function ReplyComposer({
  onSubmit, onCancel,
}: { onSubmit: (body: string) => Promise<void>; onCancel: () => void }) {
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async () => {
    const trimmed = body.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    await onSubmit(trimmed);
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-2">
      <textarea
        autoFocus
        rows={2}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            handleSubmit();
          }
        }}
        placeholder="Write a reply..."
        className="w-full px-3 py-2 text-[13px] border border-border rounded-lg bg-white resize-y outline-none box-border focus:border-navy/50"
      />
      <div className="flex items-center gap-2">
        <button
          onClick={handleSubmit}
          disabled={!body.trim() || busy}
          className="btn-orange text-xs disabled:opacity-50"
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />} Reply
        </button>
        <button onClick={onCancel} className="btn-secondary text-xs">
          <X size={12} /> Cancel
        </button>
      </div>
    </div>
  );
}

// =============================================================================
// Files / Client Log placeholders — unchanged from the original scaffold.
// Will be wired up in their own follow-up passes.
// =============================================================================

function FilesTabPlaceholder() {
  return (
    <div className="px-6 py-14 text-center">
      <div className="w-12 h-12 rounded-xl bg-navy/[0.06] text-navy flex items-center justify-center mx-auto mb-3.5">
        <Folder size={22} />
      </div>
      <div className="text-base font-semibold text-navy">Project file repository coming soon</div>
      <div className="text-[13px] text-fg-2 max-w-[440px] mx-auto mt-1.5">
        Standardized folder structure (Contracts, Drawings, Submittals, Meeting Notes, Photos, Closeout)
        with per-file metadata and download support.
      </div>
    </div>
  );
}

function ClientLogTabPlaceholder() {
  return (
    <div className="px-6 py-14 text-center">
      <div className="w-12 h-12 rounded-xl bg-navy/[0.06] text-navy flex items-center justify-center mx-auto mb-3.5">
        <ClipboardCheck size={22} />
      </div>
      <div className="text-base font-semibold text-navy">Client / GC Log coming soon</div>
      <div className="text-[13px] text-fg-2 max-w-[440px] mx-auto mt-1.5">
        Auto-generated timeline of client-level changes — meetings, base-bid contracts,
        change-order tracking (Requested / Proposed / Rejected / On Hold / Accepted),
        and milestone completions.
      </div>
    </div>
  );
}

// =============================================================================
// Helpers
// =============================================================================

function Avatar({ initials, color, size = 32 }: { initials: string; color: string; size?: number }) {
  return (
    <div
      className="rounded-full text-white font-bold flex items-center justify-center flex-shrink-0"
      style={{
        width: size,
        height: size,
        background: color,
        fontSize: size <= 28 ? 11 : 12,
      }}
    >
      {initials}
    </div>
  );
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/[\s@.]+/).filter(Boolean);
  if (parts.length === 0) return 'U';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Deterministic color per user — hashes the user id (or email fallback)
// into a fixed palette so the same person always gets the same chip.
const AVATAR_PALETTE = [
  '#0072CE', '#F68D2E', '#15803D', '#A16207',
  '#7C3AED', '#B91C1C', '#0891B2', '#DB2777',
];
function userColor(seed: string): string {
  if (!seed) return AVATAR_PALETTE[0];
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  }
  return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length];
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const sameYear = d.getFullYear() === now.getFullYear();
  const datePart = d.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
  const timePart = d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${datePart} · ${timePart}`;
}
