/**
 * Webhook endpoints. Persist first, process later (spec §3.4): a handler only
 * authenticates, extracts IDs, writes one webhook_inbox row, and returns 200.
 * It never calls an external API, so a slow monday or Salesforce can't make a
 * webhook time out (Salesforce does not retry failed Flow callouts).
 */
import type { Request, Response, Router } from 'express';
import express from 'express';
import type { Queryable } from '../db/pool.ts';
import { log, errMessage } from '../log.ts';
import {
  mondayDedupeHash, parseMondayEvent, parseSalesforceEvent, safeEqual, salesforceDedupeHash,
} from './parse.ts';

export interface IngressDeps {
  db: Queryable;
  salesforceSecret: string;
  mondayPathSecret: string;
  /** Called after a row lands, to wake the worker. */
  onIngest: () => void;
}

async function enqueue(db: Queryable, source: 'salesforce' | 'monday', payload: unknown, dedupeHash: string): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `insert into webhook_inbox (source, payload, dedupe_hash) values ($1, $2::jsonb, $3)
     on conflict (dedupe_hash) do nothing returning id`,
    [source, JSON.stringify(payload), dedupeHash]);
  return rows.length > 0;
}

export function ingressRouter(deps: IngressDeps): Router {
  const r = express.Router();

  r.post('/webhooks/salesforce', async (req: Request, res: Response) => {
    if (!safeEqual(req.header('x-avss-secret') ?? '', deps.salesforceSecret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const ev = parseSalesforceEvent(req.body);
    if (!ev) {
      res.status(400).json({ error: 'expected {object, record_id, opportunity_id}' });
      return;
    }
    try {
      await enqueue(deps.db, 'salesforce', req.body, salesforceDedupeHash(ev, new Date()));
      deps.onIngest();
      res.json({ ok: true });
    } catch (e) {
      log.error('salesforce ingest failed', { error: errMessage(e) });
      res.status(500).json({ error: 'ingest failed' });
    }
  });

  r.post('/webhooks/monday/:secret', async (req: Request, res: Response) => {
    if (!safeEqual(String(req.params.secret ?? ''), deps.mondayPathSecret)) {
      res.status(404).end();
      return;
    }
    // Subscription handshake: monday POSTs {"challenge": "…"} and expects it echoed.
    if (req.body && typeof req.body.challenge === 'string') {
      res.json({ challenge: req.body.challenge });
      return;
    }
    const ev = parseMondayEvent(req.body);
    if (!ev) {
      res.json({ ok: true, ignored: true }); // never make monday retry a payload we can't use
      return;
    }
    try {
      await enqueue(deps.db, 'monday', req.body, mondayDedupeHash(req.body, ev));
      deps.onIngest();
      res.json({ ok: true });
    } catch (e) {
      log.error('monday ingest failed', { error: errMessage(e) });
      res.status(500).json({ error: 'ingest failed' });
    }
  });

  return r;
}
