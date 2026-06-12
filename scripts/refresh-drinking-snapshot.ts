/**
 * Regenerates src/lib/data/drinking-snapshot.json from live EPA ECHO data.
 *
 * EPA's per-state fan-out takes minutes, which exceeds serverless function
 * time limits — so /api/water-quality?source=drinking serves this pre-generated
 * snapshot instead. Re-run this occasionally to refresh it
 * (violations change slowly; monthly-ish is plenty).
 *
 * Usage:
 *   npm run refresh:drinking
 *   (or: npx tsx scripts/refresh-drinking-snapshot.ts)
 *
 * Exits non-zero and does NOT overwrite the snapshot if 0 stations are
 * returned, preventing an ECHO outage from wiping good data.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchDrinkingLive } from '../src/lib/echo-drinking';

const outFile = join(__dirname, '..', 'src', 'lib', 'data', 'drinking-snapshot.json');

async function main(): Promise<void> {
  console.log('Fetching live drinking-water data from EPA ECHO (this takes a few minutes)...');

  const stations = await fetchDrinkingLive();

  if (!stations.length) {
    console.error(
      'ERROR: 0 stations returned — EPA ECHO may be rate-limiting or down. ' +
      'Snapshot NOT overwritten. Try again later.',
    );
    process.exit(1);
  }

  const counts: Record<string, number> = stations.reduce<Record<string, number>>((acc, s) => {
    acc[s.status] = (acc[s.status] ?? 0) + 1;
    return acc;
  }, {});

  writeFileSync(outFile, JSON.stringify(stations, null, 2));

  console.log(`Wrote ${stations.length} stations to ${outFile}`);
  console.log('Status breakdown:', counts);
}

main().catch((err: unknown) => {
  console.error('Refresh failed:', err);
  process.exit(1);
});
