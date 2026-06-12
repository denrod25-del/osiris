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
