/**
 * The two tasks a Won deal opens (Seth 2026-10-20; spec §6.2, open items O-3/O-4/O-5).
 * Pure — used by the reconcile planner (engine sets Won) and the monday status
 * webhook (a person sets Won).
 *
 *   won_handoff  due N business days after Won (config handoff_sla_business_days,
 *                5), 5 pm ET; Hope marks it Done when the handoff package is sent.
 *   open_job     no due date: sits in Hope's Queue's "Job Opening" group for as
 *                long as the deal is confirmed-to-win but not contracted (often
 *                months), and closes itself once the Post-Sales copy has a
 *                Project Number. That group doubles as Lee's confirmed-to-win list.
 *                End state (board refactor): a Confirmed-to-Win board with an "Open
 *                Job" button that raises this task due in 2 business days.
 * Both open ONCE per item: Won toggled off and on again never reopens a task Hope
 * already closed.
 */
import type { TaskIntent } from '../reconcile/types.ts';

type OpenIntent = Extract<TaskIntent, { op: 'open' }>;

export function wonTaskIntents(itemId: string, dealName: string, ref: OpenIntent['sourceRef']): OpenIntent[] {
  return [
    {
      op: 'open', taskType: 'won_handoff', dedupeKey: `won_handoff:${itemId}`, once: true, title: `Won – handoff: ${dealName}`,
      details: "Send the pre-sales → post-sales handoff package. Mark Done when it's sent.", sourceRef: ref,
    },
    {
      op: 'open', taskType: 'open_job', dedupeKey: `open_job:${itemId}`, once: true, title: `Won – open job: ${dealName}`,
      details: 'Confirmed to win; waiting for the contract so the job can be opened. ' +
        "This closes itself once the deal's Post-Sales item has a Project Number.",
      sourceRef: ref,
    },
  ];
}

/**
 * The deal left Won (Seth 2026-10-20): still-open Won tasks are withdrawn — taken off
 * Hope's Queue, not counted as done. A later Won brings them back with a fresh due
 * date; a handoff Hope already sent or a job already opened stays done.
 */
export function withdrawWonIntents(itemId: string): Extract<TaskIntent, { op: 'close' }>[] {
  return [
    { op: 'close', dedupeKey: `won_handoff:${itemId}`, withdraw: true },
    { op: 'close', dedupeKey: `open_job:${itemId}`, withdraw: true },
  ];
}

export function handoffSlaDays(settings: Record<string, unknown>): number | null {
  const n = Number(settings.handoff_sla_business_days);
  return Number.isInteger(n) && n > 0 ? n : null;
}
