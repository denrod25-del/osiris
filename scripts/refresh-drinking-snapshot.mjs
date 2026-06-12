// Regenerates src/lib/data/drinking-snapshot.json from live EPA ECHO data.
//
// EPA's per-state fan-out takes minutes, which exceeds serverless function
// time limits — so the /api/water-quality?source=drinking route serves this
// pre-generated snapshot instead. Re-run this occasionally to refresh it
// (violations change slowly; monthly-ish is plenty).
//
// Usage:
//   1. Start the dev server:  npm run dev
//   2. In another terminal:   node scripts/refresh-drinking-snapshot.mjs [baseUrl]
//      (baseUrl defaults to http://localhost:3000)
//
// It calls the route with ?live=1 (forces the real national ECHO fan-out,
// bypassing the snapshot + cache) and writes the resulting stations to disk.

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const baseUrl = process.argv[2] || 'http://localhost:3000';
const outFile = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'data', 'drinking-snapshot.json');

const url = `${baseUrl}/api/water-quality?source=drinking&live=1`;
console.log(`Fetching live drinking-water data from ${url} (this can take a few minutes)...`);

const res = await fetch(url, { signal: AbortSignal.timeout(600000) });
if (!res.ok) {
  console.error(`Request failed: HTTP ${res.status}`);
  process.exit(1);
}
const { stations = [] } = await res.json();
if (!stations.length) {
  console.error('No stations returned — EPA ECHO may be rate-limiting. Try again later. Snapshot NOT overwritten.');
  process.exit(1);
}

writeFileSync(outFile, JSON.stringify(stations));
const counts = stations.reduce((a, s) => { a[s.status] = (a[s.status] || 0) + 1; return a; }, {});
console.log(`Wrote ${stations.length} stations to ${outFile}`, counts);
