import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  stepsSpec,
  distanceSpec,
  activeZoneMinutesSpec,
  activeEnergyBurnedSpec,
} from '../../src/datatypes/intervals.js';
import type { ApiDataPoint, ApiDataPointsResponse } from '../../src/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): ApiDataPoint[] {
  const raw = readFileSync(
    path.join(__dirname, '..', 'fixtures', 'api', `${name}.json`),
    'utf-8',
  );
  const parsed = JSON.parse(raw) as ApiDataPointsResponse;
  return parsed.dataPoints ?? [];
}

describe('stepsSpec', () => {
  const points = loadFixture('steps');

  it('supports date filtering', () => {
    expect(stepsSpec.supportsDateFilter).toBe(true);
    expect(stepsSpec.filterField).toBe('steps.interval.start_time');
  });

  it('parses an empty page without error', () => {
    const batch = stepsSpec.parse([]);
    expect(batch.observations).toEqual([]);
  });

  it('does not throw on a malformed point', () => {
    const malformed: ApiDataPoint[] = [
      { steps: {} } as unknown as ApiDataPoint,
      { steps: null } as unknown as ApiDataPoint,
      {} as ApiDataPoint,
    ];
    expect(() => stepsSpec.parse(malformed)).not.toThrow();
    expect(stepsSpec.parse(malformed).observations).toEqual([]);
  });

  it('parses the string count field into a number', () => {
    const batch = stepsSpec.parse(points);
    expect(batch.observations.length).toBeGreaterThan(0);
    for (const obs of batch.observations) {
      expect(typeof obs.value).toBe('number');
      expect(Number.isFinite(obs.value)).toBe(true);
      expect(obs.unit).toBe('count');
      expect(obs.metric).toBe('steps');
    }
  });

  it('newestTimestamp returns the latest interval start in the page', () => {
    expect(stepsSpec.newestTimestamp(points)).not.toBeNull();
    expect(stepsSpec.newestTimestamp([])).toBeNull();
  });
});

describe('distanceSpec', () => {
  const points = loadFixture('distance');

  it('supports date filtering', () => {
    expect(distanceSpec.supportsDateFilter).toBe(true);
    expect(distanceSpec.filterField).toBe('distance.interval.start_time');
  });

  it('parses an empty page without error', () => {
    expect(distanceSpec.parse([]).observations).toEqual([]);
  });

  it('does not throw on a malformed point', () => {
    const malformed: ApiDataPoint[] = [
      { distance: {} } as unknown as ApiDataPoint,
      { distance: null } as unknown as ApiDataPoint,
      {} as ApiDataPoint,
    ];
    expect(() => distanceSpec.parse(malformed)).not.toThrow();
    expect(distanceSpec.parse(malformed).observations).toEqual([]);
  });

  it('converts millimeters to metres, and daily distance is plausible', () => {
    const batch = distanceSpec.parse(points);
    expect(batch.observations.length).toBeGreaterThan(0);

    const byDate = new Map<string, number>();
    for (const obs of batch.observations) {
      expect(obs.unit).toBe('m');
      byDate.set(obs.date, (byDate.get(obs.date) ?? 0) + obs.value);
    }
    for (const total of byDate.values()) {
      expect(total).toBeLessThan(200000);
    }

    // The millimetres-to-metres conversion, checked against the raw fixture
    // value rather than a pinned constant.
    const raw = (points[0]?.distance as { millimeters?: number | string } | undefined)?.millimeters;
    expect(raw).toBeDefined();
    expect(batch.observations[0]?.value).toBeCloseTo(Number(raw) / 1000, 6);
  });
});

describe('activeEnergyBurnedSpec', () => {
  const points = loadFixture('active-energy-burned');

  it('supports date filtering', () => {
    expect(activeEnergyBurnedSpec.supportsDateFilter).toBe(true);
    expect(activeEnergyBurnedSpec.filterField).toBe('activeEnergyBurned.interval.start_time');
  });

  it('parses an empty page without error', () => {
    expect(activeEnergyBurnedSpec.parse([]).observations).toEqual([]);
  });

  it('does not throw on a malformed point', () => {
    const malformed: ApiDataPoint[] = [
      { activeEnergyBurned: {} } as unknown as ApiDataPoint,
      { activeEnergyBurned: null } as unknown as ApiDataPoint,
      {} as ApiDataPoint,
    ];
    expect(() => activeEnergyBurnedSpec.parse(malformed)).not.toThrow();
    expect(activeEnergyBurnedSpec.parse(malformed).observations).toEqual([]);
  });

  it('handles float kcal values, including zero', () => {
    const batch = activeEnergyBurnedSpec.parse(points);
    expect(batch.observations.length).toBeGreaterThan(0);
    for (const obs of batch.observations) {
      expect(obs.unit).toBe('kcal');
      expect(typeof obs.value).toBe('number');
    }
    const zero = batch.observations.find((o) => o.value === 0);
    expect(zero).toBeDefined();
  });

  it('handles string kcal values without crashing', () => {
    const point: ApiDataPoint = {
      activeEnergyBurned: {
        interval: { startTime: '2026-01-01T00:00:00Z' },
        kcal: '1.5',
      },
    } as unknown as ApiDataPoint;
    const batch = activeEnergyBurnedSpec.parse([point]);
    expect(batch.observations).toHaveLength(1);
    expect(batch.observations[0]!.value).toBe(1.5);
  });
});

describe('activeZoneMinutesSpec', () => {
  const points = loadFixture('active-zone-minutes');

  it('supports date filtering', () => {
    expect(activeZoneMinutesSpec.supportsDateFilter).toBe(true);
    expect(activeZoneMinutesSpec.filterField).toBe('activeZoneMinutes.interval.start_time');
  });

  it('parses an empty page without error', () => {
    expect(activeZoneMinutesSpec.parse([]).observations).toEqual([]);
  });

  it('does not throw on a malformed point', () => {
    const malformed: ApiDataPoint[] = [
      { activeZoneMinutes: {} } as unknown as ApiDataPoint,
      { activeZoneMinutes: null } as unknown as ApiDataPoint,
      {} as ApiDataPoint,
    ];
    expect(() => activeZoneMinutesSpec.parse(malformed)).not.toThrow();
    expect(activeZoneMinutesSpec.parse(malformed).observations).toEqual([]);
  });

  it('handles the string heartRateZone enum without crashing', () => {
    const batch = activeZoneMinutesSpec.parse(points);
    expect(batch.observations.length).toBeGreaterThan(0);
    for (const obs of batch.observations) {
      expect(obs.metric).toBe('azm');
      expect(obs.unit).toBe('min');
      expect(typeof obs.value).toBe('number');
    }
  });

  it('two zones in the same interval produce two distinct natural keys', () => {
    const fatBurn: ApiDataPoint = {
      activeZoneMinutes: {
        interval: { startTime: '2026-01-01T10:00:00Z' },
        heartRateZone: 'FAT_BURN',
        activeZoneMinutes: '1',
      },
    } as unknown as ApiDataPoint;
    const cardio: ApiDataPoint = {
      activeZoneMinutes: {
        interval: { startTime: '2026-01-01T10:00:00Z' },
        heartRateZone: 'CARDIO',
        activeZoneMinutes: '2',
      },
    } as unknown as ApiDataPoint;

    const batch = activeZoneMinutesSpec.parse([fatBurn, cardio]);
    expect(batch.observations).toHaveLength(2);
    const keys = batch.observations.map((o) => o.naturalKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).not.toBe(keys[1]);
  });
});
