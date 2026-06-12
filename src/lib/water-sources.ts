import { assessWater, WaterParams } from './water-quality';
import COUNTY_CENTROIDS from './data/county-centroids.json';

export interface WaterStation {
  id: string;
  source: 'USGS' | 'EPA' | 'OpenAQ';
  name: string;
  lat: number;
  lng: number;
  // 'Good' | 'Moderate' | 'Poor' | 'Unknown' for USGS/EPA water stations;
  // OpenAQ AQI level label (e.g. 'Unhealthy') for air-quality stations.
  status: string;
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

interface Acc { name: string; lat: number; lng: number; params: WaterParams; updated: string | null; }

export function parseUsgsIv(json: any): WaterStation[] {
  const series = json?.value?.timeSeries ?? [];
  if (!Array.isArray(series)) return [];

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
      rec = { name: si?.siteName ?? siteId, lat, lng, params: {}, updated: null };
      bySite.set(siteId, rec);
    }
    rec.params[key] = num;
    const dt: string | null = last?.dateTime ?? null;
    if (dt && (!rec.updated || new Date(dt).getTime() > new Date(rec.updated).getTime())) rec.updated = dt;
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
      params: { ...rec.params },
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

// Parse a CSV string into an array of row objects (handles quoted fields with commas).
export function csvToObjects(csv: string): Record<string, string>[] {
  const lines = csv.split('\n');
  if (lines.length < 2) return [];
  const headers = parseCsvRow(lines[0]);
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = parseCsvRow(line);
    const obj: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = cols[j] ?? '';
    }
    rows.push(obj);
  }
  return rows;
}

function parseCsvRow(row: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') { current += '"'; i++; }
      else { inQuotes = !inQuotes; }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// Deterministic jitter derived from PWSId char codes (max ±0.05°).
function jitter(pwsId: string, axis: 0 | 1): number {
  let hash = 0;
  for (let i = 0; i < pwsId.length; i++) {
    hash = (hash * 31 + pwsId.charCodeAt(i)) >>> 0;
  }
  // mix in axis so lat/lng differ
  hash = (hash ^ (axis * 0x9e3779b9)) >>> 0;
  // map to [-0.05, 0.05]
  return ((hash % 1000) / 1000 - 0.5) * 0.1;
}

// Phase 2 — Task 9: parse EPA ECHO SDW download rows into shared WaterStation shape.
// Accepts an array of row objects (CSV rows parsed into objects by csvToObjects).
export function parseEchoSystems(rows: any): WaterStation[] {
  if (!Array.isArray(rows)) return [];

  const centroids = COUNTY_CENTROIDS as Record<string, [number, number]>;
  const stations: WaterStation[] = [];

  for (const row of rows) {
    const vioFlag = Number(row.VioFlag) || 0;
    const healthFlag = row.HealthFlag === 'Yes';

    // Drop rows with no violations (neither VioFlag nor HealthFlag)
    if (!vioFlag && !healthFlag) continue;

    // Resolve county centroid from first FIPS code
    const fipsRaw: string = row.FIPSCodes ?? '';
    const fips = fipsRaw.split(',')[0].trim().padStart(5, '0');
    if (!fips || fips === '00000') continue;
    const centroid = centroids[fips];
    if (!centroid) continue;

    const pwsId: string = row.PWSId ?? '';
    const lat = centroid[0] + jitter(pwsId, 0);
    const lng = centroid[1] + jitter(pwsId, 1);

    const status = healthFlag ? 'Poor' : 'Moderate';
    const color = healthFlag ? '#FF1744' : '#FFD700';
    const mrFlag = row.MrFlag === 'Yes';
    const reason = row.ViolationCategories
      || (healthFlag ? 'Health-based violation' : mrFlag ? 'Monitoring/Reporting violation' : 'Violation');
    const population = Number(row.PopulationServedCount) || 0;
    const dfrUrl: string = row.DfrUrl || `https://echo.epa.gov/detailed-facility-report?fid=${pwsId}`;

    stations.push({
      id: `epa-${pwsId}`,
      source: 'EPA',
      name: row.PWSName ?? pwsId,
      lat,
      lng,
      status,
      color,
      reason,
      params: {
        populationServed: population,
        violationCategories: row.ViolationCategories ?? '',
        healthFlag: healthFlag ? 'Yes' : 'No',
        mrFlag: mrFlag ? 'Yes' : 'No',
      },
      lastUpdated: null,
      url: dfrUrl,
    });
  }

  return stations;
}
