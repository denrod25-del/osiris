# OSIRIS Water Quality Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a US water-quality intelligence layer to OSIRIS (live ambient sensors + drinking-water violations) and wire the existing orphan air-quality route, all as a new ENVIRONMENT layer category.

**Architecture:** Follow OSIRIS's established layer pattern exactly — a Next.js API route returns `{ stations: [...] }`; `page.tsx` lazily fetches it when the layer toggles on and merges it into `dataRef`; `OsirisMap.tsx` builds GeoJSON via `setGeo()` and toggles visibility via `setVis()`; `LayerPanel.tsx` declares the toggle. Scoring logic and source parsers live in pure, unit-tested lib modules.

**Tech Stack:** Next.js 16 (modified — see caveat), TypeScript 5, MapLibre GL JS, vitest (added here). Data sources: USGS NWIS Instantaneous Values, EPA ECHO Safe Drinking Water, OpenAQ (existing route). All free, no API key.

> **⚠️ Next.js 16 caveat (from `AGENTS.md`):** This is a modified Next.js. Before writing/altering the route handler in Task 5, open `node_modules/next/dist/docs/` and confirm the current route-handler signature and route-segment caching config (`export const dynamic` / `revalidate`). If the docs differ from what this plan shows, follow the docs and adjust.

> **⚠️ External API schemas:** USGS and EPA JSON shapes are confirmed against live samples in Tasks 4 and 9 *before* writing parser tests, so the test fixtures reflect reality. Don't skip the sample-fetch steps.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `src/lib/water-quality.ts` | **New.** Pure scoring: grade each parameter, compute worst-wins status + color + reason. No I/O. |
| `src/lib/water-quality.test.ts` | **New.** Unit tests for scoring boundaries. |
| `src/lib/water-sources.ts` | **New.** Pure parsers: `parseUsgsIv`, `normalizeAirStations`, `parseEchoSystems` → shared `WaterStation` shape. No I/O. |
| `src/lib/water-sources.test.ts` | **New.** Fixture-based parser tests. |
| `src/app/api/water-quality/route.ts` | **New.** Fetch + cache + `?source=` switch. Delegates parsing to `water-sources`. |
| `vitest.config.ts` | **New.** Test runner config. |
| `package.json` | **Modify.** Add `vitest` devDep + `test` script. |
| `src/components/LayerPanel.tsx` | **Modify.** Add ENVIRONMENT group + inline SVG icons. |
| `src/components/OsirisMap.tsx` | **Modify.** Add 3 sources, layers, sync effect, visibility, popups. |
| `src/app/page.tsx` | **Modify.** Add `activeLayers` defaults + lazy-fetch blocks. |

---

# PHASE 1 — Scoring lib, ambient (USGS) + air-quality wiring

## Task 1: Add vitest test runner

**Files:**
- Modify: `package.json` (scripts + devDependencies)
- Create: `vitest.config.ts`

- [ ] **Step 1: Add the test script and devDependency**

In `package.json`, change the `"scripts"` block to add a `test` line:

```jsonc
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "eslint",
    "test": "vitest run"
  },
```

And add to `"devDependencies"` (keep alphabetical-ish, any position is fine):

```jsonc
    "vitest": "^3.2.4",
```

- [ ] **Step 2: Create the vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
```

- [ ] **Step 3: Install**

Run: `npm install`
Expected: installs `vitest`, no errors.

- [ ] **Step 4: Verify the runner works (no tests yet)**

Run: `npm test`
Expected: vitest runs and reports "No test files found" (exit code may be non-zero; that's fine — the next task adds tests).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json vitest.config.ts
git commit -m "chore: add vitest test runner"
```

---

## Task 2: Water-quality scoring lib (TDD)

**Files:**
- Create: `src/lib/water-quality.ts`
- Test: `src/lib/water-quality.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/water-quality.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { assessWater, STATUS_COLORS } from './water-quality';

describe('assessWater', () => {
  it('returns Unknown when no gradable parameters are present', () => {
    const r = assessWater({ temp: 22, conductance: 800 });
    expect(r.status).toBe('Unknown');
    expect(r.color).toBe(STATUS_COLORS.Unknown);
    expect(r.reason).toMatch(/no gradable/i);
  });

  it('grades healthy water as Good', () => {
    const r = assessWater({ do: 8, ph: 7.2, nitrate: 0.4, turbidity: 2 });
    expect(r.status).toBe('Good');
    expect(r.color).toBe(STATUS_COLORS.Good);
    expect(r.reason).toMatch(/within normal range/i);
  });

  it('dissolved oxygen boundaries: >5 Good, 2-5 Moderate, <2 Poor', () => {
    expect(assessWater({ do: 5.1 }).status).toBe('Good');
    expect(assessWater({ do: 5 }).status).toBe('Moderate');
    expect(assessWater({ do: 2 }).status).toBe('Moderate');
    expect(assessWater({ do: 1.9 }).status).toBe('Poor');
  });

  it('pH boundaries: 6.5-8.5 Good, 6.0-6.5/8.5-9.0 Moderate, outside Poor', () => {
    expect(assessWater({ ph: 7 }).status).toBe('Good');
    expect(assessWater({ ph: 6.5 }).status).toBe('Good');
    expect(assessWater({ ph: 8.5 }).status).toBe('Good');
    expect(assessWater({ ph: 6.2 }).status).toBe('Moderate');
    expect(assessWater({ ph: 8.9 }).status).toBe('Moderate');
    expect(assessWater({ ph: 5.9 }).status).toBe('Poor');
    expect(assessWater({ ph: 9.1 }).status).toBe('Poor');
  });

  it('nitrate boundaries: <1 Good, 1-10 Moderate, >10 Poor', () => {
    expect(assessWater({ nitrate: 0.9 }).status).toBe('Good');
    expect(assessWater({ nitrate: 1 }).status).toBe('Moderate');
    expect(assessWater({ nitrate: 10 }).status).toBe('Moderate');
    expect(assessWater({ nitrate: 10.1 }).status).toBe('Poor');
  });

  it('turbidity boundaries: <5 Good, 5-25 Moderate, >25 Poor', () => {
    expect(assessWater({ turbidity: 4.9 }).status).toBe('Good');
    expect(assessWater({ turbidity: 5 }).status).toBe('Moderate');
    expect(assessWater({ turbidity: 25 }).status).toBe('Moderate');
    expect(assessWater({ turbidity: 25.1 }).status).toBe('Poor');
  });

  it('overall status is the worst of all parameters (worst-wins)', () => {
    const r = assessWater({ do: 9, ph: 7, nitrate: 12 }); // nitrate Poor dominates
    expect(r.status).toBe('Poor');
    expect(r.reason).toMatch(/nitrate/i);
  });

  it('ignores non-finite parameter values', () => {
    const r = assessWater({ do: NaN, ph: 7.2 });
    expect(r.status).toBe('Good');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/lib/water-quality.test.ts`
Expected: FAIL — `assessWater` / `STATUS_COLORS` not found (module doesn't exist yet).

- [ ] **Step 3: Implement the scoring lib**

Create `src/lib/water-quality.ts`:

```ts
// Pure water-quality scoring. No I/O — fully unit-testable.

export type WaterStatus = 'Good' | 'Moderate' | 'Poor' | 'Unknown';

export const STATUS_COLORS: Record<WaterStatus, string> = {
  Good: '#00E676',
  Moderate: '#FFD700',
  Poor: '#FF1744',
  Unknown: '#607D8B',
};

export interface WaterParams {
  temp?: number;        // °C (context only, not graded)
  do?: number;          // dissolved oxygen, mg/L
  ph?: number;
  conductance?: number; // µS/cm (context only, not graded)
  turbidity?: number;   // FNU
  nitrate?: number;     // mg/L as N
}

export interface WaterAssessment {
  status: WaterStatus;
  color: string;
  reason: string;
}

type Grade = 'Good' | 'Moderate' | 'Poor';
const RANK: Record<Grade, number> = { Good: 0, Moderate: 1, Poor: 2 };

interface ParamGrade { grade: Grade; reason: string; }

function gradeDO(v: number): ParamGrade {
  if (v < 2) return { grade: 'Poor', reason: `Dissolved oxygen critically low (${v} mg/L)` };
  if (v <= 5) return { grade: 'Moderate', reason: `Dissolved oxygen low (${v} mg/L)` };
  return { grade: 'Good', reason: `Dissolved oxygen healthy (${v} mg/L)` };
}

function gradePH(v: number): ParamGrade {
  if (v < 6.0 || v > 9.0) return { grade: 'Poor', reason: `pH out of safe range (${v})` };
  if (v < 6.5 || v > 8.5) return { grade: 'Moderate', reason: `pH borderline (${v})` };
  return { grade: 'Good', reason: `pH normal (${v})` };
}

function gradeNitrate(v: number): ParamGrade {
  if (v > 10) return { grade: 'Poor', reason: `Nitrate exceeds drinking limit (${v} mg/L)` };
  if (v >= 1) return { grade: 'Moderate', reason: `Nitrate elevated (${v} mg/L)` };
  return { grade: 'Good', reason: `Nitrate low (${v} mg/L)` };
}

function gradeTurbidity(v: number): ParamGrade {
  if (v > 25) return { grade: 'Poor', reason: `High turbidity (${v} FNU)` };
  if (v >= 5) return { grade: 'Moderate', reason: `Moderate turbidity (${v} FNU)` };
  return { grade: 'Good', reason: `Clear water (${v} FNU)` };
}

export function assessWater(params: WaterParams): WaterAssessment {
  const grades: ParamGrade[] = [];
  if (Number.isFinite(params.do)) grades.push(gradeDO(params.do as number));
  if (Number.isFinite(params.ph)) grades.push(gradePH(params.ph as number));
  if (Number.isFinite(params.nitrate)) grades.push(gradeNitrate(params.nitrate as number));
  if (Number.isFinite(params.turbidity)) grades.push(gradeTurbidity(params.turbidity as number));

  if (grades.length === 0) {
    return { status: 'Unknown', color: STATUS_COLORS.Unknown, reason: 'No gradable parameters reported' };
  }

  const worst = grades.reduce((a, b) => (RANK[b.grade] > RANK[a.grade] ? b : a));
  const status: WaterStatus = worst.grade;
  const reason = worst.grade === 'Good' ? 'All measured parameters within normal range' : worst.reason;
  return { status, color: STATUS_COLORS[status], reason };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/lib/water-quality.test.ts`
Expected: PASS (all assertions green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/water-quality.ts src/lib/water-quality.test.ts
git commit -m "feat: add water-quality scoring lib"
```

---

## Task 3: Confirm the USGS sample, then write the ambient parser (TDD)

**Files:**
- Create: `src/lib/water-sources.ts`
- Test: `src/lib/water-sources.test.ts`

- [ ] **Step 1: Fetch a live USGS sample to confirm JSON shape**

Run (PowerShell):
```powershell
curl.exe "https://waterservices.usgs.gov/nwis/iv/?format=json&huc=03&parameterCd=00010,00300,00400,00095,63680,99133&siteStatus=active" -o usgs-sample.json
```
Open `usgs-sample.json` and confirm the path `value.timeSeries[].sourceInfo.siteCode[0].value`, `sourceInfo.geoLocation.geogLocation.latitude/longitude`, `variable.variableCode[0].value`, and `values[0].value[]` (each `{ value, dateTime }`). If field paths differ, adjust the parser and the fixture below to match. Delete `usgs-sample.json` afterward (do not commit it).

- [ ] **Step 2: Write the failing parser tests**

Create `src/lib/water-sources.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseUsgsIv, normalizeAirStations } from './water-sources';

// Minimal fixture mirroring USGS IV WaterML-JSON. Two parameters for one site.
const USGS_FIXTURE = {
  value: {
    timeSeries: [
      {
        sourceInfo: {
          siteName: 'POTOMAC RIVER NEAR WASH, DC',
          siteCode: [{ value: '01646500' }],
          geoLocation: { geogLocation: { latitude: 38.94, longitude: -77.12 } },
        },
        variable: { variableCode: [{ value: '00400' }] }, // pH
        values: [{ value: [{ value: '7.2', dateTime: '2026-06-11T12:00:00.000-05:00' }] }],
      },
      {
        sourceInfo: {
          siteName: 'POTOMAC RIVER NEAR WASH, DC',
          siteCode: [{ value: '01646500' }],
          geoLocation: { geogLocation: { latitude: 38.94, longitude: -77.12 } },
        },
        variable: { variableCode: [{ value: '00300' }] }, // dissolved oxygen
        values: [{ value: [{ value: '4.1', dateTime: '2026-06-11T12:15:00.000-05:00' }] }],
      },
      {
        // a no-data reading USGS returns as -999999 — must be ignored
        sourceInfo: {
          siteName: 'GHOST SITE',
          siteCode: [{ value: '00000000' }],
          geoLocation: { geogLocation: { latitude: 40, longitude: -75 } },
        },
        variable: { variableCode: [{ value: '00400' }] },
        values: [{ value: [{ value: '-999999', dateTime: '2026-06-11T12:00:00.000-05:00' }] }],
      },
    ],
  },
};

describe('parseUsgsIv', () => {
  it('groups parameters by site and assesses status', () => {
    const stations = parseUsgsIv(USGS_FIXTURE);
    const potomac = stations.find(s => s.id === 'usgs-01646500');
    expect(potomac).toBeDefined();
    expect(potomac!.source).toBe('USGS');
    expect(potomac!.lat).toBe(38.94);
    expect(potomac!.lng).toBe(-77.12);
    expect(potomac!.params.ph).toBe(7.2);
    expect(potomac!.params.do).toBe(4.1);
    expect(potomac!.status).toBe('Moderate'); // DO 4.1 → Moderate
    expect(potomac!.url).toContain('01646500');
    expect(potomac!.lastUpdated).toBe('2026-06-11T12:15:00.000-05:00'); // latest of the two
  });

  it('drops sites whose only readings are no-data sentinels', () => {
    const stations = parseUsgsIv(USGS_FIXTURE);
    expect(stations.find(s => s.id === 'usgs-00000000')).toBeUndefined();
  });

  it('returns empty array on malformed input', () => {
    expect(parseUsgsIv({})).toEqual([]);
    expect(parseUsgsIv(null)).toEqual([]);
  });
});

describe('normalizeAirStations', () => {
  it('maps the air-quality route shape into the shared station shape', () => {
    const out = normalizeAirStations([
      { id: 'x', name: 'Beijing', lat: 39.9, lng: 116.4, pm25: 80, unit: 'µg/m³', level: 'Unhealthy', color: '#FF1744', city: 'Beijing', country: 'CN' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('OpenAQ');
    expect(out[0].status).toBe('Unhealthy');
    expect(out[0].color).toBe('#FF1744');
    expect(out[0].params.pm25).toBe(80);
    expect(out[0].reason).toMatch(/PM2\.5 80/);
  });

  it('returns empty array on non-array input', () => {
    expect(normalizeAirStations(undefined as any)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/lib/water-sources.test.ts`
Expected: FAIL — module `./water-sources` not found.

- [ ] **Step 4: Implement the parsers (USGS + air normalizer; ECHO stub for Phase 2)**

Create `src/lib/water-sources.ts`:

```ts
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/lib/water-sources.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/water-sources.ts src/lib/water-sources.test.ts
git commit -m "feat: add USGS + air-quality station parsers"
```

---

## Task 4: Water-quality API route (ambient live; drinking stubbed)

**Files:**
- Create: `src/app/api/water-quality/route.ts`

- [ ] **Step 1: Read the Next.js 16 route-handler docs**

Open `node_modules/next/dist/docs/` and confirm the route-handler export signature and caching directive. The code below uses `export async function GET(request: Request)` and `export const dynamic = 'force-dynamic'`. If the modified Next.js differs, follow the docs.

- [ ] **Step 2: Create the route**

Create `src/app/api/water-quality/route.ts`:

```ts
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
```

- [ ] **Step 3: Verify the route returns live stations**

Start the dev server in a separate terminal (`npm run dev`), then run (PowerShell):
```powershell
curl.exe "http://localhost:3000/api/water-quality?source=ambient" | ConvertFrom-Json | Select-Object source,total
```
Expected: `source = ambient`, `total > 0` (typically hundreds). First call is slow (fans out to USGS); a second call returns instantly (`cached: true`).

- [ ] **Step 4: Verify the drinking stub responds**

Run: `curl.exe "http://localhost:3000/api/water-quality?source=drinking" | ConvertFrom-Json | Select-Object source,total`
Expected: `source = drinking`, `total = 0` (stub — filled in Phase 2).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/water-quality/route.ts
git commit -m "feat: add water-quality API route (ambient live)"
```

---

## Task 5: Register sources, layers, sync, visibility, popups in OsirisMap

**Files:**
- Modify: `src/components/OsirisMap.tsx`

- [ ] **Step 1: Add the three GeoJSON sources**

Find the `sources` array (around line 184, begins `const sources = ['flights',...`). Append the three new source names to the array literal, before the closing `]`:

```ts
'water-ambient', 'water-drinking', 'air-quality'
```

(So it ends `...'malware-nodes', 'network-mesh', 'water-ambient', 'water-drinking', 'air-quality'];`)

- [ ] **Step 2: Add the circle/glow/label layers**

Immediately **before** `setMapReady(true);` (around line 564), insert:

```ts
      // ── Water Quality + Air Quality (ENVIRONMENT) ──
      ['water-ambient', 'water-drinking', 'air-quality'].forEach(src => {
        map.addLayer({ id: `${src}-glow`, type: 'circle', source: src, paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 6, 5, 14, 10, 22],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.12,
          'circle-blur': 1,
        }});
        map.addLayer({ id: `${src}-dots`, type: 'circle', source: src, paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 1, 2.5, 5, 4.5, 10, 7],
          'circle-color': ['get', 'color'],
          'circle-opacity': 0.85,
          'circle-stroke-width': 0.5,
          'circle-stroke-color': '#00121a',
        }});
        map.addLayer({ id: `${src}-label`, type: 'symbol', source: src, minzoom: 6, layout: {
          'text-field': ['get', 'name'], 'text-size': 9, 'text-font': ['Open Sans Regular'],
          'text-offset': [0, 1.2], 'text-allow-overlap': false,
        }, paint: { 'text-color': ['get', 'color'], 'text-halo-color': '#000', 'text-halo-width': 1 }});
      });
```

- [ ] **Step 3: Add the click popups**

Find the flights popup block (`['fl-commercial','fl-private','fl-jets','fl-military'].forEach(layer => {` around line 588). Immediately **after** that block's closing `});`, insert:

```ts
    // ── Water / Air station popups ──
    ['water-ambient-dots', 'water-drinking-dots', 'air-quality-dots'].forEach(layer => {
      map.on('click', layer, e => {
        if (!e.features?.length) return;
        const p = e.features[0].properties as any;
        const coords = (e.features[0].geometry as any).coordinates;
        let params: Record<string, any> = {};
        try { params = p.params ? (typeof p.params === 'string' ? JSON.parse(p.params) : p.params) : {}; } catch { params = {}; }
        const rows = Object.entries(params)
          .filter(([, v]) => v !== undefined && v !== null && v !== '')
          .map(([k, v]) => `<div><span style="color:#5C5A54;font-size:9px;">${k.toUpperCase()}</span><br/><span style="color:#E8E6E0;">${v}</span></div>`)
          .join('');
        popup(coords, `<div style="${pStyle}border:1px solid ${p.color}55;">
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:10px;">
            <span style="color:${p.color};font-size:14px;font-weight:700;">${p.name || 'Station'}</span>
            <span style="color:${p.color};font-size:10px;border:1px solid ${p.color}55;border-radius:4px;padding:2px 6px;white-space:nowrap;">${p.status || ''}</span>
          </div>
          <div style="color:#9A988F;font-size:10px;margin-bottom:8px;">${p.reason || ''}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-size:11px;">${rows}</div>
          ${p.source === 'EPA' ? `<div style="color:#7a786f;font-size:9px;margin-top:8px;">⚠ Location approximate (utility service area)</div>` : ''}
          ${p.url ? `<a href="${p.url}" target="_blank" style="${linkStyle}color:${p.color};border:1px solid ${p.color}55;background:${p.color}1a;">VIEW SOURCE →</a>` : ''}
        </div>`);
      });
    });
```

- [ ] **Step 4: Add the data-sync effect**

Find the earthquakes sync effect (around line 1115, `setGeo('earthquakes', ...)`). Immediately **after** its closing `}, [...]);`, insert a new effect:

```ts
  // ── Water Quality + Air Quality station sync ──
  useEffect(() => {
    if (!mapReady) return;
    const toFeatures = (arr: any[], on: boolean) =>
      on && Array.isArray(arr)
        ? arr
            .filter((s: any) => Number.isFinite(s.lat) && Number.isFinite(s.lng))
            .map((s: any) => ({
              type: 'Feature' as const,
              geometry: { type: 'Point' as const, coordinates: [s.lng, s.lat] },
              properties: { name: s.name, color: s.color, status: s.status, reason: s.reason, source: s.source, url: s.url, params: s.params },
            }))
        : [];
    setGeo('water-ambient', toFeatures(data.water_ambient, activeLayers.water_ambient));
    setGeo('water-drinking', toFeatures(data.water_drinking, activeLayers.water_drinking));
    setGeo('air-quality', toFeatures(data.air_quality, activeLayers.air_quality));
  }, [mapReady, data.water_ambient, data.water_drinking, data.air_quality, activeLayers.water_ambient, activeLayers.water_drinking, activeLayers.air_quality, setGeo]);
```

- [ ] **Step 5: Add visibility toggles**

Find the central visibility effect (the `setVis([...], activeLayers.xxx)` block around lines 1289–1316). Add these three lines alongside the others (e.g. after the `setVis(['fires-heat'], activeLayers.fires);` line):

```ts
    setVis(['water-ambient-glow', 'water-ambient-dots', 'water-ambient-label'], activeLayers.water_ambient);
    setVis(['water-drinking-glow', 'water-drinking-dots', 'water-drinking-label'], activeLayers.water_drinking);
    setVis(['air-quality-glow', 'air-quality-dots', 'air-quality-label'], activeLayers.air_quality);
```

- [ ] **Step 6: Typecheck / build the map changes**

Run: `npm run build`
Expected: compiles with no TypeScript errors. (If `Feature`/`Point` literal typing complains, the `as const` annotations above resolve it.)

- [ ] **Step 7: Commit**

```bash
git add src/components/OsirisMap.tsx
git commit -m "feat: render water + air quality layers on the map"
```

---

## Task 6: Wire the ENVIRONMENT category into LayerPanel

**Files:**
- Modify: `src/components/LayerPanel.tsx`

- [ ] **Step 1: Add inline SVG icon components**

This repo's `lucide-react` is a reduced build (note the hand-rolled `Shield` component because the icon wasn't exported). To avoid a missing-export build failure, add inline icons. Immediately **after** the existing `function Shield(props: any) { ... }` component (around line 117), insert:

```tsx
function Droplet(props: any) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M12 2.5 6.5 9a7.5 7.5 0 1 0 11 0z"/>
    </svg>
  );
}

function Droplets(props: any) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M7 16.3a4 4 0 0 1-1.4-7.5L9 4l3.4 4.8A4 4 0 0 1 11 16.3"/>
      <path d="M12.6 19.6a3.3 3.3 0 1 0 5-4.2L15 12l-2.6 3.4a3.3 3.3 0 0 0 .2 4.2z"/>
    </svg>
  );
}

function Wind(props: any) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 8h11a2.5 2.5 0 1 0-2.5-2.5"/>
      <path d="M3 12h16a2.5 2.5 0 1 1-2.5 2.5"/>
      <path d="M3 16h7a2.5 2.5 0 1 1-2.5 2.5"/>
    </svg>
  );
}
```

(Do **not** add these to the `lucide-react` import — they are local components, like `Shield`.)

- [ ] **Step 2: Add the ENVIRONMENT layer group**

In `getLayerGroups`, insert a new group object immediately **after** the `HAZARD` group's closing `},` (around line 79, after the `weather` layer block):

```ts
  {
    label: 'ENVIRON',
    fullLabel: 'ENVIRONMENT',
    color: '#29B6F6',
    layers: [
      { key: 'water_ambient', label: 'Ambient Water', icon: Droplet, color: '#29B6F6', dataKey: 'water_ambient' },
      { key: 'air_quality', label: 'Air Quality', icon: Wind, color: '#AB47BC', dataKey: 'air_quality' },
      { key: 'water_drinking', label: 'Drinking Water', icon: Droplets, color: '#4DD0E1', dataKey: 'water_drinking' },
    ],
  },
```

- [ ] **Step 3: Build to confirm icons + group compile**

Run: `npm run build`
Expected: compiles cleanly. (`getCount` already handles the new `dataKey`s — they map to arrays in `data`.)

- [ ] **Step 4: Commit**

```bash
git add src/components/LayerPanel.tsx
git commit -m "feat: add ENVIRONMENT category to layer panel"
```

---

## Task 7: Wire lazy fetch + defaults in page.tsx

**Files:**
- Modify: `src/app/page.tsx`

- [ ] **Step 1: Import the air normalizer**

Near the top imports of `src/app/page.tsx`, add:

```ts
import { normalizeAirStations } from '@/lib/water-sources';
```

- [ ] **Step 2: Add default toggle states**

In the `activeLayers` initial state object (begins around line 130, `useState({`), add three entries (any position inside the object literal):

```ts
    water_ambient: false,
    air_quality: false,
    water_drinking: false,
```

- [ ] **Step 3: Add lazy-fetch blocks**

In the layer-aware data-loading effect, immediately **after** the Live Malware block (around line 438, after `layerFetchedRef.current.add('malware');` and its closing `}`), insert:

```ts
    // Ambient water (USGS)
    if (activeLayers.water_ambient && !layerFetchedRef.current.has('water_ambient')) {
      fetchEndpoint('/api/water-quality?source=ambient', d => ({ water_ambient: d.stations }));
      layerFetchedRef.current.add('water_ambient');
    }
    // Air quality (OpenAQ — existing route, normalized)
    if (activeLayers.air_quality && !layerFetchedRef.current.has('air_quality')) {
      fetchEndpoint('/api/air-quality', d => ({ air_quality: normalizeAirStations(d.stations) }));
      layerFetchedRef.current.add('air_quality');
    }
    // Drinking water (EPA ECHO)
    if (activeLayers.water_drinking && !layerFetchedRef.current.has('water_drinking')) {
      fetchEndpoint('/api/water-quality?source=drinking', d => ({ water_drinking: d.stations }));
      layerFetchedRef.current.add('water_drinking');
    }
```

- [ ] **Step 4: Build**

Run: `npm run build`
Expected: compiles cleanly.

- [ ] **Step 5: Commit**

```bash
git add src/app/page.tsx
git commit -m "feat: lazy-fetch water + air quality layers on toggle"
```

---

## Task 8: Phase 1 behavioral verification (browser)

**Files:** none (verification only)

- [ ] **Step 1: Full test + lint + build gate**

Run: `npm test` then `npm run lint` then `npm run build`
Expected: tests PASS, lint clean (warnings acceptable if pre-existing style matches), build succeeds.

- [ ] **Step 2: Launch and verify in the browser preview**

Start the dev server and open the preview. Then:
- Hover the left layer rail → confirm an **ENVIRONMENT** group appears with Ambient Water / Air Quality / Drinking Water.
- Toggle **Ambient Water** → confirm colored dots appear across the US after the fetch; the panel count is > 0.
- Click a dot → confirm the popup shows name, status badge, the parameter grid (pH/DO/etc.), and a "VIEW SOURCE →" link to USGS.
- Toggle **Air Quality** → confirm dots appear (see caveat below).
- Confirm toggling each layer off clears its dots and other layers are unaffected.

> **Air-quality data caveat:** the existing `/api/air-quality` route calls OpenAQ **v2**, which OpenAQ has deprecated in favor of v3 (API-key gated). If the air layer renders zero dots, the *wiring* is still correct — verify with `curl.exe "http://localhost:3000/api/air-quality"`; an empty `stations` array confirms the upstream is dead, not our integration. Repointing air-quality at a live source is out of scope for this plan (the spec scoped air as "wire the existing route, zero new data work"). Note it for a follow-up.

- [ ] **Step 3: Capture proof**

Take a preview screenshot of the map with Ambient Water active and a popup open. Phase 1 is done when dots render and popups populate.

---

# PHASE 2 — Drinking water (EPA ECHO)

## Task 9: Confirm the ECHO sample, then write the drinking-water parser (TDD)

**Files:**
- Modify: `src/lib/water-sources.ts` (replace `parseEchoSystems` stub)
- Modify: `src/lib/water-sources.test.ts` (add ECHO tests)

- [ ] **Step 1: Fetch a live ECHO sample to confirm field names**

EPA ECHO's Safe Drinking Water service field names must be confirmed against live output (they are not guessable reliably). Run (PowerShell), using a small state to keep the payload modest:
```powershell
curl.exe "https://echodata.epa.gov/echo/sdw_rest_services.get_systems?output=JSON&p_st=DE&p_act=Y" -o echo-sample.json
```
Open `echo-sample.json`. Identify, in `Results.Facilities[]` (confirm this path too), the exact keys for: facility name, latitude, longitude, total violation count, and health-based violation count. ECHO commonly uses `FacName`, `FacLat`, `FacLong`, and violation summary fields — **but confirm the real keys** and use them verbatim in Step 2. Delete `echo-sample.json` afterward (do not commit it).

- [ ] **Step 2: Write the failing ECHO parser tests**

Add to `src/lib/water-sources.test.ts` (append a new describe block; replace the placeholder key names below with the **actual** keys confirmed in Step 1 if they differ):

```ts
import { parseEchoSystems } from './water-sources';

describe('parseEchoSystems', () => {
  // Replace key names here with the real ECHO field names confirmed from the live sample.
  const ECHO_FIXTURE = {
    Results: {
      Facilities: [
        { FacName: 'CITY OF DOVER', FacLat: '39.158', FacLong: '-75.524', SDWAViolations: '3', SDWAHBViolations: '1' }, // health-based → Poor
        { FacName: 'SMYRNA WATER DEPT', FacLat: '39.299', FacLong: '-75.604', SDWAViolations: '2', SDWAHBViolations: '0' }, // monitoring only → Moderate
        { FacName: 'CLEAN SYSTEM', FacLat: '39.7', FacLong: '-75.6', SDWAViolations: '0', SDWAHBViolations: '0' }, // no violations → dropped
        { FacName: 'NO COORDS', FacLat: '', FacLong: '', SDWAViolations: '5', SDWAHBViolations: '2' }, // no coords → dropped
      ],
    },
  };

  it('keeps only systems with violations and grades by severity', () => {
    const out = parseEchoSystems(ECHO_FIXTURE);
    const dover = out.find(s => s.name === 'CITY OF DOVER');
    const smyrna = out.find(s => s.name === 'SMYRNA WATER DEPT');
    expect(dover?.status).toBe('Poor');
    expect(dover?.color).toBe('#FF1744');
    expect(dover?.source).toBe('EPA');
    expect(smyrna?.status).toBe('Moderate');
    expect(smyrna?.color).toBe('#FFD700');
    expect(out.find(s => s.name === 'CLEAN SYSTEM')).toBeUndefined();
    expect(out.find(s => s.name === 'NO COORDS')).toBeUndefined();
  });

  it('returns empty array on malformed input', () => {
    expect(parseEchoSystems({})).toEqual([]);
    expect(parseEchoSystems(null)).toEqual([]);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- src/lib/water-sources.test.ts`
Expected: FAIL on the new ECHO assertions (stub returns `[]`).

- [ ] **Step 4: Implement `parseEchoSystems`**

In `src/lib/water-sources.ts`, replace the stub `parseEchoSystems` with (use the **confirmed** field names from Step 1; the names below match the fixture):

```ts
export function parseEchoSystems(json: any): WaterStation[] {
  const facs = json?.Results?.Facilities ?? [];
  if (!Array.isArray(facs)) return [];
  const out: WaterStation[] = [];
  for (const f of facs) {
    const lat = parseFloat(f.FacLat);
    const lng = parseFloat(f.FacLong);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const total = parseInt(f.SDWAViolations ?? '0', 10) || 0;
    const healthBased = parseInt(f.SDWAHBViolations ?? '0', 10) || 0;
    if (total <= 0 && healthBased <= 0) continue; // violations only

    const isPoor = healthBased > 0;
    const status = isPoor ? 'Poor' : 'Moderate';
    const color = isPoor ? '#FF1744' : '#FFD700';
    const reason = isPoor
      ? `${healthBased} health-based violation(s)`
      : `${total} monitoring/reporting violation(s)`;
    const id = f.SDWAID ?? f.PWSID ?? `${f.FacName}-${lat}-${lng}`;

    out.push({
      id: `epa-${id}`,
      source: 'EPA',
      name: f.FacName ?? 'Public Water System',
      lat,
      lng,
      status,
      color,
      reason,
      params: { violations: total, health_based: healthBased, population: f.SDWAPop ?? f.PopServed },
      lastUpdated: null,
      url: `https://echo.epa.gov/detailed-facility-report?fid=${id}`,
    });
  }
  return out;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- src/lib/water-sources.test.ts`
Expected: PASS (all describe blocks).

- [ ] **Step 6: Commit**

```bash
git add src/lib/water-sources.ts src/lib/water-sources.test.ts
git commit -m "feat: add EPA ECHO drinking-water parser"
```

---

## Task 10: Activate the drinking-water fetch in the route

**Files:**
- Modify: `src/app/api/water-quality/route.ts`

- [ ] **Step 1: Replace the `fetchDrinking` stub**

In `src/app/api/water-quality/route.ts`, add `parseEchoSystems` to the import from `@/lib/water-sources` (it is already exported), then replace the stub body:

```ts
// US states + DC for nationwide ECHO coverage.
const STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC'];

async function fetchDrinking(): Promise<WaterStation[]> {
  const results = await Promise.allSettled(
    STATES.map(st =>
      fetch(
        `https://echodata.epa.gov/echo/sdw_rest_services.get_systems?output=JSON&p_st=${st}&p_act=Y`,
        { signal: AbortSignal.timeout(10000), headers: { Accept: 'application/json' } }
      ).then(r => (r.ok ? r.json() : null))
    )
  );
  const seen = new Map<string, WaterStation>();
  for (const r of results) {
    if (r.status !== 'fulfilled' || !r.value) continue;
    for (const st of parseEchoSystems(r.value)) {
      if (!seen.has(st.id)) seen.set(st.id, st);
    }
  }
  return Array.from(seen.values()).slice(0, MAX_STATIONS);
}
```

> If the ECHO `get_systems` response shape from Task 9 differs (e.g. results are nested under a different key, or the per-state query must use a different parameter than `p_st`/`p_act`), adjust the URL/params here to match what actually returned data in Task 9 Step 1.

- [ ] **Step 2: Verify live drinking-water data**

With `npm run dev` running:
```powershell
curl.exe "http://localhost:3000/api/water-quality?source=drinking" | ConvertFrom-Json | Select-Object source,total
```
Expected: `source = drinking`, `total > 0`. First call is slow (50 + DC fan-out); second is cached.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/water-quality/route.ts
git commit -m "feat: fetch EPA drinking-water violations in water-quality route"
```

---

## Task 11: Phase 2 behavioral verification (browser)

**Files:** none (verification only)

- [ ] **Step 1: Test + lint + build gate**

Run: `npm test` then `npm run lint` then `npm run build`
Expected: all PASS / clean.

- [ ] **Step 2: Verify in the browser preview**

- Toggle **Drinking Water** → confirm red/amber dots appear at US public water systems with violations.
- Click a dot → confirm the popup shows the system name, a Poor/Moderate badge, the violation reason, the "⚠ Location approximate" note, and a link to the ECHO report.
- Confirm Ambient Water and Air Quality still work alongside it, and toggling is independent.

- [ ] **Step 3: Capture proof**

Screenshot the map with Drinking Water active and a violation popup open.

---

## Self-Review (completed by plan author)

- **Spec coverage:** Ambient (USGS) → Tasks 3–5,7. Drinking (EPA) → Tasks 9–10. Air-quality wiring → Tasks 3,5,7. Scoring model → Task 2. Shared station shape → Task 3. Map render/popups → Task 5. LayerPanel category → Task 6. Caching/error handling → Task 4 (route). Testing (vitest) → Tasks 1–3,9. Phasing → Phase 1 / Phase 2 split. Next.js-16 caveat → Task 4 Step 1. All spec sections mapped. ✅
- **Placeholder scan:** No TBD/TODO/"handle edge cases" — every code step is complete. External-schema confirmation steps (Tasks 3,9) are explicit verification actions, not placeholders. ✅
- **Type consistency:** `WaterStation`, `WaterParams`, `WaterStatus`, `assessWater`, `STATUS_COLORS`, `parseUsgsIv`, `parseEchoSystems`, `normalizeAirStations` are defined once and referenced consistently. Source names (`water-ambient`/`water-drinking`/`air-quality`) and layer-id suffixes (`-glow`/`-dots`/`-label`) match across map source registration, layers, sync, visibility, and popups. `activeLayers` keys (`water_ambient`/`air_quality`/`water_drinking`) match between page.tsx, LayerPanel, and OsirisMap. ✅
