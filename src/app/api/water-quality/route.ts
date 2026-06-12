import { NextResponse } from 'next/server';
import { parseUsgsIv, parseEchoSystems, WaterStation } from '@/lib/water-sources';

export const dynamic = 'force-dynamic';

const USGS_PARAMS = '00010,00300,00400,00095,63680,99133';
// Top-level 2-digit hydrologic regions covering the entire US (01–21).
const HUCS = ['01','02','03','04','05','06','07','08','09','10','11','12','13','14','15','16','17','18','19','20','21'];
const MAX_STATIONS = 1500;
const TTL_MS: Record<string, number> = { ambient: 10 * 60 * 1000, drinking: 12 * 60 * 60 * 1000 };

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

// Phase 2 (Task 10) replaces this stub with a real EPA ECHO fetch.
async function fetchDrinking(): Promise<WaterStation[]> {
  return [];
}

export async function GET(request: Request) {
  const source = new URL(request.url).searchParams.get('source') === 'drinking' ? 'drinking' : 'ambient';
  try {
    const now = Date.now();
    const cached = cache[source];
    if (cached && now - cached.ts < TTL_MS[source]) {
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
