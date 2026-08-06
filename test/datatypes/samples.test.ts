import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ApiDataPoint, ApiDataPointsResponse } from '../../src/types.js';
import {
  heartRateSpec,
  heartRateVariabilitySpec,
  weightSpec,
  bodyFatSpec,
} from '../../src/datatypes/samples.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(id: string): ApiDataPoint[] {
  const file = path.join(__dirname, '..', 'fixtures', 'api', `${id}.json`);
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as ApiDataPointsResponse;
  return parsed.dataPoints ?? [];
}

describe('heartRateSpec', () => {
  const points = loadFixture('heart-rate');

  it('does not support date filtering', () => {
    expect(heartRateSpec.supportsDateFilter).toBe(false);
    expect(heartRateSpec.filterField).toBeUndefined();
  });

  it('aggregates into hourly buckets and emits zero observations', () => {
    const batch = heartRateSpec.parse(points);
    expect(batch.observations).toHaveLength(0);
    expect(batch.heartRateHourly.length).toBeGreaterThan(0);
  });

  it('every bucket has min <= avg <= max and a positive sample count', () => {
    const batch = heartRateSpec.parse(points);
    for (const bucket of batch.heartRateHourly) {
      expect(bucket.sampleCount).toBeGreaterThan(0);
      expect(bucket.minBpm).toBeLessThanOrEqual(bucket.avgBpm);
      expect(bucket.avgBpm).toBeLessThanOrEqual(bucket.maxBpm);
      expect(bucket.naturalKey).toBe(bucket.hourTs);
      expect(bucket.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('produces identical bucket natural keys across two parses of the same fixture', () => {
    const batch1 = heartRateSpec.parse(points);
    const batch2 = heartRateSpec.parse(points);
    const keys1 = batch1.heartRateHourly.map((b) => b.naturalKey).sort();
    const keys2 = batch2.heartRateHourly.map((b) => b.naturalKey).sort();
    expect(keys1).toEqual(keys2);
  });

  it('handles empty input', () => {
    const batch = heartRateSpec.parse([]);
    expect(batch.heartRateHourly).toHaveLength(0);
    expect(batch.observations).toHaveLength(0);
  });

  it('never throws on malformed points', () => {
    const malformed: ApiDataPoint[] = [
      {},
      { heartRate: {} },
      { heartRate: { sampleTime: {}, beatsPerMinute: '84' } },
      { heartRate: { sampleTime: { physicalTime: 'not-a-date' }, beatsPerMinute: '84' } },
      { heartRate: { sampleTime: { physicalTime: '2026-08-05T19:00:00Z' }, beatsPerMinute: 'NaN' } },
      { heartRate: { sampleTime: { physicalTime: '2026-08-05T19:00:00Z' } } },
    ];
    expect(() => heartRateSpec.parse(malformed)).not.toThrow();
    const batch = heartRateSpec.parse(malformed);
    expect(batch.heartRateHourly).toHaveLength(0);
  });

  it('computes newestTimestamp from the fixture', () => {
    const newest = heartRateSpec.newestTimestamp(points);
    expect(newest).not.toBeNull();
  });
});

describe('heartRateVariabilitySpec', () => {
  const points = loadFixture('heart-rate-variability');

  it('does not support date filtering', () => {
    expect(heartRateVariabilitySpec.supportsDateFilter).toBe(false);
    expect(heartRateVariabilitySpec.filterField).toBeUndefined();
  });

  it('produces observations with numeric values', () => {
    const batch = heartRateVariabilitySpec.parse(points);
    expect(batch.observations.length).toBeGreaterThan(0);
    for (const obs of batch.observations) {
      expect(obs.metric).toBe('hrv_sample');
      expect(obs.unit).toBe('ms');
      expect(typeof obs.value).toBe('number');
      expect(Number.isFinite(obs.value)).toBe(true);
      expect(obs.naturalKey).toBe(obs.ts);
    }
    expect(batch.heartRateHourly).toHaveLength(0);
  });

  it('handles empty input and malformed points without throwing', () => {
    expect(heartRateVariabilitySpec.parse([]).observations).toHaveLength(0);
    const malformed: ApiDataPoint[] = [
      {},
      { heartRateVariability: {} },
      { heartRateVariability: { sampleTime: { physicalTime: 'garbage' } } },
    ];
    expect(() => heartRateVariabilitySpec.parse(malformed)).not.toThrow();
    expect(heartRateVariabilitySpec.parse(malformed).observations).toHaveLength(0);
  });
});

describe('weightSpec', () => {
  const points = loadFixture('weight');

  it('produces observations with numeric kg values in a plausible range', () => {
    const batch = weightSpec.parse(points);
    expect(batch.observations.length).toBeGreaterThan(0);
    for (const obs of batch.observations) {
      expect(obs.metric).toBe('weight_kg');
      expect(obs.unit).toBe('kg');
      expect(typeof obs.value).toBe('number');
      expect(obs.value).toBeGreaterThan(30);
      expect(obs.value).toBeLessThan(200);
      expect(obs.naturalKey).toBe(obs.ts);
    }
  });

  it('records platform for both FITBIT and HEALTH_KIT sources', () => {
    const batch = weightSpec.parse(points);
    const platforms = new Set(batch.observations.map((o) => o.platform));
    expect(platforms.size).toBeGreaterThan(0);
    for (const p of platforms) {
      expect(p).not.toBeNull();
    }
  });

  it('handles empty input and malformed points without throwing', () => {
    expect(weightSpec.parse([]).observations).toHaveLength(0);
    const malformed: ApiDataPoint[] = [
      {},
      { weight: {} },
      { weight: { sampleTime: { physicalTime: '2026-08-05T19:00:00Z' }, weightGrams: 'not-a-number' } },
    ];
    expect(() => weightSpec.parse(malformed)).not.toThrow();
    expect(weightSpec.parse(malformed).observations).toHaveLength(0);
  });
});

describe('bodyFatSpec', () => {
  const points = loadFixture('body-fat');

  it('produces observations with numeric percentage values', () => {
    const batch = bodyFatSpec.parse(points);
    expect(batch.observations.length).toBeGreaterThan(0);
    for (const obs of batch.observations) {
      expect(obs.metric).toBe('body_fat_pct');
      expect(obs.unit).toBe('pct');
      expect(typeof obs.value).toBe('number');
      expect(obs.value).toBeGreaterThan(0);
      expect(obs.value).toBeLessThan(100);
      expect(obs.naturalKey).toBe(obs.ts);
    }
  });

  it('handles empty input and malformed points without throwing', () => {
    expect(bodyFatSpec.parse([]).observations).toHaveLength(0);
    const malformed: ApiDataPoint[] = [{}, { bodyFat: {} }, { bodyFat: { sampleTime: {} } }];
    expect(() => bodyFatSpec.parse(malformed)).not.toThrow();
    expect(bodyFatSpec.parse(malformed).observations).toHaveLength(0);
  });
});
