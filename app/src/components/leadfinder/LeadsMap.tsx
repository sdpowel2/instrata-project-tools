// Map view of the current Leads results: office radius circles and one pin
// per located lead, colored by lane. Leaflet + OpenStreetMap tiles.

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { LeadRow, Office } from './types';
import { LANE_COLOR, LANE_LABEL } from './types';
import { fmtDateTime } from './format';

const NAVY = '#22326E';
const ORANGE = '#F68D2E';

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function LeadsMap({ rows, offices, selectedOfficeId, onOpen }: {
  rows: LeadRow[];
  offices: Office[];
  selectedOfficeId: string;
  onOpen: (id: string) => void;
}) {
  const el = useRef<HTMLDivElement>(null);
  const map = useRef<L.Map | null>(null);
  const layer = useRef<L.LayerGroup | null>(null);
  const openRef = useRef(onOpen);
  useEffect(() => { openRef.current = onOpen; }, [onOpen]);

  useEffect(() => {
    if (!el.current || map.current) return;
    const m = L.map(el.current, { scrollWheelZoom: true, zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18, attribution: '&copy; OpenStreetMap contributors',
    }).addTo(m);
    layer.current = L.layerGroup().addTo(m);
    map.current = m;
    m.setView([37.5, -88], 5);
    const onClick = (e: Event) => {
      const t = (e.target as HTMLElement).closest('[data-lead]');
      if (t) { e.preventDefault(); openRef.current(t.getAttribute('data-lead')!); }
    };
    el.current.addEventListener('click', onClick);
    const node = el.current;
    return () => { node.removeEventListener('click', onClick); m.remove(); map.current = null; };
  }, []);

  useEffect(() => {
    const m = map.current;
    const g = layer.current;
    if (!m || !g) return;
    g.clearLayers();
    const bounds: L.LatLngExpression[] = [];
    for (const o of offices) {
      if (!o.active || o.lat == null || o.lon == null) continue;
      const selected = o.id === selectedOfficeId;
      L.circle([o.lat, o.lon], {
        radius: o.radius_miles * 1609.34, color: NAVY, weight: selected ? 2.5 : 1,
        fillColor: NAVY, fillOpacity: selected ? 0.08 : 0.03,
      }).addTo(g);
      L.circleMarker([o.lat, o.lon], { radius: 6, color: '#fff', weight: 2, fillColor: ORANGE, fillOpacity: 1 })
        .bindPopup(`<b>${esc(o.name)}</b><br>${o.radius_miles} mi radius`)
        .addTo(g);
      bounds.push([o.lat, o.lon]);
    }
    for (const r of rows) {
      if (r.lat == null || r.lon == null) continue;
      L.circleMarker([r.lat, r.lon], {
        radius: 7, color: '#fff', weight: 1.5, fillColor: LANE_COLOR[r.lane], fillOpacity: 0.9,
      }).bindPopup(
        `<div style="font-family:var(--font-sans);font-size:12px;line-height:1.45;max-width:260px">` +
        `<div style="font-weight:700;color:${NAVY};margin-bottom:2px">${esc(r.title)}</div>` +
        `<div>${esc(r.agency_name || '')}</div>` +
        `<div>${esc(LANE_LABEL[r.lane])} · score ${r.score} · due ${esc(fmtDateTime(r.response_due_at))}</div>` +
        (r.nearest_office ? `<div>Nearest: ${esc(r.nearest_office)} (${r.nearest_distance?.toFixed(1)} mi)</div>` : '') +
        (r.approximate ? `<div style="color:#A16207">Approximate location</div>` : '') +
        `<div style="margin-top:4px"><a href="#" data-lead="${esc(r.id)}" style="color:${NAVY};font-weight:600">Details</a>` +
        (r.url ? ` · <a href="${esc(r.url)}" target="_blank" rel="noopener">Open listing</a>` : '') +
        `</div></div>`,
      ).addTo(g);
      bounds.push([r.lat, r.lon]);
    }
    if (bounds.length) m.fitBounds(L.latLngBounds(bounds), { padding: [24, 24], maxZoom: 9 });
  }, [rows, offices, selectedOfficeId]);

  return <div ref={el} className="h-[620px] w-full rounded-xl border border-border shadow-sm z-0" />;
}
