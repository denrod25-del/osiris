import { NextResponse } from 'next/server';
import { parseUsgsIv, parseEchoSystems, WaterStation } from '@/lib/water-sources';

// All US states + DC abbreviations for ECHO fan-out
const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
];

export const dynamic = 'force-dynamic';

const USGS_PARAMS = '00010,00300,00400,00095,63680,99133';
// Top-level 2-digit hydrologic regions covering the entire US (01–21).
const HUCS = ['01','02','03','04','05','06','07','08','09','10','11','12','13','14','15','16','17','18','19','20','21'];
const MAX_STATIONS = 1500;
const TTL_MS: Record<string, number> = { ambient: 10 * 60 * 1000, drinking: 12 * 60 * 60 * 1000 };
const EMPTY_TTL_MS = 5 * 60 * 1000; // short TTL for empty results — avoids poisoning the long drinking/ambient TTL

const cache: Record<string, { ts: number; stations: WaterStation[] }> = {};

async function fetchAmbient(): Promise<WaterStation[]> {
  const results = await Promise.allSettled(
    HUCS.map(huc =>
      fetch(
        `https://waterservices.usgs.gov/nwis/iv/?format=json&huc=${huc}&parameterCd=${USGS_PARAMS}&siteStatus=active`,
        { signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } }
      ).then(r => (r.ok ? r.json() : null))
    )
  );
  const seen = new Map<string, WaterStation>();
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    for (const st of parseUsgsIv(r.value)) {
      if (!seen.has(st.id)) seen.set(st.id, st);
    }
  }
  return Array.from(seen.values()).slice(0, MAX_STATIONS);
}

// Fetch all PWS for one state from ECHO SDW API; returns WaterStation[] (violating only).
async function fetchEchoState(state: string): Promise<WaterStation[]> {
  const base = 'https://echodata.epa.gov/echo';
  // 30s budget covers: get_systems round-trip + multi-MB get_qid body download under 51-way contention
  const signal = AbortSignal.timeout(30000);

  // Step 1: get_systems → QueryID
  const sysRes = await fetch(
    `${base}/sdw_rest_services.get_systems?output=JSON&p_st=${state}`,
    { signal, headers: { Accept: 'application/json' } }
  );
  if (!sysRes.ok) return [];
  const sysJson = await sysRes.json();
  const qid: string | undefined = sysJson?.Results?.QueryID;
  if (!qid) return [];

  // Step 2: get_qid → full WaterSystems JSON array
  const qidRes = await fetch(
    `${base}/sdw_rest_services.get_qid?qid=${qid}`,
    { signal, headers: { Accept: 'application/json' } }
  );
  if (!qidRes.ok) return [];
  const qidJson = await qidRes.json();
  const waterSystems: any[] = qidJson?.Results?.WaterSystems ?? [];

  // Pre-filter to reduce parseEchoSystems workload (parser drops anyway)
  const relevant = waterSystems.filter(
    (w: any) => (Number(w.VioFlag) || 0) !== 0 || w.HealthFlag === 'Yes'
  );

  return parseEchoSystems(relevant);
}

async function fetchDrinking(): Promise<WaterStation[]> {
  const results = await Promise.allSettled(
    US_STATES.map(state => fetchEchoState(state))
  );
  const seen = new Map<string, WaterStation>();
  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    for (const st of r.value) {
      if (!seen.has(st.id)) seen.set(st.id, st);
    }
  }
  return Array.from(seen.values()).slice(0, MAX_STATIONS);
}

export async function GET(request: Request) {
  const source = new URL(request.url).searchParams.get('source') === 'drinking' ? 'drinking' : 'ambient';
  try {
    const now = Date.now();
    const cached = cache[source];
    const effectiveTTL = cached?.stations.length === 0 ? EMPTY_TTL_MS : TTL_MS[source];
    if (cached && now - cached.ts < effectiveTTL) {
      return NextResponse.json({
        source,
        total: cached.stations.length,
        timestamp: new Date(cached.ts).toISOString(),
        stations: cached.stations,
        cached: true,
      });
    }
    const stations = source === 'drinking' ? await fetchDrinking() : await fetchAmbient();
    cache[source] = { ts: now, stations };
    return NextResponse.json({
      source,
      total: stations.length,
      timestamp: new Date(now).toISOString(),
      stations,
    });
  } catch (error) {
    console.error('Water Quality API error:', error);
    return NextResponse.json({ source, stations: [], error: 'Failed to fetch water quality data' }, { status: 500 });
  }
}
