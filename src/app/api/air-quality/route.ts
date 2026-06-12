import { NextResponse } from 'next/server';
import WORLD_CITIES from '@/lib/data/world-cities.json';

/**
 * OSIRIS — Air Quality Monitoring API
 * Fetches real-time global air quality data from Open-Meteo Air Quality API
 * FREE — No API key required
 * Data: PM2.5 + US AQI for ~400 major world cities (gridded model, no station list)
 */

export const dynamic = 'force-dynamic';

interface City {
  name: string;
  country: string;
  lat: number;
  lng: number;
}

interface AirStation {
  id: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lng: number;
  pm25: number;
  unit: string;
  level: string;
  color: string;
  lastUpdated: string;
}

// Module-level cache (~15 min TTL)
const CACHE_TTL_MS = 15 * 60 * 1000;
let cache: { ts: number; stations: AirStation[] } | null = null;

const BATCH_SIZE = 100;

function pm25ToLevel(val: number): { level: string; color: string } {
  if (val > 150) return { level: 'Hazardous', color: '#8B0000' };
  if (val > 100) return { level: 'Unhealthy', color: '#FF1744' };
  if (val > 55)  return { level: 'Unhealthy (Sensitive)', color: '#FF9500' };
  if (val > 35)  return { level: 'Moderate', color: '#FFD700' };
  return { level: 'Good', color: '#00E676' };
}

async function fetchBatch(cities: City[]): Promise<AirStation[]> {
  const lats = cities.map(c => c.lat).join(',');
  const lngs = cities.map(c => c.lng).join(',');
  const url = `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${lats}&longitude=${lngs}&current=pm2_5,us_aqi`;

  const res = await fetch(url, {
    signal: AbortSignal.timeout(10000),
    headers: { Accept: 'application/json' },
  });

  if (!res.ok) throw new Error(`Open-Meteo responded ${res.status}`);
  const data = await res.json();

  // Open-Meteo returns array for multiple locations, single object for one
  const responses: any[] = Array.isArray(data) ? data : [data];

  const stations: AirStation[] = [];
  for (let i = 0; i < responses.length; i++) {
    const entry = responses[i];
    const city = cities[i];
    if (!city) continue;
    const pm25 = entry?.current?.pm2_5;
    if (pm25 == null || isNaN(pm25)) continue;

    const lastUpdated = entry?.current?.time ?? new Date().toISOString();
    const { level, color } = pm25ToLevel(pm25);

    stations.push({
      id: `aq-${city.name}`,
      name: city.name,
      city: city.name,
      country: city.country,
      lat: city.lat,
      lng: city.lng,
      pm25,
      unit: 'µg/m³',
      level,
      color,
      lastUpdated,
    });
  }

  return stations;
}

async function fetchAllCities(): Promise<AirStation[]> {
  const cities = WORLD_CITIES as City[];
  const batches: City[][] = [];
  for (let i = 0; i < cities.length; i += BATCH_SIZE) {
    batches.push(cities.slice(i, i + BATCH_SIZE));
  }

  const results = await Promise.allSettled(batches.map(batch => fetchBatch(batch)));

  const stations: AirStation[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      stations.push(...result.value);
    }
  }
  return stations;
}

export async function GET() {
  try {
    const now = Date.now();
    if (cache && now - cache.ts < CACHE_TTL_MS) {
      return NextResponse.json({
        stations: cache.stations,
        total: cache.stations.length,
        timestamp: new Date(cache.ts).toISOString(),
      });
    }

    const stations = await fetchAllCities();
    cache = { ts: now, stations };

    return NextResponse.json({
      stations,
      total: stations.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Air Quality API error:', error);
    return NextResponse.json({ stations: [], error: 'Failed to fetch air quality data' }, { status: 500 });
  }
}
