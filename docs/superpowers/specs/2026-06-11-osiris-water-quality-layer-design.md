# OSIRIS — Water Quality Layer Design

**Date:** 2026-06-11
**Status:** Approved (brainstorming → ready for implementation plan)
**Scope:** Add a US water-quality intelligence layer to OSIRIS, plus wire the existing orphan air-quality route into the same UI category.

---

## 1. Goal

Add a new **ENVIRONMENT** layer category to OSIRIS that tracks water quality from publicly accessible, free, no-API-key US government data sources, rendered as live points on the existing MapLibre map in OSIRIS's established style. The category also surfaces the already-built-but-unwired air-quality route.

This extends OSIRIS's "real-time feed on a global map" pattern; it does not introduce new architecture.

### Non-goals (YAGNI)
- Composite "Water Risk" scoring model (a single blended 0–100 number per area).
- Global coverage (US only — the best free, keyless water data is US-centric).
- Historical charts / time-series trends.
- AI-Analyst or LiveAlerts integration.

These are explicitly deferrable to later phases and must not be built now.

---

## 2. Scope decisions (from brainstorming)

| Decision | Choice |
|----------|--------|
| Water type | **Both** drinking + ambient, as sub-toggles in one category |
| Geography | **United States** |
| Build approach | **Approach A** — ambient-first, two-source unified layer |
| Air quality | **Wire the existing orphan `air-quality` route** as a third sub-toggle |

---

## 3. Architecture

OSIRIS renders one domain per "layer": a Next.js API route returns `{ stations: [...] }`, `OsirisMap.tsx` registers a GeoJSON source + circle/glow/label layers and fetches the route on toggle, and `LayerPanel.tsx` declares the toggle (`key`, `label`, icon, `color`, `dataKey`). This design follows that pattern exactly.

> **Next.js 16 caveat:** Per `AGENTS.md`, this is a modified Next.js 16. Before writing route handlers or caching config, consult `node_modules/next/dist/docs/` for the exact route-handler signature and caching/`revalidate` conventions rather than relying on prior Next.js knowledge.

### New files
```
src/app/api/water-quality/route.ts   New data route (ambient + drinking via ?source=)
src/lib/water-quality.ts             Pure threshold/status/color logic (testable)
src/lib/water-quality.test.ts        Unit tests (vitest) for the scoring logic
```

### Edited files (small, surgical)
```
src/components/LayerPanel.tsx   +1 "ENVIRONMENT" category with 3 sub-toggles
src/components/OsirisMap.tsx    +3 sources, +circle/glow/label layers, +fetch wiring, +click popup
package.json                    +vitest devDependency, +"test" script
```

All changes are additive; no existing layer is modified or rewritten.

---

## 4. Data sources & route contract

One route, `?source=` switch:

- `GET /api/water-quality?source=ambient`  → Phase 1, **USGS NWIS** instantaneous values (live sensors)
- `GET /api/water-quality?source=drinking` → Phase 2, **EPA ECHO** Safe Drinking Water (violations)

Air quality reuses the **existing** `GET /api/air-quality` route (OpenAQ) unchanged.

### 4.1 Shared station shape

Every source normalizes to one shape so the map renders them identically:

```jsonc
{
  "source": "ambient",                 // ambient | drinking | air
  "total": 842,
  "timestamp": "2026-06-11T00:00:00Z",
  "stations": [{
    "id": "usgs-01646500",
    "source": "USGS",                  // USGS | EPA | OpenAQ
    "name": "POTOMAC RIVER NEAR WASH, DC",
    "lat": 38.94,
    "lng": -77.12,
    "status": "Moderate",              // Good | Moderate | Poor | Unknown
    "color": "#FFD700",
    "reason": "Dissolved oxygen low (4.1 mg/L)",  // human-readable driver of status
    "params": { "ph": 7.2, "do": 4.1, "turbidity": 8, "nitrate": 0.6, "temp": 24.5 },
    "lastUpdated": "2026-06-11T00:00:00Z",
    "url": "https://waterdata.usgs.gov/monitoring-location/01646500/"
  }]
}
```

### 4.2 Phase 1 — Ambient sensors (USGS NWIS)

- **Service:** USGS NWIS Instantaneous Values web service (`waterservices.usgs.gov/nwis/iv/`), JSON output. Free, no API key.
- **Parameters requested (USGS parameter codes):** `00010` temperature (°C), `00300` dissolved oxygen (mg/L), `00400` pH, `00095` specific conductance (µS/cm), `63680` turbidity (FNU), `99133` nitrate (mg/L as N). Request active sites carrying any of these.
- **Nationwide coverage strategy:** the IV service rejects an unscoped "all US" query, so the route fans out across the **21 top-level 2-digit hydrologic unit codes (HUC 01–22)** in parallel via `Promise.allSettled`, then **dedupes by site ID** and caps the result set. This partitions the entire US cleanly.
- **Per-fetch:** `AbortSignal.timeout(~10s)`. Partial failures are tolerated (a failed HUC just contributes nothing).

### 4.3 Phase 2 — Drinking water (EPA ECHO)

- **Service:** EPA ECHO Safe Drinking Water REST services (`get_systems`), JSON. Returns public water systems (PWS) with violation flags and `FacLat`/`FacLong`. Free, no API key.
- **Coverage strategy:** fan out per state (`p_st`), dedupe, cap.
- **Filtering:** **show only PWS with active violations** — a map blanketed in "compliant" green dots is noise. Severity → status:
  - 🔴 **Poor** — health-based violation (MCL / MRDL / treatment-technique).
  - 🟡 **Moderate** — monitoring / reporting violation only.
- **Coordinates:** plot at the PWS reported `FacLat`/`FacLong`; county-centroid fallback if absent. Points are **approximate** because utilities serve areas, not points — the legend/popup states this.
- **Popup fields:** PWS name, population served, violation type + contaminant, link to the ECHO detailed report.

### 4.4 Air quality (existing route, wired)

- Reuse `GET /api/air-quality` (OpenAQ PM2.5). It already returns `lat/lng/color/level/pm25`.
- A small **normalizer** in the map fetch maps its fields into the shared station shape (`level`→`status` label, existing `color`, PM2.5 into `params`) so the same circle/glow/label/popup code renders it. No data-route changes.

---

## 5. Scoring model (`src/lib/water-quality.ts`)

Pure functions, no I/O — fully unit-testable. Each available parameter is graded; the station's **overall status is the worst grade among available parameters** (precautionary), and the driving parameter is captured in `reason`. If no gradable parameter is present, status is `Unknown`.

| Parameter | 🟢 Good | 🟡 Moderate | 🔴 Poor |
|-----------|---------|-------------|---------|
| Dissolved oxygen (mg/L) | > 5 | 2–5 | < 2 (hypoxic) |
| pH | 6.5–8.5 | 6.0–6.5 / 8.5–9.0 | < 6.0 / > 9.0 |
| Nitrate (mg/L as N) | < 1 | 1–10 | > 10 (EPA drinking MCL) |
| Turbidity (FNU) | < 5 | 5–25 | > 25 |
| Temperature, specific conductance | context only — shown in popup, **not graded** (too site-dependent) |

### Color palette (reuses OSIRIS conventions)
| Status | Color |
|--------|-------|
| Good | `#00E676` |
| Moderate | `#FFD700` |
| Poor | `#FF1744` |
| Unknown | `#607D8B` |

---

## 6. Map rendering (`OsirisMap.tsx`)

Mirrors the earthquakes / CCTV layer treatment:

- Add `water-ambient`, `water-drinking`, `air-quality` to the `sources` array (initialized empty, like every other source).
- Per source, three map layers:
  - **glow** — large, blurred circle, `circle-color: ['get','color']`, low opacity.
  - **dots** — solid circle, `circle-color: ['get','color']`.
  - **label** — symbol layer gated to higher zoom (`minzoom`) to avoid global clutter.
- **Click popup** — name, status badge, parameter table (with units), last-updated, source link ("View on USGS →" / ECHO report / OpenAQ).
- Visibility is driven by the existing toggle plumbing keyed off the LayerPanel `key`.

---

## 7. LayerPanel UI (`LayerPanel.tsx`)

New category appended in the existing format:

```
ENVIRONMENT
  💧 Ambient Sensors    key: water_ambient     color: #29B6F6   dataKey: water_ambient    (Phase 1)
  🌫  Air Quality        key: air_quality       color: #AB47BC   dataKey: air_quality      (Phase 1)
  🚰 Drinking Water     key: water_drinking    color: #4DD0E1   dataKey: water_drinking   (Phase 2)
```

Icons from `lucide-react` (already a dependency): `Droplet` (ambient), `Wind` (air), `Droplets` (drinking).

---

## 8. Error handling & caching

- **Route:** `try/catch` wrapping a `Promise.allSettled` fan-out so partial upstream outages still return whatever succeeded. Each upstream fetch uses `AbortSignal.timeout(~10s)`. On total failure, return `{ stations: [], error }` (consistent with the existing air-quality route's behavior).
- **Cache:** module-level cache per source keyed by `source`, with TTL — **~10 min** for ambient/air (real-time-ish), **~12–24h** for drinking (violations change slowly). Prevents hammering USGS/EPA on every toggle and keeps the map responsive. (Confirm the Next.js 16 caching mechanism — module cache vs. route `revalidate` — against `node_modules/next/dist/docs/`.)
- **Client isolation:** a failing water/air fetch never breaks other layers — wired with the same isolated per-layer fetch pattern OSIRIS already uses.

---

## 9. Testing

- **Unit (vitest, written test-first):** `src/lib/water-quality.test.ts` covers:
  - Each parameter's threshold boundaries (Good/Moderate/Poor edges).
  - Worst-wins overall-status logic across multiple parameters.
  - `Unknown` when no gradable parameter is present.
  - Correct `reason` string for the driving parameter.
- **Build/lint gate:** `npm run build` and `npm run lint` stay clean.
- **Behavioral (browser preview):** `npm run dev` → toggle each ENVIRONMENT sub-layer → verify dots render, colors match status, popups populate, labels appear at zoom. Verified before the work is called done.

---

## 10. Phasing

1. **Phase 1** — Scoring lib + tests; `?source=ambient` (USGS); wire air-quality; ENVIRONMENT category with Ambient + Air sub-toggles; map render + popup. Ship + verify.
2. **Phase 2** — `?source=drinking` (EPA ECHO) + Drinking Water sub-toggle + approximate-coords legend note. Ship + verify.

Each phase is independently shippable and browser-verifiable.
