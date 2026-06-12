import { assessWater, WaterParams, WaterStatus } from './water-quality';

export interface WaterStation {
  id: string;
  source: 'USGS' | 'EPA' | 'OpenAQ';
  name: string;
  lat: number;
  lng: number;
  status: WaterStatus | string;
  color: string;
  reason: string;
  params: Record<string, number | string | undefined>;
  lastUpdated: string | null;
  url: string;
}

// USGS parameter code → our WaterParams key
const USGS_PARAM_MAP: Record<string, keyof WaterParams> = {
  '00010': 'temp',
  '00300': 'do',
  '00400': 'ph',
  '00095': 'conductance',
  '63680': 'turbidity',
  '99133': 'nitrate',
};

export function parseUsgsIv(json: any): WaterStation[] {
  const series = json?.value?.timeSeries ?? [];
  if (!Array.isArray(series)) return [];

  interface Acc { name: string; lat: number; lng: number; params: WaterParams; raw: Record<string, number>; updated: string | null; }
  const bySite = new Map<string, Acc>();

  for (const ts of series) {
    const code = ts?.variable?.variableCode?.[0]?.value as string | undefined;
    const key = code ? USGS_PARAM_MAP[code] : undefined;
    if (!key) continue;

    const si = ts?.sourceInfo;
    const siteId = si?.siteCode?.[0]?.value;
    const lat = si?.geoLocation?.geogLocation?.latitude;
    const lng = si?.geoLocation?.geogLocation?.longitude;
    if (!siteId || !Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const valuesArr = ts?.values?.[0]?.value ?? [];
    const last = valuesArr[valuesArr.length - 1];
    const num = last ? parseFloat(last.value) : NaN;
    if (!Number.isFinite(num) || num <= -999999) continue; // USGS no-data sentinel

    let rec = bySite.get(siteId);
    if (!rec) {
      rec = { name: si?.siteName ?? siteId, lat, lng, params: {}, raw: {}, updated: null };
      bySite.set(siteId, rec);
    }
    rec.params[key] = num;
    rec.raw[key] = num;
    const dt: string | null = last?.dateTime ?? null;
    if (dt && (!rec.updated || dt > rec.updated)) rec.updated = dt;
  }

  const stations: WaterStation[] = [];
  for (const [siteId, rec] of bySite) {
    const a = assessWater(rec.params);
    stations.push({
      id: `usgs-${siteId}`,
      source: 'USGS',
      name: rec.name,
      lat: rec.lat,
      lng: rec.lng,
      status: a.status,
      color: a.color,
      reason: a.reason,
      params: { ...rec.raw },
      lastUpdated: rec.updated,
      url: `https://waterdata.usgs.gov/monitoring-location/${siteId}/`,
    });
  }
  return stations;
}

// Maps the existing /api/air-quality response (OpenAQ) into the shared shape.
export function normalizeAirStations(airStations: any[]): WaterStation[] {
  if (!Array.isArray(airStations)) return [];
  return airStations
    .filter((s: any) => Number.isFinite(s?.lat) && Number.isFinite(s?.lng))
    .map((s: any) => ({
      id: `aq-${s.id ?? s.name}`,
      source: 'OpenAQ' as const,
      name: s.name ?? 'Unknown',
      lat: s.lat,
      lng: s.lng,
      status: s.level ?? 'Unknown',
      color: s.color ?? '#607D8B',
      reason: Number.isFinite(s.pm25) ? `PM2.5 ${s.pm25} ${s.unit ?? 'µg/m³'}` : 'No reading',
      params: { pm25: s.pm25, unit: s.unit, city: s.city, country: s.country },
      lastUpdated: s.lastUpdated ?? null,
      url: 'https://openaq.org/',
    }));
}

// Phase 2 fills this in (Task 9). Stub keeps the route's source switch total.
export function parseEchoSystems(_json: any): WaterStation[] {
  return [];
}
