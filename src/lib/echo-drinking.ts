/**
 * Shared EPA ECHO drinking-water fan-out logic.
 *
 * Extracted from route.ts so it can be imported both by the API route (for
 * ?live=1 re-generation) and by the standalone refresh script
 * (scripts/refresh-drinking-snapshot.ts) without needing a running dev server.
 */

import { parseEchoSystems, WaterStation } from './water-sources';

// All US states + DC abbreviations for ECHO fan-out
export const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
];

export const MAX_STATIONS = 1500;

/** Split an array into chunks of at most `n` elements. */
function chunk<T>(arr: T[], n: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += n) chunks.push(arr.slice(i, i + n));
  return chunks;
}

/**
 * Fetch all PWS for one state from the ECHO SDW API.
 * Returns WaterStation[] containing only violating systems.
 */
export async function fetchEchoState(state: string): Promise<WaterStation[]> {
  const base = 'https://echodata.epa.gov/echo';
  // 60s budget: get_systems + multi-MB get_qid download; raised from 30s to
  // match chunked (6-wide) concurrency
  const signal = AbortSignal.timeout(60000);

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

/**
 * Live national fan-out across EPA ECHO.
 *
 * Processes all 51 state/DC queries in chunks of 6 to avoid saturating ECHO
 * under full parallelism. Deduplicates by station id and caps at MAX_STATIONS.
 *
 * Warning: this takes several minutes on a cold ECHO. It exceeds serverless
 * function time limits — use only for self-host or snapshot regeneration.
 */
export async function fetchDrinkingLive(): Promise<WaterStation[]> {
  const seen = new Map<string, WaterStation>();
  for (const batch of chunk(US_STATES, 6)) {
    const results = await Promise.allSettled(batch.map(state => fetchEchoState(state)));
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      for (const st of r.value) {
        if (!seen.has(st.id)) seen.set(st.id, st);
      }
    }
  }
  return Array.from(seen.values()).slice(0, MAX_STATIONS);
}
