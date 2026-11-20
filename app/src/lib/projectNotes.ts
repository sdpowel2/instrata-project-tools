// Project notes: the project wiki's Notes section (My Day 2.6). Dated summaries
// anyone signed in can read and add in their own name; the author or an admin
// edits or deletes. Things people log in My Day under a project land here through
// the nightly filing (file_project_notes). Table: project_notes, from
// supabase/migrations/add_brain_pages.sql.
import { supabase, isSupabaseConfigured } from './supabase';

export interface ProjectNote {
  id: string;
  projectId: string;
  text: string;
  link: string | null;
  source: 'my_day' | 'manual';
  notedBy: string | null;
  notedByName: string;
  notedAt: string;
}

const COLS = 'id, project_id, text, link, source, noted_by, noted_at, profiles:noted_by(email, full_name)';

interface Row {
  id: string;
  project_id: string;
  text: string;
  link: string | null;
  source: 'my_day' | 'manual';
  noted_by: string | null;
  noted_at: string;
  profiles?: { email?: string; full_name?: string } | null;
}

function toNote(r: Row): ProjectNote {
  return {
    id: r.id,
    projectId: r.project_id,
    text: r.text,
    link: r.link,
    source: r.source,
    notedBy: r.noted_by,
    notedByName: r.profiles?.full_name || r.profiles?.email || 'Someone',
    notedAt: r.noted_at,
  };
}

/** "relation does not exist": the 2.6 migration isn't applied yet, so there are no notes. */
function notMigrated(error: { code?: string } | null): boolean {
  return !!error && (error.code === '42P01' || error.code === 'PGRST205');
}

// Offline demo mode: a few fictional notes on the first sample project.
const DEMO_NOTES: ProjectNote[] = [
  {
    id: 'demo-n1', projectId: 'p1', source: 'my_day', notedBy: null, notedByName: 'Seth Powell',
    text: 'GC moved the Room 311 walkthrough to Friday at 9; ceiling grid goes in the week after.',
    link: null, notedAt: '2026-11-18T13:05:00Z',
  },
  {
    id: 'demo-n2', projectId: 'p1', source: 'manual', notedBy: null, notedByName: 'Seth Powell',
    text: 'Owner approved the display upgrade in the boardroom (98" instead of 86"). Change order to follow.',
    link: null, notedAt: '2026-11-12T19:40:00Z',
  },
  {
    id: 'demo-n3', projectId: 'p1', source: 'my_day', notedBy: null, notedByName: 'Seth Powell',
    text: 'Consultant confirmed Dante for the training room; no analog tie-lines needed.',
    link: null, notedAt: '2026-10-29T15:20:00Z',
  },
];

export async function fetchProjectNotes(projectId: string, limit = 200): Promise<ProjectNote[]> {
  if (!isSupabaseConfigured()) return DEMO_NOTES.filter((n) => n.projectId === projectId).slice(0, limit);
  const { data, error } = await supabase
    .from('project_notes')
    .select(COLS)
    .eq('project_id', projectId)
    .order('noted_at', { ascending: false })
    .limit(limit);
  if (notMigrated(error)) return [];
  if (error) throw new Error(`Failed to load notes: ${error.message}`);
  return ((data ?? []) as unknown as Row[]).map(toNote);
}

export async function addProjectNote(projectId: string, text: string, link?: string | null): Promise<ProjectNote> {
  const { data, error } = await supabase
    .from('project_notes')
    .insert({ project_id: projectId, text: text.trim().slice(0, 2000), link: link?.trim() || null, source: 'manual' })
    .select(COLS)
    .single();
  if (error) throw new Error(`The note didn't save: ${error.message}`);
  return toNote(data as unknown as Row);
}

export async function updateProjectNote(id: string, text: string): Promise<void> {
  const { error } = await supabase.from('project_notes').update({ text: text.trim().slice(0, 2000) }).eq('id', id);
  if (error) throw new Error(`The note didn't save: ${error.message}`);
}

export async function deleteProjectNote(id: string): Promise<void> {
  const { error } = await supabase.from('project_notes').delete().eq('id', id);
  if (error) throw new Error(`The note wasn't deleted: ${error.message}`);
}

/** "November 2026" style month heading, Eastern time. */
export function noteMonth(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/New_York' });
}

/** "Nov 18" style date, Eastern time. */
export function noteDay(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
}
