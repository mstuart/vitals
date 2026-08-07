import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { ApiDataPoint, ApiDataPointsResponse } from '../../src/types.js';
import { METRICS } from '../../src/types.js';
import {
  dailyHeartRateVariabilitySpec,
  dailyRestingHeartRateSpec,
  dailyOxygenSaturationSpec,
  dailyRespiratoryRateSpec,
  dailySleepTemperatureDerivationsSpec,
  respiratoryRateSleepSummarySpec,
} from '../../src/datatypes/daily.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '..', 'fixtures', 'api');

function loadFixture(id: string): ApiDataPoint[] {
  const raw = readFileSync(join(FIXTURES_DIR, `${id}.json`), 'utf8');
  const parsed = JSON.parse(raw) as ApiDataPointsResponse;
  return parsed.dataPoints ?? [];
}

describe('dailyRestingHeartRateSpec', () => {
  const points = loadFixture('daily-resting-heart-rate');

  it('parses beatsPerMinute string into a numeric rhr observation', () => {
    const batch = dailyRestingHeartRateSpec.parse(points);
    expect(batch.observations.length).toBeGreaterThan(0);
    const first = batch.observations[0];
    expect(first).toBeDefined();
    expect(first?.metric).toBe(METRICS.restingHeartRate);
    expect(first?.unit).toBe('bpm');
    expect(typeof first?.value).toBe('number');
    expect(Number.isFinite(first?.value)).toBe(true);
    // The API sends this as a JSON string; it must arrive as a number equal to
    // the raw value, whatever that value happens to be in the fixture.
    const raw = (points[0]?.dailyRestingHeartRate as { beatsPerMinute?: string } | undefined)
      ?.beatsPerMinute;
    expect(typeof raw).toBe('string');
    expect(first?.value).toBe(Number(raw));
  });

  it('uses the date as ts:null with naturalKey equal to date', () => {
    const batch = dailyRestingHeartRateSpec.parse(points);
    for (const obs of batch.observations) {
      expect(obs.ts).toBeNull();
      expect(obs.naturalKey).toBe(obs.date);
      expect(obs.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('parse([]) returns an empty batch and does not throw', () => {
    expect(() => dailyRestingHeartRateSpec.parse([])).not.toThrow();
    const batch = dailyRestingHeartRateSpec.parse([]);
    expect(batch.observations).toEqual([]);
    expect(batch.sleepSessions).toEqual([]);
  });

  it('does not throw on a malformed point missing the payload', () => {
    const malformed: ApiDataPoint[] = [{ dataSource: { platform: 'FITBIT' } }];
    expect(() => dailyRestingHeartRateSpec.parse(malformed)).not.toThrow();
    expect(dailyRestingHeartRateSpec.parse(malformed).observations).toEqual([]);
  });

  it('naturalKey is stable across repeated parses of the same fixture', () => {
    const keysA = dailyRestingHeartRateSpec.parse(points).observations.map((o) => o.naturalKey);
    const keysB = dailyRestingHeartRateSpec.parse(points).observations.map((o) => o.naturalKey);
    expect(keysA).toEqual(keysB);
  });

  it('newestTimestamp returns the newest date as an ISO instant', () => {
    const newest = dailyRestingHeartRateSpec.newestTimestamp(points);
    expect(newest).not.toBeNull();
    expect(newest).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
  });
});

describe('dailyHeartRateVariabilitySpec', () => {
  const points = loadFixture('daily-heart-rate-variability');

  it('emits all four metrics with plausible values, coercing string fields', () => {
    const batch = dailyHeartRateVariabilitySpec.parse(points);
    // Assert against whichever day the fixture happens to hold rather than a
    // pinned date, so re-recording the fixture cannot break the test.
    const day = batch.observations[0]?.date;
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const byMetric = new Map(
      batch.observations.filter((o) => o.date === day).map((o) => [o.metric, o]),
    );

    const avg = byMetric.get(METRICS.hrvDailyAvg);
    expect(avg?.value).toBeGreaterThan(0);
    expect(avg?.value).toBeLessThan(200);
    expect(avg?.unit).toBe('ms');

    const deep = byMetric.get(METRICS.hrvDeepSleep);
    expect(deep?.value).toBeGreaterThan(0);
    expect(deep?.unit).toBe('ms');

    // Source is a JSON string like "65" — must come out as a number.
    const nonRem = byMetric.get(METRICS.nonRemHeartRate);
    expect(typeof nonRem?.value).toBe('number');
    expect(nonRem?.value).toBeGreaterThan(30);
    expect(nonRem?.value).toBeLessThan(120);
    expect(nonRem?.unit).toBe('bpm');

    const entropy = byMetric.get(METRICS.hrvEntropy);
    expect(typeof entropy?.value).toBe('number');
    expect(entropy?.unit).toBe('');
  });

  it('parse([]) returns an empty batch and does not throw', () => {
    expect(() => dailyHeartRateVariabilitySpec.parse([])).not.toThrow();
    expect(dailyHeartRateVariabilitySpec.parse([]).observations).toEqual([]);
  });

  it('does not throw on a malformed point', () => {
    expect(() => dailyHeartRateVariabilitySpec.parse([{}])).not.toThrow();
  });

  it('naturalKey is stable across repeated parses', () => {
    const a = dailyHeartRateVariabilitySpec.parse(points).observations.map((o) => o.naturalKey);
    const b = dailyHeartRateVariabilitySpec.parse(points).observations.map((o) => o.naturalKey);
    expect(a).toEqual(b);
  });
});

describe('dailyOxygenSaturationSpec', () => {
  const points = loadFixture('daily-oxygen-saturation');

  it('parses average/lower/upper percentages with plausible values', () => {
    const batch = dailyOxygenSaturationSpec.parse(points);
    const day = batch.observations[0]?.date;
    const byMetric = new Map(
      batch.observations.filter((o) => o.date === day).map((o) => [o.metric, o]),
    );
    const avg = byMetric.get(METRICS.spo2Avg)?.value;
    const lower = byMetric.get(METRICS.spo2Lower)?.value;
    const upper = byMetric.get(METRICS.spo2Upper)?.value;
    for (const v of [avg, lower, upper]) {
      expect(v).toBeGreaterThan(70);
      expect(v).toBeLessThanOrEqual(100);
    }
    // The bounds must bracket the average, whatever the recording.
    expect(lower!).toBeLessThanOrEqual(avg!);
    expect(upper!).toBeGreaterThanOrEqual(avg!);
    for (const obs of batch.observations) {
      expect(obs.unit).toBe('pct');
    }
  });

  it('drops readings at or below the 70 artifact threshold', () => {
    const artifactPoint: ApiDataPoint = {
      dataSource: { platform: 'FITBIT' },
      dailyOxygenSaturation: {
        date: { year: 2026, month: 1, day: 1 },
        averagePercentage: 50,
        lowerBoundPercentage: 50,
        upperBoundPercentage: 70,
      },
    };
    const batch = dailyOxygenSaturationSpec.parse([artifactPoint]);
    expect(batch.observations).toEqual([]);
  });

  it('keeps a genuine desaturation in the 70s', () => {
    const lowButReal: ApiDataPoint = {
      dataSource: { platform: 'FITBIT' },
      dailyOxygenSaturation: {
        date: { year: 2026, month: 1, day: 1 },
        averagePercentage: 88,
        lowerBoundPercentage: 71,
        upperBoundPercentage: 92,
      },
    };
    const batch = dailyOxygenSaturationSpec.parse([lowButReal]);
    const byMetric = new Map(batch.observations.map((o) => [o.metric, o]));
    expect(byMetric.get(METRICS.spo2Lower)?.value).toBe(71);
    expect(byMetric.get(METRICS.spo2Avg)?.value).toBe(88);
  });

  it('parse([]) returns an empty batch and does not throw', () => {
    expect(() => dailyOxygenSaturationSpec.parse([])).not.toThrow();
    expect(dailyOxygenSaturationSpec.parse([]).observations).toEqual([]);
  });

  it('does not throw on a malformed point', () => {
    expect(() => dailyOxygenSaturationSpec.parse([{ dataSource: {} }])).not.toThrow();
  });

  it('naturalKey is stable across repeated parses', () => {
    const a = dailyOxygenSaturationSpec.parse(points).observations.map((o) => o.naturalKey);
    const b = dailyOxygenSaturationSpec.parse(points).observations.map((o) => o.naturalKey);
    expect(a).toEqual(b);
  });
});

describe('dailyRespiratoryRateSpec', () => {
  const points = loadFixture('daily-respiratory-rate');

  it('parses breathsPerMinute into resp_rate observations', () => {
    const batch = dailyRespiratoryRateSpec.parse(points);
    const first = batch.observations[0];
    expect(first?.metric).toBe(METRICS.respiratoryRate);
    expect(first?.value).toBeGreaterThan(4);
    expect(first?.value).toBeLessThan(40);
    expect(first?.unit).toBe('brpm');
  });

  it('parse([]) returns an empty batch and does not throw', () => {
    expect(() => dailyRespiratoryRateSpec.parse([])).not.toThrow();
    expect(dailyRespiratoryRateSpec.parse([]).observations).toEqual([]);
  });

  it('does not throw on a malformed point', () => {
    expect(() => dailyRespiratoryRateSpec.parse([{ foo: 'bar' }])).not.toThrow();
  });

  it('naturalKey is stable across repeated parses', () => {
    const a = dailyRespiratoryRateSpec.parse(points).observations.map((o) => o.naturalKey);
    const b = dailyRespiratoryRateSpec.parse(points).observations.map((o) => o.naturalKey);
    expect(a).toEqual(b);
  });
});

describe('dailySleepTemperatureDerivationsSpec', () => {
  const points = loadFixture('daily-sleep-temperature-derivations');

  it('parses nightly, baseline, and stddev temperatures in Celsius', () => {
    const batch = dailySleepTemperatureDerivationsSpec.parse(points);
    const day = batch.observations[0]?.date;
    const byMetric = new Map(
      batch.observations.filter((o) => o.date === day).map((o) => [o.metric, o]),
    );
    const nightly = byMetric.get(METRICS.skinTempNightly);
    // Skin temperature, so well below core body temperature.
    expect(nightly?.value).toBeGreaterThan(25);
    expect(nightly?.value).toBeLessThan(40);
    expect(nightly?.unit).toBe('C');

    const baseline = byMetric.get(METRICS.skinTempBaseline);
    expect(baseline?.value).toBeGreaterThan(25);
    expect(baseline?.value).toBeLessThan(40);
    expect(baseline?.unit).toBe('C');

    // A relative standard deviation, so a small positive number.
    const stddev = byMetric.get(METRICS.skinTempStddev30d);
    expect(stddev?.value).toBeGreaterThan(0);
    expect(stddev?.value).toBeLessThan(5);
  });

  it('produces NO baseline observation when baselineTemperatureCelsius is NaN', () => {
    const earlyHistoryPoint: ApiDataPoint = {
      dataSource: { platform: 'FITBIT' },
      dailySleepTemperatureDerivations: {
        date: { year: 2026, month: 1, day: 1 },
        nightlyTemperatureCelsius: 32.1,
        baselineTemperatureCelsius: NaN,
        relativeNightlyStddev30dCelsius: 0.4,
      },
    };
    const batch = dailySleepTemperatureDerivationsSpec.parse([earlyHistoryPoint]);
    const metrics = batch.observations.map((o) => o.metric);
    expect(metrics).not.toContain(METRICS.skinTempBaseline);
    // The other two fields on the same point are unaffected.
    expect(metrics).toContain(METRICS.skinTempNightly);
    expect(metrics).toContain(METRICS.skinTempStddev30d);
  });

  it('produces NO baseline observation when baselineTemperatureCelsius is absent', () => {
    const noBaseline: ApiDataPoint = {
      dataSource: { platform: 'FITBIT' },
      dailySleepTemperatureDerivations: {
        date: { year: 2026, month: 1, day: 2 },
        nightlyTemperatureCelsius: 32.1,
        relativeNightlyStddev30dCelsius: 0.4,
      },
    };
    const batch = dailySleepTemperatureDerivationsSpec.parse([noBaseline]);
    expect(batch.observations.map((o) => o.metric)).not.toContain(METRICS.skinTempBaseline);
  });

  it('parse([]) returns an empty batch and does not throw', () => {
    expect(() => dailySleepTemperatureDerivationsSpec.parse([])).not.toThrow();
    expect(dailySleepTemperatureDerivationsSpec.parse([]).observations).toEqual([]);
  });

  it('does not throw on a malformed point', () => {
    expect(() => dailySleepTemperatureDerivationsSpec.parse([{ dailySleepTemperatureDerivations: null }])).not.toThrow();
  });

  it('naturalKey is stable across repeated parses', () => {
    const a = dailySleepTemperatureDerivationsSpec.parse(points).observations.map((o) => o.naturalKey);
    const b = dailySleepTemperatureDerivationsSpec.parse(points).observations.map((o) => o.naturalKey);
    expect(a).toEqual(b);
  });
});

describe('respiratoryRateSleepSummarySpec', () => {
  const points = loadFixture('respiratory-rate-sleep-summary');

  /** Local day of the first fixture point whose REM reading is 0 / non-zero. */
  function dayWithRem(zero: boolean): string {
    for (const p of points) {
      const payload = p.respiratoryRateSleepSummary as
        | { remSleepStats?: { breathsPerMinute?: number }; sampleTime?: { civilTime?: { date?: { year: number; month: number; day: number } } } }
        | undefined;
      const rem = payload?.remSleepStats?.breathsPerMinute ?? 0;
      const d = payload?.sampleTime?.civilTime?.date;
      if (!d) continue;
      if (zero === (rem === 0)) {
        return `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}`;
      }
    }
    throw new Error(`fixture has no point with a ${zero ? 'zero' : 'non-zero'} REM reading`);
  }

  it('emits full/deep/light metrics and skips a zero REM reading', () => {
    const batch = respiratoryRateSleepSummarySpec.parse(points);
    // A remSleepStats.breathsPerMinute of 0 means "not detected", not a real
    // measurement, so it must produce no observation.
    const day = dayWithRem(true);
    const onDay = batch.observations.filter((o) => o.date === day);
    const metrics = onDay.map((o) => o.metric);
    expect(metrics).toContain(METRICS.respRateFullSleep);
    expect(metrics).toContain(METRICS.respRateDeepSleep);
    expect(metrics).toContain(METRICS.respRateLightSleep);
    expect(metrics).not.toContain(METRICS.respRateRemSleep);

    const full = onDay.find((o) => o.metric === METRICS.respRateFullSleep);
    expect(full?.value).toBeGreaterThan(0);
    expect(full?.unit).toBe('brpm');
    expect(full?.naturalKey).toBe(day);
    expect(full?.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('keeps a genuine non-zero REM reading', () => {
    const day = dayWithRem(false);
    const onDay = batch(points).filter((o) => o.date === day);
    const rem = onDay.find((o) => o.metric === METRICS.respRateRemSleep);
    expect(rem?.value).toBeGreaterThan(0);
    expect(rem?.unit).toBe('brpm');
  });

  it('parse([]) returns an empty batch and does not throw', () => {
    expect(() => respiratoryRateSleepSummarySpec.parse([])).not.toThrow();
    expect(respiratoryRateSleepSummarySpec.parse([]).observations).toEqual([]);
  });

  it('does not throw on a malformed point missing the payload', () => {
    expect(() => respiratoryRateSleepSummarySpec.parse([{ name: 'x' }])).not.toThrow();
    expect(respiratoryRateSleepSummarySpec.parse([{ name: 'x' }]).observations).toEqual([]);
  });

  it('does not throw on a point missing sampleTime', () => {
    const noSampleTime: ApiDataPoint = {
      respiratoryRateSleepSummary: {
        fullSleepStats: { breathsPerMinute: 14 },
      },
    };
    expect(() => respiratoryRateSleepSummarySpec.parse([noSampleTime])).not.toThrow();
    expect(respiratoryRateSleepSummarySpec.parse([noSampleTime]).observations).toEqual([]);
  });

  it('naturalKey is stable across repeated parses', () => {
    const a = respiratoryRateSleepSummarySpec.parse(points).observations.map((o) => o.naturalKey);
    const b = respiratoryRateSleepSummarySpec.parse(points).observations.map((o) => o.naturalKey);
    expect(a).toEqual(b);
  });

  function batch(pts: ApiDataPoint[]) {
    return respiratoryRateSleepSummarySpec.parse(pts).observations;
  }
});

describe('dailyHeartRateVariabilitySpec zero handling', () => {
  it('drops a zero deep-sleep HRV as "not measured", keeping the other metrics', () => {
    const point: ApiDataPoint = {
      dataSource: { platform: 'FITBIT' },
      dailyHeartRateVariability: {
        date: { year: 2026, month: 3, day: 17 },
        averageHeartRateVariabilityMilliseconds: 34.9,
        deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: 0,
        nonRemHeartRateBeatsPerMinute: '65',
        entropy: 2.5,
      },
    };
    const metrics = dailyHeartRateVariabilitySpec.parse([point]).observations.map((o) => o.metric);
    expect(metrics).not.toContain(METRICS.hrvDeepSleep);
    expect(metrics).toContain(METRICS.hrvDailyAvg);
    expect(metrics).toContain(METRICS.nonRemHeartRate);
  });

  it('keeps a genuine non-zero deep-sleep HRV', () => {
    const point: ApiDataPoint = {
      dataSource: { platform: 'FITBIT' },
      dailyHeartRateVariability: {
        date: { year: 2026, month: 8, day: 6 },
        averageHeartRateVariabilityMilliseconds: 22.1,
        deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: 17.2,
      },
    };
    const obs = dailyHeartRateVariabilitySpec.parse([point]).observations;
    expect(obs.find((o) => o.metric === METRICS.hrvDeepSleep)?.value).toBe(17.2);
  });
});
