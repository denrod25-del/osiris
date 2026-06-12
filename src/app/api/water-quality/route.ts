import { NextResponse } from 'next/server';
import { parseUsgsIv, WaterStation } from '@/lib/water-sources';
import { fetchDrinkingLive, MAX_STATIONS } from '@/lib/echo-drinking';
import DRINKING_SNAPSHOT from '@/lib/data/drinking-snapshot.json';

export const dynamic = 'force-dynamic';

const USGS_PARAMS = '00010,00300,00400,00095,63680,99133';
// Top-level 2-digit hydrologic regions covering the entire US (01–21).
const HUCS = ['01','02','03','04','05','06','07','08','09','10','11','12','13','14','15','16','17','18','19','20','21'];
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

// Default drinking-water source: a pre-generated snapshot of US EPA violations,
// baked into the build so it serves instantly within serverless time limits.
// Refresh it with: node scripts/refresh-drinking-snapshot.mjs (see that file).
async function fetchDrinking(): Promise<WaterStation[]> {
  const snapshot = DRINKING_SNAPSHOT as WaterStation[];
  if (Array.isArray(snapshot) && snapshot.length) return snapshot.slice(0, MAX_STATIONS);
  return fetchDrinkingLive();
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const source = params.get('source') === 'drinking' ? 'drinking' : 'ambient';
  // ?live=1 forces the live national ECHO fan-out (for self-host or snapshot regen),
  // bypassing both the snapshot and the cache. Slow — not for serverless.
  const live = params.get('live') === '1';
  try {
    const now = Date.now();
    const cached = cache[source];
    const effectiveTTL = cached?.stations.length === 0 ? EMPTY_TTL_MS : TTL_MS[source];
    if (!live && cached && now - cached.ts < effectiveTTL) {
      return NextResponse.json({
        source,
        total: cached.stations.length,
        timestamp: new Date(cached.ts).toISOString(),
        stations: cached.stations,
        cached: true,
      });
    }
    const stations = source === 'drinking'
      ? (live ? await fetchDrinkingLive() : await fetchDrinking())
      : await fetchAmbient();
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
