/**
 * Stage-change email (Seth 2026-10-28). Leadership moves items between statuses
 * by hand, so a 'notify' stage (Closed Won, Closed Lost, Canceled, …) changes
 * nothing in monday; the engine emails config_settings.stage_change_recipients
 * through Salesforce's Send Email action instead, logged on the opportunity.
 */
import type { EmailMessage } from '../salesforce/client.ts';
import { humanStatus } from './plan.ts';
import type { PlannerConfig, StageNotice } from './types.ts';

export const BOARD_TITLE: Record<string, string> = { presales: 'Pre-Sales Summary', prequal: 'Pre-Qualification', triage: 'Triage' };

/** Valid recipient list from the setting (an array of addresses); [] = emails off. */
export function stageChangeRecipients(settings: Record<string, unknown>): string[] {
  const v = settings.stage_change_recipients;
  return Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter((s) => /^[^\s@,;]+@[^\s@,;]+$/.test(s)) : [];
}

/** 'presales.follow_up' → 'Follow Up' for the group the item is in on its board. */
export function groupTitle(cfg: PlannerConfig, boardKey: string, groupId: string | null): string {
  const hit = Object.entries(cfg.groups).find(([k, v]) => k.startsWith(`${boardKey}.`) && v === groupId);
  if (!hit) return groupId ?? 'unknown group';
  return hit[0].slice(boardKey.length + 1).split('_').filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function stageNoticeEmail(
  n: StageNotice,
  o: { to: string[]; cfg: PlannerConfig; boards: Record<string, string | null>; sfBase: string | null; mondaySlug: string | null },
): EmailMessage {
  const from = n.fromStage || 'unknown';
  const lines = [
    `${n.opportunityName} moved from ${from} to ${n.toStage} in Salesforce${n.changedBy ? ` (changed by ${n.changedBy})` : ''}.`,
    '',
    `Sales Rep: ${n.salesRep ?? 'not set'}`,
  ];
  if (o.sfBase) lines.push(`Salesforce: ${o.sfBase.replace(/\/$/, '')}/lightning/r/Opportunity/${n.opportunityId}/view`);
  for (const it of n.items) {
    const board = o.boards[it.boardKey];
    lines.push(
      '',
      `monday: ${BOARD_TITLE[it.boardKey] ?? it.boardKey} / ${groupTitle(o.cfg, it.boardKey, it.groupId)}, status ${humanStatus(o.cfg, it.statusLabelId)}` +
        (it.quotedPrice !== null ? `, Quoted Price ${money(it.quotedPrice)}` : ''),
    );
    if (o.mondaySlug && board) lines.push(`https://${o.mondaySlug}.monday.com/boards/${board}/pulses/${it.mondayItemId}`);
  }
  lines.push(
    '',
    'The sync did not change anything in monday. Move the item there if needed.',
    '',
    'This message was sent automatically by the Salesforce-monday sync.',
  );
  return {
    to: o.to.join(','),
    subject: `Salesforce: ${n.opportunityName} is now ${n.toStage}`,
    body: lines.join('\n'),
    relatedRecordId: n.opportunityId,
  };
}
