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

/**
 * Final global safety cap on total stations returned by fetchDrinkingLive.
 * Raised from 1500 → 6000 now that per-state caps provide geographic balance
 * (6000 stations × ~250 bytes ≈ 1.5 MB JSON — acceptable for a baked snapshot).
 */
export const MAX_STATIONS = 6000;

/**
 * Maximum violating systems kept per state.
 * Prevents early-alphabet states (AL, AK, AZ…) from exhausting the global
 * cap before late-alphabet / western states are processed.
 *
 * 200 per state × 51 states = 10,200 potential max, well above MAX_STATIONS,
 * so the global cap still acts as a meaningful safety net.
 */
export const MAX_PER_STATE = 200;

/** Split an array into chunks of at most `n` elements. */
function chunk<T>(arr: T[], n: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += n) chunks.push(arr.slice(i, i + n));
  return chunks;
}

/**
 * Fetch all PWS for one state from the ECHO SDW API.
 * Returns WaterStation[] containing only violating systems, capped at MAX_PER_STATE.
 *
 * ## Pagination notes (verified 2026-06-12 — TX / CA investigation):
 * ECHO was rate-limited during investigation, preventing a live QueryRows vs
 * WaterSystems.length comparison for TX or CA. The get_qid endpoint accepts a
 * `responseset` param that controls how many rows are returned per page, and a
 * `pageno` param for subsequent pages. We implement full pagination here with
 * an early-stop once we've collected MAX_PER_STATE violating systems, so large
 * states never send unnecessary requests.
 *
 * If the ECHO response for a given page contains fewer rows than the requested
 * page size (or an empty WaterSystems array), we treat that as the final page.
 * This means we correctly handle both the "all rows in one response" case and
 * the paginated case without needing to know the total row count up front.
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

  // Step 2: get_qid with pagination — stop once we have MAX_PER_STATE violating systems.
  // PAGE_SIZE must be large enough to minimise round-trips for small states yet
  // not exceed ECHO's documented max (1000 rows per request).
  const PAGE_SIZE = 1000;
  const collected: WaterStation[] = [];
  let page = 1;

  while (collected.length < MAX_PER_STATE) {
    // pageno is 1-based; responseset controls rows per page.
    const qidRes = await fetch(
      `${base}/sdw_rest_services.get_qid?qid=${qid}&pageno=${page}&responseset=${PAGE_SIZE}`,
      { signal, headers: { Accept: 'application/json' } }
    );
    if (!qidRes.ok) break;
    const qidJson = await qidRes.json();
    const waterSystems: any[] = qidJson?.Results?.WaterSystems ?? [];

    if (waterSystems.length === 0) break; // no more data

    // Pre-filter to reduce parseEchoSystems workload (parser drops anyway)
    const relevant = waterSystems.filter(
      (w: any) => (Number(w.VioFlag) || 0) !== 0 || w.HealthFlag === 'Yes'
    );
    const parsed = parseEchoSystems(relevant);
    for (const st of parsed) {
      collected.push(st);
      if (collected.length >= MAX_PER_STATE) break;
    }

    // If the page returned fewer rows than PAGE_SIZE, it was the last page
    if (waterSystems.length < PAGE_SIZE) break;

    page++;
  }

  // Cap this state's contribution to MAX_PER_STATE
  return collected.slice(0, MAX_PER_STATE);
}

/**
 * Live national fan-out across EPA ECHO.
 *
 * Processes all 51 state/DC queries in chunks of 6 to avoid saturating ECHO
 * under full parallelism. Each state is capped at MAX_PER_STATE violating
 * systems to ensure geographic balance — early-alphabet states (AL, AK, AZ…)
 * can no longer crowd out western and late-alphabet states. Deduplicates by
 * station id and caps the final result at MAX_STATIONS.
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
      // Each state already capped at MAX_PER_STATE inside fetchEchoState
      for (const st of r.value) {
        if (!seen.has(st.id)) seen.set(st.id, st);
      }
    }
  }
  // Final global safety cap
  return Array.from(seen.values()).slice(0, MAX_STATIONS);
}
