// Lead Finder (admins only): open bids with likely AV scope near Instrata
// offices, from SAM.gov and the BuildingConnected Bid Board. Ported from the
// standalone LeadFinder app; data lives in the lf_* tables and the Python
// worker (leadfinder-worker/, Fly app instrata-leadfinder) does the fetching,
// document handling and triage. Tabs: ?tab=leads|run|offices|log|settings.

import { useCallback, useMemo, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { PageHeader } from '../components/ui';
import { LeadsTab } from '../components/leadfinder/LeadsTab';
import { LeadDrawer } from '../components/leadfinder/LeadDrawer';
import { RunTab } from '../components/leadfinder/RunTab';
import { OfficesTab } from '../components/leadfinder/OfficesTab';
import { RunLogTab } from '../components/leadfinder/RunLogTab';
import { SettingsTab } from '../components/leadfinder/SettingsTab';
import { Banner, Chip } from '../components/leadfinder/ui';
import { relTime } from '../components/leadfinder/format';
import { useOffices, useRuns, useSettings, useSources, workerOnline } from '../hooks/useLeadFinder';

const TABS = [
  ['leads', 'Leads'],
  ['run', 'Run'],
  ['offices', 'Offices'],
  ['log', 'Run log'],
  ['settings', 'Settings'],
] as const;
type Tab = (typeof TABS)[number][0];

export function LeadFinderPage() {
  const { isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some(([k]) => k === params.get('tab')) ? params.get('tab') : 'leads') as Tab;
  const openId = params.get('lead');
  const [leadsKey, setLeadsKey] = useState(0);
  const [softKey, setSoftKey] = useState(0);

  const { offices, reload: reloadOffices } = useOffices();
  const { sources, reload: reloadSources } = useSources();
  const { runs, loading: runsLoading, reload: reloadRuns } = useRuns();
  const settings = useSettings();

  const flash = useMemo(() => {
    const msg = params.get('msg');
    const err = params.get('err');
    return msg ? { tone: 'ok' as const, text: msg } : err ? { tone: 'error' as const, text: err } : null;
  }, [params]);

  const go = useCallback((next: Tab, extra: Record<string, string> = {}) => {
    setParams({ ...(next === 'leads' ? {} : { tab: next }), ...extra }, { replace: false });
  }, [setParams]);

  const openLead = useCallback((id: string) => {
    setParams((p) => { const n = new URLSearchParams(p); n.set('lead', id); return n; });
  }, [setParams]);
  const closeLead = useCallback(() => {
    setParams((p) => { const n = new URLSearchParams(p); n.delete('lead'); return n; });
  }, [setParams]);

  const refreshAll = useCallback(() => {
    void reloadSources();
    void reloadRuns();
    void settings.reload();
    setLeadsKey((k) => k + 1);
  }, [reloadSources, reloadRuns, settings]);

  if (!isAdmin) return <Navigate to="/" replace />;

  const worker = settings.worker;
  const online = workerOnline(worker);
  const lastRun = runs.find((r) => r.status === 'succeeded' || r.status === 'partial');

  return (
    <div className="px-8 pt-7 pb-10 max-w-[1440px]">
      <PageHeader
        eyebrow="Business development"
        title="Lead Finder"
        subtitle="Open bids with likely AV scope near Instrata offices, from SAM.gov and the BuildingConnected Bid Board."
        actions={
          <div className="flex items-center gap-2 text-xs text-fg-2 self-center">
            {lastRun && <span>Last run {relTime(lastRun.finished_at ?? lastRun.started_at)}</span>}
            {settings.loaded && (online
              ? <Chip tone="success">Worker online</Chip>
              : <Chip tone="danger">{worker ? 'Worker offline' : 'Worker not set up'}</Chip>)}
          </div>
        }
      />

      {settings.loaded && !worker && (
        <div className="mb-4">
          <Banner tone="warn">
            The Lead Finder worker hasn't reported in yet. Leads already in the database show below; runs, document
            downloads and triage start once the worker (Fly app <code className="font-mono">instrata-leadfinder</code>) is running.
          </Banner>
        </div>
      )}

      <div className="flex gap-1 mb-5 border-b border-border">
        {TABS.map(([k, label]) => (
          <button key={k} onClick={() => go(k)}
            className={`px-4 py-2.5 text-[14px] font-medium border-b-2 -mb-px ${tab === k ? 'border-orange text-navy' : 'border-transparent text-fg-2 hover:text-navy'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'leads' && <LeadsTab key={leadsKey} refreshKey={softKey} offices={offices} sources={sources} onOpen={openLead} />}
      {tab === 'run' && (
        <RunTab sources={sources} worker={worker} onFinished={refreshAll}
          onSeeNew={() => {
            try {
              sessionStorage.setItem('leadfinder.filters.v1', JSON.stringify({ changed: 'new_or_updated' }));
            } catch { /* ignore */ }
            setLeadsKey((k) => k + 1);
            go('leads');
          }} />
      )}
      {tab === 'offices' && (
        <OfficesTab offices={offices} defaultRadius={settings.defaultRadius}
          onChanged={() => { void reloadOffices(); setLeadsKey((k) => k + 1); }} />
      )}
      {tab === 'log' && <RunLogTab runs={runs} loading={runsLoading} />}
      {tab === 'settings' && (
        <SettingsTab sources={sources} defaultRadius={settings.defaultRadius} worker={worker} bc={settings.bc}
          flash={flash} onChanged={refreshAll} />
      )}

      <LeadDrawer id={openId} onClose={closeLead} worker={worker} onChanged={() => setSoftKey((k) => k + 1)} />
    </div>
  );
}
