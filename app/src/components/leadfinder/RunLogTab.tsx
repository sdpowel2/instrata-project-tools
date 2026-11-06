// Run log: the last 100 runs with per-source results, errors and resume cursors.

import { Fragment } from 'react';
import { History } from 'lucide-react';
import { EmptyState } from '../EmptyState';
import type { RunRow } from './types';
import { SOURCE_LABEL } from './types';
import { fmtDateTime } from './format';
import { Chip, Spinner, Th } from './ui';

const TONE = { succeeded: 'success', partial: 'warn', failed: 'danger', running: 'info' } as const;

export function RunLogTab({ runs, loading }: { runs: RunRow[]; loading: boolean }) {
  if (loading) return <div className="flex justify-center py-16"><Spinner size={22} className="text-orange" /></div>;
  if (!runs.length) {
    return (
      <div className="bg-white border border-border rounded-xl shadow-sm">
        <EmptyState icon={<History size={40} />} title="No runs yet" description="Start one on the Run tab, or wait for the daily run." />
      </div>
    );
  }
  return (
    <div className="bg-white border border-border rounded-xl shadow-sm overflow-x-auto">
      <table className="w-full min-w-[1000px] text-[13px]">
        <thead className="bg-navy text-white text-left text-[11px]">
          <tr>
            <Th>Started</Th><Th>Trigger</Th><Th>Window</Th><Th>Source</Th><Th>Status</Th>
            <Th className="text-right">Fetched</Th><Th className="text-right">New</Th><Th className="text-right">Updated</Th>
            <Th className="text-right">Calls</Th><Th>First error</Th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r, ri) => {
            const srs = [...(r.lf_source_run ?? [])].sort((a, b) => a.source_id.localeCompare(b.source_id));
            const zebra = ri % 2 === 1 ? 'bg-surface/30' : '';
            const head = (span: number) => (
              <>
                <td rowSpan={span} className="px-4 py-2.5 align-top whitespace-nowrap">
                  {fmtDateTime(r.started_at)}
                  <div className="mt-1"><Chip tone={TONE[r.status]}>run {r.status}</Chip></div>
                </td>
                <td rowSpan={span} className="px-4 py-2.5 align-top text-fg-2 capitalize">{r.trigger}</td>
                <td rowSpan={span} className="px-4 py-2.5 align-top text-fg-2 whitespace-nowrap font-mono text-xs">{r.window_from ?? '—'} → {r.window_to ?? '—'}</td>
              </>
            );
            if (!srs.length) {
              return (
                <tr key={r.id} className={`border-t border-border-soft ${zebra}`}>
                  {head(1)}<td colSpan={7} className="px-4 py-2.5 text-fg-3">No sources ran.</td>
                </tr>
              );
            }
            return (
              <Fragment key={r.id}>
                {srs.map((sr, i) => (
                  <tr key={sr.source_id} className={`${i === 0 ? 'border-t border-border-soft' : ''} ${zebra}`}>
                    {i === 0 && head(srs.length)}
                    <td className="px-4 py-2.5 font-semibold text-fg">{SOURCE_LABEL[sr.source_id] ?? sr.source_id}</td>
                    <td className="px-4 py-2.5"><Chip tone={TONE[sr.status]}>{sr.status}</Chip></td>
                    <td className="px-4 py-2.5 text-right font-mono">{sr.records_fetched}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{sr.records_new}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{sr.records_updated}</td>
                    <td className="px-4 py-2.5 text-right font-mono">{sr.api_calls_used}</td>
                    <td className="px-4 py-2.5 text-xs text-fg-2 max-w-[380px]">
                      {sr.error ?? ''}
                      {sr.resume_cursor && <div className="text-fg-3 font-mono mt-0.5">resume: {JSON.stringify(sr.resume_cursor)}</div>}
                    </td>
                  </tr>
                ))}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
