/**
 * Instrata sync engine — Salesforce ↔ monday sync + Hope's Queue.
 * Spec: Product Spec/project-tools-sync-and-queue-spec.md
 * Plan: Product Spec/sync-and-queue-implementation-plan.md
 *
 *   POST /webhooks/salesforce          Flow callouts (X-AVSS-Secret)
 *   POST /webhooks/monday/:secret      monday webhooks (path secret + challenge)
 *   GET  /status                       internal
 *   POST /admin/reconcile/:id          internal — manual re-sync (also the MCP tool)
 *   POST /admin/sweep                  internal — run the safety sweep now
 *   POST /admin/backfill               internal — link existing board items ({preview})
 *   POST /admin/requeue-linked         internal — re-check every linked opportunity
 *   GET  /admin/diff-report            internal — monday-now vs Salesforce, per field (?format=csv)
 *   POST /admin/estimator-first-pass   internal — Estimator cleanup ({apply}; ?format=csv)
 *
 * Background: inbox drain (every 2 s, and immediately on ingest), Salesforce
 * safety sweep (hourly, then a retry of items waiting on an engineer mapping),
 * label drift check (hourly), Hope's Queue board push + group placement (every
 * minute), monday webhook registration (at boot).
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import { loadEnv } from './env.ts';
import { createDb } from './db/pool.ts';
import { setEngineStatus } from './db/store.ts';
import { loadRuntimeConfig, type RuntimeConfig } from './config/load.ts';
import { runDriftCheck } from './config/driftRunner.ts';
import type { DriftResult } from './config/drift.ts';
import { createMondayClient } from './monday/client.ts';
import { ensurePresalesWebhooks } from './monday/webhooks.ts';
import { PRESALES_BOARD_KEYS } from './worker/mondayEvents.ts';
import { createSalesforceClient } from './salesforce/client.ts';
import { assertSfId } from './salesforce/soql.ts';
import { createWriteGate } from './writeGate.ts';
import { reconcileOpportunities } from './reconcile/service.ts';
import { ingressRouter } from './ingress/routes.ts';
import { safeEqual } from './ingress/parse.ts';
import { drainInbox, type WorkerDeps } from './worker/process.ts';
import { inboxStats } from './worker/inbox.ts';
import { runSweep, type SweepResult } from './schedule/sweep.ts';
import { runBackfill } from './backfill/run.ts';
import { requeueLinked } from './schedule/requeue.ts';
import { buildDiffReport, reportCsv } from './report/run.ts';
import { firstPassCsv, retryUnmappedEngineers, runEstimatorFirstPass } from './assign/run.ts';
import { syncQueueBoard } from './queue/run.ts';
import { openRecurringTasks } from './queue/recurring.ts';
import { errMessage, log } from './log.ts';

const env = loadEnv();
const db = createDb(env.databaseUrl, env.dbSchema);
const monday = createMondayClient({ token: env.monday.token, apiVersion: env.monday.apiVersion });
const salesforce = createSalesforceClient(env.salesforce);
const gate = createWriteGate(env.syncMode, monday, salesforce);

// ── Config cache (reloaded at most once a minute) ──
const CONFIG_TTL_MS = 60_000;
let cached: { cfg: RuntimeConfig; at: number } | null = null;
let lastDrift: DriftResult = { findings: [], blockedColumns: [], deadMapRows: [] };

async function getConfig(): Promise<RuntimeConfig> {
  if (cached && Date.now() - cached.at < CONFIG_TTL_MS) return cached.cfg;
  const cfg = await loadRuntimeConfig(db, lastDrift);
  cached = { cfg, at: Date.now() };
  return cfg;
}

const deps: WorkerDeps = { db, gate, monday, salesforce, getConfig, integrationUserId: env.monday.integrationUserId, salesforceLoginUrl: env.salesforce.loginUrl };

// ── Background jobs ──
const jobs = { lastDrain: null as string | null, lastSweep: null as (SweepResult & { at: string }) | null, lastDrift: null as string | null };

let draining = false;
let drainAgain = false;
async function drain(): Promise<void> {
  if (draining) {
    drainAgain = true;
    return;
  }
  draining = true;
  try {
    do {
      drainAgain = false;
      await drainInbox(deps);
    } while (drainAgain);
    jobs.lastDrain = new Date().toISOString();
  } catch (e) {
    log.error('inbox drain failed', { error: errMessage(e) });
  } finally {
    draining = false;
  }
}

async function sweep(): Promise<SweepResult | undefined> {
  const result = await db.withLock('sf_sweep', () => runSweep({ db, salesforce }));
  if (result) {
    jobs.lastSweep = { ...result, at: new Date().toISOString() };
    await setEngineStatus(db, 'last_sweep', { ...jobs.lastSweep });
    log.info('sweep', { ...result });
    void drain();
    const cfg = await getConfig();
    if (cfg.settings.estimator_writeback === true) {
      const retried = await retryUnmappedEngineers({ db, gate, monday, salesforce, cfg, salesforceLoginUrl: env.salesforce.loginUrl });
      if (retried > 0) log.info('estimator mapping retry', { items: retried });
    }
  }
  return result;
}

async function refreshDrift(): Promise<void> {
  lastDrift = await runDriftCheck(db, monday, await loadRuntimeConfig(db));
  cached = null;
  jobs.lastDrift = new Date().toISOString();
  if (lastDrift.findings.length > 0) log.warn('config drift', { findings: lastDrift.findings.length, blocked: lastDrift.blockedColumns });
}

let queueBusy = false;
async function queuePush(): Promise<void> {
  if (queueBusy) return;
  queueBusy = true;
  try {
    const cfg = await getConfig();
    // Report tasks (open once per period) go out with the same push.
    const reports = cfg.settings.queue_push === true ? await openRecurringTasks(db, cfg.settings, new Date()) : 0;
    const r = await syncQueueBoard({ db, gate, monday, cfg, salesforceLoginUrl: env.salesforce.loginUrl });
    if (reports || r.created || r.updated || r.moved || r.failed) log.info('queue push', { reportsOpened: reports, ...r });
  } finally {
    queueBusy = false;
  }
}

function every(ms: number, name: string, fn: () => Promise<unknown>): NodeJS.Timeout {
  return setInterval(() => {
    fn().catch((e) => log.error(`${name} failed`, { error: errMessage(e) }));
  }, ms);
}

// ── HTTP ──
const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.use(ingressRouter({
  db,
  salesforceSecret: env.salesforce.webhookSecret,
  mondayPathSecret: env.monday.webhookPathSecret,
  onIngest: () => void drain(),
}));

function internalOnly(req: Request, res: Response, next: NextFunction) {
  if (!safeEqual(req.header('x-internal-secret') ?? '', env.internalSecret)) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  next();
}

app.get('/status', internalOnly, async (_req, res) => {
  res.json({
    mode: env.syncMode,
    schema: env.dbSchema,
    inbox: await inboxStats(db).catch(() => null),
    jobs,
    drift: { findings: lastDrift.findings.length, blockedColumns: lastDrift.blockedColumns },
  });
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
    res.json({ mode: env.syncMode, ...(await reconcileOpportunities(deps, [id])) });
  } catch (e) {
    log.error('manual reconcile failed', { id, error: errMessage(e) });
    res.status(502).json({ error: errMessage(e) });
  }
});

// Cutover step 2. Body: {"preview": true} reports counts and saves nothing.
app.post('/admin/backfill', internalOnly, async (req, res) => {
  const preview = req.body?.preview !== false;
  const reconcile = req.body?.reconcile !== false;
  try {
    const report = await db.withLock('backfill', async () => runBackfill({ db, monday, salesforce, cfg: await getConfig() }, { preview, reconcile }));
    if (!report) {
      res.status(409).json({ error: 'a backfill is already running' });
      return;
    }
    log.info('backfill', { preview, linked: report.linked, problems: report.counts.problems, queued: report.reconcilesQueued });
    if (report.reconcilesQueued > 0) void drain();
    res.json(report);
  } catch (e) {
    log.error('backfill failed', { error: errMessage(e) });
    res.status(502).json({ error: errMessage(e) });
  }
});

// Re-check every linked opportunity. {"resetDryRunBaseline": true} is dry-run only.
app.post('/admin/requeue-linked', internalOnly, async (req, res) => {
  const resetDryRunBaseline = req.body?.resetDryRunBaseline === true;
  if (resetDryRunBaseline && env.syncMode !== 'dry_run') {
    res.status(400).json({ error: 'resetDryRunBaseline is only allowed in dry run' });
    return;
  }
  try {
    const result = await requeueLinked(db, { resetDryRunBaseline });
    log.info('requeue-linked', result);
    void drain();
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: errMessage(e) });
  }
});

// Field-by-field "monday now vs Salesforce says" over every linked item (live, read-only).
app.get('/admin/diff-report', internalOnly, async (req, res) => {
  try {
    const report = await buildDiffReport({ db, monday, salesforce, cfg: await getConfig(), salesforceLoginUrl: env.salesforce.loginUrl });
    if (req.query.format === 'csv') {
      res.type('text/csv').send(reportCsv(report));
      return;
    }
    res.json(report);
  } catch (e) {
    log.error('diff report failed', { error: errMessage(e) });
    res.status(502).json({ error: errMessage(e) });
  }
});

// Estimator cleanup over every linked open deal. Body {"apply": true} writes; otherwise a preview.
app.post('/admin/estimator-first-pass', internalOnly, async (req, res) => {
  const apply = req.body?.apply === true;
  try {
    const cfg = await getConfig();
    const report = await db.withLock('estimator_first_pass', () =>
      runEstimatorFirstPass({ db, gate, monday, salesforce, cfg, salesforceLoginUrl: env.salesforce.loginUrl }, { apply }));
    if (!report) {
      res.status(409).json({ error: 'an estimator first pass is already running' });
      return;
    }
    log.info('estimator first pass', { apply, mode: env.syncMode, counts: report.counts, failed: report.failed.length });
    if (req.query.format === 'csv') {
      res.type('text/csv').send(firstPassCsv(report));
      return;
    }
    res.json({ ...report, rows: undefined });
  } catch (e) {
    log.error('estimator first pass failed', { error: errMessage(e) });
    res.status(502).json({ error: errMessage(e) });
  }
});

app.post('/admin/sweep', internalOnly, async (_req, res) => {
  try {
    const result = await sweep();
    res.json(result ?? { skipped: 'another sweep is running' });
  } catch (e) {
    res.status(502).json({ error: errMessage(e) });
  }
});

// ── Boot ──
const timers: NodeJS.Timeout[] = [];

async function main() {
  await refreshDrift();
  await setEngineStatus(db, 'boot', { mode: env.syncMode, schema: env.dbSchema, at: new Date().toISOString() });

  const server = app.listen(env.port, () => log.info('sync-engine listening', { port: env.port, mode: env.syncMode, schema: env.dbSchema }));

  // monday sends a challenge to the URL during registration, so register after listen().
  const cfg = await getConfig();
  const url = `${env.publicBaseUrl}/webhooks/monday/${env.monday.webhookPathSecret}`;
  for (const key of [...PRESALES_BOARD_KEYS, 'queue']) {
    const boardId = cfg.boards[key];
    if (!boardId) continue;
    ensurePresalesWebhooks(db, monday, boardId, url)
      .then((r) => log.info('monday webhooks', { board: key, ...r }))
      .catch((e) => log.error('monday webhook registration failed', { board: key, error: errMessage(e) }));
  }

  timers.push(every(2_000, 'inbox drain', drain));
  timers.push(every(60 * 60_000, 'sweep', sweep));
  timers.push(every(60 * 60_000, 'drift check', refreshDrift));
  timers.push(every(60_000, 'queue push', queuePush));
  setTimeout(() => void sweep().catch((e) => log.error('sweep failed', { error: errMessage(e) })), 60_000);

  const shutdown = (signal: string) => {
    log.info('shutting down', { signal });
    timers.forEach(clearInterval);
    server.close(() => void db.close().finally(() => process.exit(0)));
    setTimeout(() => process.exit(0), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  log.error('boot failed', { error: errMessage(e) });
  process.exit(1);
});
