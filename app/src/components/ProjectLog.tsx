// Project Log — three tabbed sub-views (Comments, Files, Client / GC Log)
// that live on the Project Overview between the tool quick-links and the
// Bill of Materials. Tabs are intentionally unwired right now: each renders
// a styled empty state so the scaffolding is in place for when the
// underlying features (comments persistence, file repo, change-order log)
// get built out. The full view-level sub-components (composer, folder rail,
// timeline) are sketched here for future reference and intentionally not
// rendered until there's real data to drive them.
import { useState, type ComponentType } from 'react';
import {
  MessageSquareWarning, Folder, ClipboardCheck, BookOpen,
  Download, Paperclip, Smile, Send, Reply, ChevronRight,
  Users, FileText, Zap, Flag,
} from 'lucide-react';
import type { Project } from '../types';
import { Eyebrow } from './ui';

type TabKey = 'comments' | 'files' | 'client';

interface TabDef {
  key: TabKey;
  label: string;
  icon: ComponentType<{ size?: number }>;
  count: number;
}

export function ProjectLog({ project: _project }: { project: Project }) {
  const [tab, setTab] = useState<TabKey>('comments');

  // Counts default to 0 until the backing data is wired up. They render in
  // the tab-pill regardless so the styling matches the design today.
  const tabs: TabDef[] = [
    { key: 'comments', label: 'Comments',          icon: MessageSquareWarning, count: 0 },
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
        {tab === 'comments' && <CommentsTabPlaceholder />}
        {tab === 'files'    && <FilesTabPlaceholder />}
        {tab === 'client'   && <ClientLogTabPlaceholder />}
      </div>
    </div>
  );
}

// =============================================================================
// Tab placeholders — each tab renders a styled empty state. The full
// sub-components below are kept in this file so the design scaffolding is
// available when the corresponding feature is built out.
// =============================================================================

function CommentsTabPlaceholder() {
  return (
    <div className="px-6 py-14 text-center">
      <div className="w-12 h-12 rounded-xl bg-navy/[0.06] text-navy flex items-center justify-center mx-auto mb-3.5">
        <MessageSquareWarning size={22} />
      </div>
      <div className="text-base font-semibold text-navy">Comments coming soon</div>
      <div className="text-[13px] text-fg-2 max-w-[440px] mx-auto mt-1.5">
        Inline comments with reactions, replies, and notification indicators will live here.
        Posts will be timestamped and appended in real time.
      </div>
    </div>
  );
}

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
// Background reference scaffolding — the full design styling for each tab
// kept in code so we can borrow shapes when the features are built out.
// These components are intentionally unused for now.
// =============================================================================

interface CommentBody {
  id: string;
  author: string;
  initials: string;
  color: string;
  at: string;
  body: string;
  reactions: { e: string; n: number }[];
  replies: {
    id: string; author: string; initials: string; color: string; at: string; body: string;
  }[];
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _CommentsScaffold({ comments }: { comments: CommentBody[] }) {
  return (
    <div className="flex flex-col">
      {/* Composer */}
      <div className="px-5.5 py-4.5 border-b border-border bg-surface/40" style={{ paddingLeft: 22, paddingRight: 22 }}>
        <div className="flex gap-3">
          <Avatar initials="ME" color="var(--color-orange)" />
          <div className="flex-1">
            <textarea
              rows={2}
              placeholder="Post a comment to the project log..."
              className="w-full px-3 py-2.5 text-[13px] border border-border rounded-lg bg-white resize-y outline-none box-border"
            />
            <div className="mt-2 flex items-center justify-between">
              <div className="flex gap-1.5 text-fg-2">
                <IconBtn icon={Paperclip} title="Attach file" />
                <IconBtn icon={Smile} title="Add reaction" />
              </div>
              <button className="btn-orange text-sm">
                <Send size={14} /> Post
              </button>
            </div>
          </div>
        </div>
      </div>

      <div>
        {comments.map((c, i) => (
          <_CommentRow key={c.id} comment={c} isLast={i === comments.length - 1} />
        ))}
      </div>
    </div>
  );
}

function _CommentRow({ comment, isLast }: { comment: CommentBody; isLast: boolean }) {
  const [showReplies, setShowReplies] = useState(false);
  const replyCount = comment.replies?.length || 0;
  const reacts = comment.reactions || [];

  return (
    <div
      className="px-5.5 py-4.5"
      style={{ paddingLeft: 22, paddingRight: 22, borderBottom: isLast ? 'none' : '1px solid var(--color-border)' }}
    >
      <div className="flex gap-3">
        <Avatar initials={comment.initials} color={comment.color} />
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="text-[13px] font-semibold text-fg">{comment.author}</span>
            <span className="text-xs text-fg-2 font-mono">{comment.at}</span>
          </div>
          <div className="mt-1 text-[13.5px] leading-[1.55] text-fg">{comment.body}</div>

          {reacts.length > 0 && (
            <div className="mt-2 flex gap-1.5">
              {reacts.map((r, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs text-fg"
                  style={{
                    background: 'rgba(0,114,206,0.08)',
                    border: '1px solid rgba(0,114,206,0.18)',
                  }}
                >
                  <span>{r.e}</span>
                  <span className="font-mono font-semibold" style={{ color: '#0072CE' }}>{r.n}</span>
                </span>
              ))}
            </div>
          )}

          <div className="mt-2 flex items-center gap-3.5 text-xs">
            <ActionLink icon={Smile} label="React" />
            <ActionLink icon={Reply} label="Reply" />
            {replyCount > 0 && (
              <button
                onClick={() => setShowReplies((s) => !s)}
                className="appearance-none border-0 bg-transparent cursor-pointer text-xs font-semibold inline-flex items-center gap-1.5 p-0"
                style={{ color: '#0072CE' }}
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
          </div>

          {showReplies && replyCount > 0 && (
            <div className="mt-3.5 pl-3.5 border-l-2 border-border flex flex-col gap-3.5">
              {comment.replies.map((r) => (
                <div key={r.id} className="flex gap-2.5">
                  <Avatar initials={r.initials} color={r.color} size={26} />
                  <div className="flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-[12.5px] font-semibold text-fg">{r.author}</span>
                      <span className="text-[11px] text-fg-2 font-mono">{r.at}</span>
                    </div>
                    <div className="mt-1 text-[13px] leading-[1.55] text-fg">{r.body}</div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

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

function ActionLink({ icon: Icon, label }: { icon: ComponentType<{ size?: number }>; label: string }) {
  return (
    <button className="appearance-none border-0 bg-transparent cursor-pointer p-0 inline-flex items-center gap-1.5 text-xs font-medium text-fg-2 hover:text-navy transition-colors">
      <Icon size={12} />
      <span>{label}</span>
    </button>
  );
}

function IconBtn({ icon: Icon, title }: { icon: ComponentType<{ size?: number }>; title: string }) {
  return (
    <button
      title={title}
      className="appearance-none border border-transparent bg-transparent cursor-pointer rounded-md p-1.5 text-fg-2 inline-flex hover:bg-white hover:border-border"
    >
      <Icon size={14} />
    </button>
  );
}

// File / log scaffolding kept here so the styling vocabulary is available.

const _FILE_KIND_META = {
  pdf: { color: '#B91C1C', label: 'PDF' },
  doc: { color: '#0072CE', label: 'DOC' },
  xls: { color: '#15803D', label: 'XLS' },
  zip: { color: '#6B7280', label: 'ZIP' },
  img: { color: '#A16207', label: 'IMG' },
} as const;

const _LOG_KIND_META = {
  meeting:        { icon: Users,    color: '#0072CE',                 label: 'Meeting' },
  contract:       { icon: FileText, color: 'var(--color-navy)',       label: 'Contract' },
  'change-order': { icon: Zap,      color: '#A16207',                 label: 'Change Order' },
  milestone:      { icon: Flag,     color: '#15803D',                 label: 'Milestone' },
} as const;

const _COR_STATUS_META = {
  Requested: { bg: '#DBEAFE', fg: '#1D4ED8' },
  Proposed:  { bg: '#FEF9C3', fg: '#A16207' },
  Rejected:  { bg: '#FEE2E2', fg: '#B91C1C' },
  'On Hold': { bg: '#F3F4F6', fg: '#4B5563' },
  Accepted:  { bg: '#DCFCE7', fg: '#15803D' },
} as const;

// Surface the unused symbols so the linter doesn't strip the file. These
// will be wired up when the corresponding feature ships.
export const _PROJECT_LOG_SCAFFOLD = {
  Avatar,
  ActionLink,
  IconBtn,
  CommentsScaffold: _CommentsScaffold,
  CommentRow: _CommentRow,
  FILE_KIND_META: _FILE_KIND_META,
  LOG_KIND_META: _LOG_KIND_META,
  COR_STATUS_META: _COR_STATUS_META,
};
