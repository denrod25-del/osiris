'use client';

import { useMemo } from 'react';
import { motion } from 'framer-motion';
import { Droplets, X, MapPin, Wind, Beaker } from 'lucide-react';

interface WaterDossierProps {
  center: { lat: number; lng: number };
  data: any;
  onClose: () => void;
}

interface Station {
  id?: string;
  name?: string;
  lat: number;
  lng: number;
  status?: string;
  color?: string;
  reason?: string;
  params?: Record<string, number | string | undefined>;
  source?: string;
  url?: string;
  [k: string]: unknown;
}

/** Haversine great-circle distance in km. */
function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371; // mean Earth radius, km
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const lat1 = toRad(aLat);
  const lat2 = toRad(bLat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Returns the n nearest stations to center, each annotated with `distKm`. */
function nearest(center: { lat: number; lng: number }, arr: unknown, n: number): (Station & { distKm: number })[] {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  return (arr as Station[])
    .filter((s) => Number.isFinite(s?.lat) && Number.isFinite(s?.lng))
    .map((s) => ({ ...s, distKm: haversineKm(center.lat, center.lng, s.lat, s.lng) }))
    .sort((a, b) => a.distKm - b.distKm)
    .slice(0, n);
}

function fmtDist(km: number): string {
  const mi = km * 0.621371;
  if (km < 1) return `${(km * 1000).toFixed(0)} m`;
  return `${km.toFixed(1)} km · ${mi.toFixed(1)} mi`;
}

/** Pull the most relevant short metric line for a station. */
function metricLine(s: Station): string {
  if (s.reason) return String(s.reason);
  const p = s.params || {};
  const bits = Object.entries(p)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .slice(0, 3)
    .map(([k, v]) => `${k}: ${v}`);
  return bits.join(' · ') || '—';
}

function StationRow({ s }: { s: Station & { distKm: number } }) {
  const content = (
    <div className="flex items-start gap-2 py-1.5 px-2 rounded hover:bg-[var(--hover-accent)] transition-colors">
      <span
        className="w-2 h-2 rounded-full mt-1 shrink-0"
        style={{ background: s.color || '#607D8B', boxShadow: `0 0 6px ${s.color || '#607D8B'}` }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] font-mono text-[var(--text-primary)] truncate">{s.name || 'Unknown'}</span>
          <span className="text-[8px] font-mono text-[var(--gold-primary)] tabular-nums whitespace-nowrap">{fmtDist(s.distKm)}</span>
        </div>
        <div className="text-[8px] font-mono text-[var(--text-secondary)] truncate">{metricLine(s)}</div>
      </div>
    </div>
  );
  return s.url ? (
    <a href={s.url} target="_blank" rel="noopener noreferrer" className="block">{content}</a>
  ) : content;
}

function Section({
  title,
  icon: Icon,
  rows,
  layerKey,
}: {
  title: string;
  icon: typeof Droplets;
  rows: (Station & { distKm: number })[];
  layerKey: string;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 mb-1">
        <Icon className="w-3 h-3 text-[var(--cyan-primary)]" />
        <span className="hud-label">{title}</span>
        {rows.length > 0 && (
          <span className="text-[8px] font-mono text-[var(--text-muted)]">({rows.length})</span>
        )}
      </div>
      {rows.length > 0 ? (
        <div className="space-y-0.5">
          {rows.map((s, i) => (
            <StationRow key={s.id || `${layerKey}-${i}`} s={s} />
          ))}
        </div>
      ) : (
        <div className="text-[8px] font-mono text-[var(--text-muted)]/70 italic px-2 py-1.5">
          layer not loaded — toggle &ldquo;{layerKey}&rdquo; on
        </div>
      )}
    </div>
  );
}

export default function WaterDossier({ center, data, onClose }: WaterDossierProps) {
  const ambient = useMemo(() => nearest(center, data?.water_ambient, 5), [center, data?.water_ambient]);
  const drinking = useMemo(() => nearest(center, data?.water_drinking, 5), [center, data?.water_drinking]);
  const air = useMemo(() => nearest(center, data?.air_quality, 3), [center, data?.air_quality]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className="absolute top-16 md:top-20 left-2 right-2 md:left-1/2 md:right-auto md:-translate-x-1/2 z-[300] md:w-[420px] max-h-[70vh] overflow-y-auto styled-scrollbar pointer-events-auto"
    >
      <div className="glass-panel p-5 osiris-glow">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Droplets className="w-3.5 h-3.5 text-[var(--cyan-primary)]" />
            <h2 className="text-sm font-mono font-bold text-[var(--gold-primary)] tracking-wider">MY AREA</h2>
          </div>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text-primary)] text-xs" aria-label="Close">✕</button>
        </div>

        <div className="flex items-center gap-1.5 mb-4 text-[9px] font-mono text-[var(--text-secondary)]">
          <MapPin className="w-3 h-3 text-[var(--gold-primary)]" />
          <span className="tabular-nums text-[var(--gold-primary)]">
            {center.lat.toFixed(4)}, {center.lng.toFixed(4)}
          </span>
          <span className="text-[var(--text-muted)]/60">· nearest sensors</span>
        </div>

        <div className="space-y-4">
          <Section title="AMBIENT WATER" icon={Droplets} rows={ambient} layerKey="water_ambient" />
          <Section title="DRINKING WATER" icon={Beaker} rows={drinking} layerKey="water_drinking" />
          <Section title="AIR QUALITY" icon={Wind} rows={air} layerKey="air_quality" />
        </div>
      </div>
    </motion.div>
  );
}
