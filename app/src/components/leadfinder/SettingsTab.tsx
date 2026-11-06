// Settings: default radius, SAM.gov budget, enabled sources, the worker's
// health, and the BuildingConnected (Bid Board Pro) connection.

import { useEffect, useState, type ReactNode } from 'react';
import { Link2, Unlink, Server, Save } from 'lucide-react';
import { Card } from '../ui';
import type { BcStatus, Source, WorkerStatus } from './types';
import { SOURCE_LABEL } from './types';
import { fmtBytes, fmtDateTime, relTime } from './format';
import { Banner, Chip, Spinner } from './ui';
import {
  queueJob, saveSetting, startBuildingConnectedConnect, updateSource, waitForJob, workerOnline,
} from '../../hooks/useLeadFinder';

export function SettingsTab({ sources, defaultRadius, worker, bc, flash, onChanged }: {
  sources: Source[];
  defaultRadius: number;
  worker: WorkerStatus | null;
  bc: BcStatus | null;
  flash: { tone: 'ok' | 'error'; text: string } | null;
  onChanged: () => void;
}) {
  const [radius, setRadius] = useState(String(defaultRadius));
  const sam = sources.find((s) => s.id === 'sam_gov');
  const [budget, setBudget] = useState(sam?.daily_call_budget != null ? String(sam.daily_call_budget) : '');
  const [enabled, setEnabled] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<'save' | 'connect' | 'disconnect' | null>(null);
  const [msg, setMsg] = useState(flash);

  useEffect(() => setRadius(String(defaultRadius)), [defaultRadius]);
  useEffect(() => setBudget(sam?.daily_call_budget != null ? String(sam.daily_call_budget) : ''), [sam?.daily_call_budget]);
  useEffect(() => setEnabled(Object.fromEntries(sources.map((s) => [s.id, s.enabled]))), [sources]);
  useEffect(() => setMsg(flash), [flash]);

  const save = async () => {
    setMsg(null);
    const r = Number(radius);
    if (!Number.isInteger(r) || r < 5 || r > 500) { setMsg({ tone: 'error', text: 'Default radius must be 5–500 miles.' }); return; }
    const b = budget.trim() === '' ? null : Number(budget);
    if (b != null && (!Number.isInteger(b) || b < 0)) { setMsg({ tone: 'error', text: "Budget must be a whole number (or blank for no limit)." }); return; }
    setBusy('save');
    try {
      await saveSetting('default_radius_miles', r);
      for (const s of sources) {
        const patch: { enabled?: boolean; daily_call_budget?: number | null } = {};
        if (enabled[s.id] !== s.enabled) patch.enabled = enabled[s.id];
        if (s.id === 'sam_gov' && b !== s.daily_call_budget) patch.daily_call_budget = b;
        if (Object.keys(patch).length) await updateSource(s.id, patch);
      }
      setMsg({ tone: 'ok', text: 'Settings saved.' });
      onChanged();
    } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const connect = async () => {
    if (!worker?.public_url) return;
    setBusy('connect');
    setMsg(null);
    try { await startBuildingConnectedConnect(worker.public_url); } catch (e) {
      setMsg({ tone: 'error', text: (e as Error).message });
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!confirm('Disconnect BuildingConnected? Bid Board runs stop until someone connects again.')) return;
    setBusy('disconnect');
    setMsg(null);
    try {
      const j = await queueJob('bc_disconnect');
      const done = await waitForJob(j.id, 60_000);
      setMsg(done.status === 'failed' ? { tone: 'error', text: done.error || 'Not disconnected.' } : { tone: 'ok', text: done.result?.message ?? 'Disconnected.' });
      onChanged();
    } catch (e) { setMsg({ tone: 'error', text: (e as Error).message }); } finally { setBusy(null); }
  };

  const online = workerOnline(worker);

  return (
    <div className="max-w-[1100px] space-y-5">
      {msg && <Banner tone={msg.tone} onClose={() => setMsg(null)}>{msg.text}</Banner>}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-start">
        <Card title="General">
          <label className="block mb-4">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-3 mb-1">Default radius for new offices (mi)</span>
            <input type="number" min={5} max={500} className="input" style={{ maxWidth: 160 }} value={radius} onChange={(e) => setRadius(e.target.value)} />
            <span className="block text-xs text-fg-3 mt-1">Existing offices keep their own radius; edit those on the Offices tab.</span>
          </label>
          <label className="block mb-4">
            <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-3 mb-1">SAM.gov daily call budget</span>
            <input type="number" min={0} className="input" style={{ maxWidth: 160 }} value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="no limit" />
            <span className="block text-xs text-fg-3 mt-1">About 2 calls cover a day of notices; the budget is shared by every run that day.</span>
          </label>
          <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-fg-3 mb-2">Enabled sources</div>
          <div className="space-y-2 mb-2">
            {sources.map((s) => (
              <label key={s.id} className="flex items-center gap-2.5 text-[13px] cursor-pointer">
                <input type="checkbox" className="accent-navy" checked={!!enabled[s.id]} onChange={(e) => setEnabled({ ...enabled, [s.id]: e.target.checked })} />
                <span className="font-semibold text-fg">{SOURCE_LABEL[s.id] ?? s.name}</span>
                <span className="text-fg-3 text-xs">({s.kind})</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-fg-3 mt-2 mb-0">
            Bonfire: every bonfirehub.com portal serves robots.txt <code className="font-mono">Disallow: /</code>, so enabling it only logs per-agency errors (DECISIONS D-12).
          </p>
          <div className="mt-5 pt-4 border-t border-border-soft">
            <button className="btn-primary" onClick={() => void save()} disabled={busy === 'save'}>
              {busy === 'save' ? <Spinner size={14} /> : <Save size={14} />} Save settings
            </button>
          </div>
        </Card>

        <div className="space-y-5">
          <Card title="BuildingConnected (Bid Board Pro)">
            {!worker ? (
              <p className="text-[13px] text-fg-3 m-0">Waiting for the worker to report in.</p>
            ) : !worker.aps_configured ? (
              <p className="text-[13px] text-fg-2 m-0"><Chip tone="danger">Not configured</Chip> Set <code className="font-mono">APS_CLIENT_ID</code> and <code className="font-mono">APS_CLIENT_SECRET</code> on the worker.</p>
            ) : !bc ? (
              <>
                <p className="text-[13px] text-fg-2 mt-0"><Chip tone="warn">Not connected</Chip> Someone with a Bid Board Pro seat clicks Connect and signs in on autodesk.com. Their password goes to Autodesk, never to Project Tools.</p>
                <button className="btn-orange" onClick={() => void connect()} disabled={busy === 'connect' || !online}>
                  {busy === 'connect' ? <Spinner size={14} /> : <Link2 size={14} />} Connect BuildingConnected
                </button>
              </>
            ) : (
              <>
                <p className="text-[13px] text-fg-2 mt-0">
                  <Chip tone="success">Connected</Chip>{bc.connected_as && <> as <strong className="text-fg">{bc.connected_as}</strong></>}
                  {bc.bid_board_access === false && <span className="ml-1.5"><Chip tone="danger">No Bid Board access (403)</Chip></span>}
                </p>
                <p className="text-xs text-fg-3">
                  Connected {fmtDateTime(bc.connected_at)} · token refreshed {fmtDateTime(bc.refreshed_at)} · scope <code className="font-mono">{bc.scope}</code> (read-only).
                  Autodesk expires the authorization after about two weeks without use; the daily run keeps it alive.
                </p>
                <div className="flex gap-2.5">
                  <button className="btn-secondary" onClick={() => void connect()} disabled={!!busy || !online}><Link2 size={14} /> Reconnect</button>
                  <button className="btn-secondary" onClick={() => void disconnect()} disabled={!!busy}>
                    {busy === 'disconnect' ? <Spinner size={14} /> : <Unlink size={14} />} Disconnect
                  </button>
                </div>
              </>
            )}
            {worker?.aps_callback && (
              <p className="text-xs text-fg-3 mt-4 mb-0">Callback URL registered on the APS app must be exactly <code className="font-mono break-all">{worker.aps_callback}</code>.</p>
            )}
          </Card>

          <Card title={<span className="flex items-center gap-2"><Server size={15} /> Worker</span>}>
            {worker ? (
              <div className="space-y-1.5 text-[13px]">
                <Row label="Status">{online ? <Chip tone="success">Online</Chip> : <Chip tone="danger">Offline</Chip>} <span className="text-xs text-fg-3">last check-in {relTime(worker.heartbeat_at)}</span></Row>
                <Row label="SAM.gov API key">{worker.sam_key ? <Chip tone="success">Set</Chip> : <Chip tone="danger">Missing</Chip>}</Row>
                {worker.documents_enabled === false ? (
                  <Row label="Documents & triage"><Chip>Off</Chip> <span className="text-xs text-fg-3">until the worker moves to the company server</span></Row>
                ) : (
                  <>
                    <Row label="Triage (Claude API)">{worker.triage_configured ? <Chip tone="success">Ready</Chip> : <Chip tone="warn">Not set up</Chip>} <span className="text-xs text-fg-3">cap ${worker.triage_budget_usd} per run</span></Row>
                    <Row label="Documents disk">{worker.disk ? `${fmtBytes(worker.disk.free_bytes)} free of ${fmtBytes(worker.disk.total_bytes)}` : '—'}</Row>
                  </>
                )}
                <Row label="Sign-in check">{worker.auth_configured ? <Chip tone="success">Ready</Chip> : <Chip tone="danger">SUPABASE_URL / SUPABASE_ANON_KEY missing</Chip>}</Row>
                <Row label="Daily run">{worker.schedule_hour_et >= 0 ? `${worker.schedule_hour_et}:00 Eastern` : 'Off'}</Row>
                <Row label="Scoring config"><code className="font-mono text-xs">{worker.scorer_version ?? '—'}</code></Row>
              </div>
            ) : (
              <p className="text-[13px] text-fg-2 m-0">The worker hasn't reported in yet. It runs as the Fly app <code className="font-mono">instrata-leadfinder</code>.</p>
            )}
            <p className="text-xs text-fg-3 mt-3 mb-0">Scoring rules live in <code className="font-mono">leadfinder-worker/config/scoring.yaml</code>; a change ships with the next worker deploy.</p>
          </Card>
        </div>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[150px_1fr] items-center gap-3">
      <span className="text-fg-3">{label}</span>
      <span className="flex items-center gap-2">{children}</span>
    </div>
  );
}
