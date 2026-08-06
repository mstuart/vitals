import { describe, expect, it } from 'vitest';
import { rollingBaseline, snapshot, trend } from '../../src/analyze/baseline.js';
import type { DailyValue, DateRange, Store } from '../../src/store/api.js';
import { METRICS } from '../../src/types.js';

describe('rollingBaseline', () => {
  it('excludes the asOf day: a spike on asOf does not affect the baseline mean', () => {
    const series: DailyValue[] = [
      { date: '2026-07-01', value: 60 },
      { date: '2026-07-02', value: 62 },
      { date: '2026-07-03', value: 61 },
      { date: '2026-07-04', value: 63 },
      { date: '2026-07-05', value: 200 }, // spike ON the asOf day itself
    ];
    const baseline = rollingBaseline(series, '2026-07-05', 30, METRICS.restingHeartRate);
    expect(baseline).not.toBeNull();
    expect(baseline?.n).toBe(4);
    expect(baseline?.mean).toBeCloseTo((60 + 62 + 61 + 63) / 4, 6);
  });

  it('returns null when fewer than 3 days contributed', () => {
    const series: DailyValue[] = [
      { date: '2026-07-03', value: 61 },
      { date: '2026-07-04', value: 63 },
    ];
    expect(rollingBaseline(series, '2026-07-05', 30, METRICS.restingHeartRate)).toBeNull();
  });

  it('returns a baseline with n=3 when exactly 3 days contributed', () => {
    const series: DailyValue[] = [
      { date: '2026-07-02', value: 60 },
      { date: '2026-07-03', value: 61 },
      { date: '2026-07-04', value: 62 },
    ];
    const baseline = rollingBaseline(series, '2026-07-05', 30, METRICS.restingHeartRate);
    expect(baseline).not.toBeNull();
    expect(baseline?.n).toBe(3);
  });

  it('does not zero-fill gaps or let them drag the mean down', () => {
    const series: DailyValue[] = [
      { date: '2026-07-01', value: 60 },
      // gaps on 07-02, 07-04 (no observation those days)
      { date: '2026-07-03', value: 60 },
      { date: '2026-07-05', value: 60 },
    ];
    const baseline = rollingBaseline(series, '2026-07-06', 5, METRICS.restingHeartRate);
    expect(baseline).not.toBeNull();
    expect(baseline?.n).toBe(3); // not 5 - gaps are not zero-value days
    expect(baseline?.mean).toBe(60); // if gaps counted as 0, mean would be 36
  });

  it('sets Baseline.n to the true contributing count and computes sample stddev', () => {
    const series: DailyValue[] = [
      { date: '2026-07-01', value: 58 },
      { date: '2026-07-02', value: 60 },
      { date: '2026-07-03', value: 62 },
      { date: '2026-07-04', value: 64 },
    ];
    const baseline = rollingBaseline(series, '2026-07-05', 30, METRICS.restingHeartRate);
    expect(baseline?.n).toBe(4);
    // mean = 61, sample variance = sum((x-61)^2)/(4-1) = (9+1+1+9)/3 = 20/3
    expect(baseline?.mean).toBeCloseTo(61, 6);
    expect(baseline?.stddev).toBeCloseTo(Math.sqrt(20 / 3), 6);
  });
});

describe('trend', () => {
  it('is rising when the recent half is meaningfully higher than the older half', () => {
    const series: DailyValue[] = [
      { date: '2026-07-01', value: 50 },
      { date: '2026-07-02', value: 50 },
      { date: '2026-07-03', value: 50 },
      { date: '2026-07-04', value: 60 },
      { date: '2026-07-05', value: 60 },
      { date: '2026-07-06', value: 60 },
    ];
    expect(trend(series, 6)).toBe('rising');
  });

  it('is falling when the recent half is meaningfully lower than the older half', () => {
    const series: DailyValue[] = [
      { date: '2026-07-01', value: 60 },
      { date: '2026-07-02', value: 60 },
      { date: '2026-07-03', value: 60 },
      { date: '2026-07-04', value: 50 },
      { date: '2026-07-05', value: 50 },
      { date: '2026-07-06', value: 50 },
    ];
    expect(trend(series, 6)).toBe('falling');
  });

  it('is flat when the change is under 2% of the older mean', () => {
    const series: DailyValue[] = [
      { date: '2026-07-01', value: 100 },
      { date: '2026-07-02', value: 100 },
      { date: '2026-07-03', value: 100 },
      { date: '2026-07-04', value: 101 }, // 1% higher
      { date: '2026-07-05', value: 101 },
      { date: '2026-07-06', value: 101 },
    ];
    expect(trend(series, 6)).toBe('flat');
  });

  it('does not zero-fill gaps when slicing the recent window', () => {
    const series: DailyValue[] = [
      { date: '2026-07-01', value: 50 },
      // gaps on 07-02, 07-03 (no observation)
      { date: '2026-07-04', value: 50 },
      { date: '2026-07-05', value: 60 },
      { date: '2026-07-06', value: 60 },
    ];
    // only 4 contributing points exist even though `days` asks for 6; the
    // split is 2 older / 2 newer over those 4 points, not 6 calendar days.
    // A zero-fill bug would drag the older mean toward 0 and misreport this.
    expect(trend(series, 6)).toBe('rising');
  });

  it('returns null with fewer than 2 contributing points', () => {
    expect(trend([{ date: '2026-07-01', value: 60 }], 6)).toBeNull();
    expect(trend([], 6)).toBeNull();
  });
});

/** Builds a Store fake exposing only dailySeries, backed by an in-memory map. */
function fakeStoreFromSeries(data: Record<string, number>): Store {
  const partial: Pick<Store, 'dailySeries'> = {
    dailySeries: (_metric, range: DateRange): DailyValue[] =>
      Object.entries(data)
        .filter(([date]) => date >= range.from && date <= range.to)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([date, value]) => ({ date, value })),
  };
  return partial as unknown as Store;
}

describe('snapshot', () => {
  it('assembles value, baseline, delta, deltaPct, and trend from the store', () => {
    const store = fakeStoreFromSeries({
      '2026-07-01': 60,
      '2026-07-02': 60,
      '2026-07-03': 60,
      '2026-07-04': 60,
      '2026-07-05': 66, // the asOf day itself
    });
    const snap = snapshot(store, METRICS.restingHeartRate, '2026-07-05', 4);
    expect(snap.metric).toBe(METRICS.restingHeartRate);
    expect(snap.date).toBe('2026-07-05');
    expect(snap.value).toBe(66);
    expect(snap.baseline?.mean).toBe(60);
    expect(snap.baseline?.n).toBe(4);
    expect(snap.delta).toBeCloseTo(6, 6);
    expect(snap.deltaPct).toBeCloseTo(0.1, 6);
  });

  it('returns null value/baseline/delta/deltaPct when the store has no data', () => {
    const store = fakeStoreFromSeries({});
    const snap = snapshot(store, METRICS.restingHeartRate, '2026-07-05', 30);
    expect(snap.value).toBeNull();
    expect(snap.baseline).toBeNull();
    expect(snap.delta).toBeNull();
    expect(snap.deltaPct).toBeNull();
    expect(snap.trend).toBeNull();
  });

  it('leaves deltaPct null when the baseline mean is 0 even if delta is known', () => {
    const store = fakeStoreFromSeries({
      '2026-07-01': 0,
      '2026-07-02': 0,
      '2026-07-03': 0,
      '2026-07-05': 5,
    });
    const snap = snapshot(store, METRICS.restingHeartRate, '2026-07-05', 4);
    expect(snap.delta).toBeCloseTo(5, 6);
    expect(snap.deltaPct).toBeNull();
  });
});
