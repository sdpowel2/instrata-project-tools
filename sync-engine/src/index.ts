/**
 * Instrata sync engine — Salesforce ↔ monday sync + Hope's Queue.
 * Spec: Product Spec/project-tools-sync-and-queue-spec.md
 * Plan: Product Spec/sync-and-queue-implementation-plan.md
 *
 * This slice: config + drift check at boot, and an internal manual-reconcile
 * endpoint (usable against the sandbox before the Salesforce Flows exist).
 * Webhook ingress, the inbox worker and the schedulers come next.
 */
import { timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import { loadEnv } from './env.ts';
import { createDb } from './db/pool.ts';
import { setEngineStatus } from './db/store.ts';
import { loadRuntimeConfig, type RuntimeConfig } from './config/load.ts';
import { runDriftCheck } from './config/driftRunner.ts';
import type { DriftResult } from './config/drift.ts';
import { createMondayClient } from './monday/client.ts';
import { createSalesforceClient } from './salesforce/client.ts';
import { createWriteGate } from './writeGate.ts';
import { reconcileOpportunities } from './reconcile/service.ts';
import { assertSfId } from './salesforce/soql.ts';
import { errMessage, log } from './log.ts';

const env = loadEnv();
const db = createDb(env.databaseUrl, env.dbSchema);
const monday = createMondayClient({ token: env.monday.token, apiVersion: env.monday.apiVersion });
const salesforce = createSalesforceClient(env.salesforce);
const gate = createWriteGate(env.syncMode, monday, salesforce);

// ── Config cache: reloaded at most once a minute (NOTIFY-driven reload comes with the worker) ──
const CONFIG_TTL_MS = 60_000;
let cached: { cfg: RuntimeConfig; at: number } | null = null;
let lastDrift: DriftResult = { findings: [], blockedColumns: [], deadMapRows: [] };

async function getConfig(): Promise<RuntimeConfig> {
  if (cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.cfg;
  const cfg = await loadRuntimeConfig(db, lastDrift);
  cached = { cfg, at: Date.now() };
  return cfg;
}

async function refreshDrift(): Promise<void> {
  lastDrift = await runDriftCheck(db, monday, await loadRuntimeConfig(db));
  cached = null;
  if (lastDrift.findings.length > 0) log.warn('config drift', { findings: lastDrift.findings.length, blocked: lastDrift.blockedColumns });
}

const deps = { db, gate, monday, salesforce, getConfig };

// ── HTTP ──
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Internal endpoints: mcp-server and the sync-admin edge function only. */
function internalOnly(req: Request, res: Response, next: NextFunction) {
  const got = req.header('x-internal-secret') ?? '';
  if (!safeEqual(got, env.internalSecret)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

app.get('/status', internalOnly, async (_req, res) => {
  res.json({ mode: env.syncMode, schema: env.dbSchema, drift: lastDrift.findings.length, blockedColumns: lastDrift.blockedColumns });
});

app.post('/admin/reconcile/:opportunityId', internalOnly, async (req, res) => {
  let id: string;
  try {
    id = assertSfId(String(req.params.opportunityId));
  } catch (e) {
    res.status(400).json({ error: errMessage(e) });
    return;
  }
  try {
    const summary = await reconcileOpportunities(deps, [id]);
    res.json({ mode: env.syncMode, ...summary });
  } catch (e) {
    log.error('manual reconcile failed', { id, error: errMessage(e) });
    res.status(502).json({ error: errMessage(e) });
  }
});

// ── Boot ──
async function main() {
  await refreshDrift();
  await setEngineStatus(db, 'boot', { mode: env.syncMode, schema: env.dbSchema, at: new Date().toISOString() });
  app.listen(env.port, () => log.info('sync-engine listening', { port: env.port, mode: env.syncMode, schema: env.dbSchema }));
}

main().catch((e) => {
  log.error('boot failed', { error: errMessage(e) });
  process.exit(1);
});
