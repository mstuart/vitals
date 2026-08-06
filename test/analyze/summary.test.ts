import { describe, expect, it } from 'vitest';
import { dailySummary, WINDOW_DAYS } from '../../src/analyze/summary.js';
import type { DailyValue, DateRange, Store } from '../../src/store/api.js';
import type { Checkin, MetricId, SleepSession } from '../../src/types.js';
import { METRICS } from '../../src/types.js';
import { addDays } from '../../src/util/time.js';

const ASOF = '2026-07-31';

/** Flat baseline series for `WINDOW_DAYS`+ days ending at ASOF, with per-date overrides. */
function buildSeries(baselineValue: number, overrides: Record<string, number>): DailyValue[] {
  const from = addDays(ASOF, -(WINDOW_DAYS + 5));
  const days: DailyValue[] = [];
  let d = from;
  while (d <= ASOF) {
    days.push({ date: d, value: overrides[d] ?? baselineValue });
    d = addDays(d, 1);
  }
  return days;
}

interface StoreConfig {
  rhr?: Record<string, number>;
  hrv?: Record<string, number>;
  skinTemp?: Record<string, number>;
  respRate?: Record<string, number>;
  sleep?: SleepSession | null;
  checkin?: Checkin | null;
}

function makeStore(config: StoreConfig): Store {
  const series: Partial<Record<MetricId, DailyValue[]>> = {
    [METRICS.restingHeartRate]: buildSeries(60, config.rhr ?? {}),
    [METRICS.hrvDailyAvg]: buildSeries(50, config.hrv ?? {}),
    [METRICS.spo2Avg]: buildSeries(97, {}),
    [METRICS.skinTempNightly]: buildSeries(33.0, config.skinTemp ?? {}),
    [METRICS.respiratoryRate]: buildSeries(14, config.respRate ?? {}),
  };

  const partial: Pick<Store, 'dailySeries' | 'sleepSession' | 'checkin'> = {
    dailySeries: (metric: MetricId, range: DateRange): DailyValue[] =>
      (series[metric] ?? []).filter((d) => d.date >= range.from && d.date <= range.to),
    sleepSession: (_date: string) => config.sleep ?? null,
    checkin: (_date: string) => config.checkin ?? null,
  };
  return partial as unknown as Store;
}

describe('dailySummary', () => {
  it('populates snapshots, sleep session, and checkin from the store', () => {
    const sleep: SleepSession = {
      naturalKey: 'sleep-1',
      date: ASOF,
      startTs: '2026-07-30T23:00:00.000Z',
      endTs: '2026-07-31T07:00:00.000Z',
      type: 'main',
      totalMinutes: 480,
      asleepMinutes: 450,
      awakeMinutes: 30,
      deepMinutes: 90,
      remMinutes: 100,
      lightMinutes: 260,
      efficiency: 0.9375,
      stages: [],
      platform: 'fitbit',
    };
    const checkin: Checkin = {
      date: ASOF,
      ts: '2026-07-31T08:00:00.000Z',
      mood: 7,
      note: null,
      tags: [],
    };
    const store = makeStore({ sleep, checkin });
    const summary = dailySummary(store, ASOF);

    expect(summary.date).toBe(ASOF);
    expect(summary.sleep).toEqual(sleep);
    expect(summary.checkin).toEqual(checkin);
    expect(summary.rhr.metric).toBe(METRICS.restingHeartRate);
    expect(summary.rhr.value).toBe(60);
    expect(summary.rhr.baseline?.mean).toBeCloseTo(60, 6);
    expect(summary.hrv.metric).toBe(METRICS.hrvDailyAvg);
    expect(summary.spo2.metric).toBe(METRICS.spo2Avg);
    expect(summary.respRate.metric).toBe(METRICS.respiratoryRate);
    expect(summary.skinTemp.metric).toBe(METRICS.skinTempNightly);
  });

  it('multiMarker is false with exactly 1 red flag', () => {
    const store = makeStore({ rhr: { [ASOF]: 65 } }); // baseline 60, +5 -> red
    const summary = dailySummary(store, ASOF);
    expect(summary.flags.filter((f) => f.level === 'red')).toHaveLength(1);
    expect(summary.multiMarker).toBe(false);
  });

  it('multiMarker is true with 2 agreeing red flags', () => {
    const store = makeStore({
      rhr: { [ASOF]: 65 }, // baseline 60, +5 -> red
      hrv: { [ASOF]: 35 }, // baseline 50, 35 < 0.8*50=40 -> red
    });
    const summary = dailySummary(store, ASOF);
    expect(summary.flags.filter((f) => f.level === 'red')).toHaveLength(2);
    expect(summary.multiMarker).toBe(true);
  });

  it('multiMarker is false with 3 yellow flags and no reds', () => {
    const store = makeStore({
      rhr: { [ASOF]: 62.5 }, // baseline 60, +2.5 -> yellow
      hrv: { [ASOF]: 42.5 }, // baseline 50, 0.85*50=42.5 -> yellow
      skinTemp: { [ASOF]: 33.7 }, // baseline 33.0, +0.7, n=30 -> yellow
    });
    const summary = dailySummary(store, ASOF);
    expect(summary.flags.filter((f) => f.level === 'yellow')).toHaveLength(3);
    expect(summary.flags.filter((f) => f.level === 'red')).toHaveLength(0);
    expect(summary.multiMarker).toBe(false);
  });

  it('wires the resp-rate consecutive-night rule through to a red flag', () => {
    const prevDate = addDays(ASOF, -1);
    const store = makeStore({
      respRate: { [ASOF]: 17, [prevDate]: 17 }, // baseline 14, +3 both nights
    });
    const summary = dailySummary(store, ASOF);
    const respFlags = summary.flags.filter((f) => f.metric === METRICS.respiratoryRate);
    expect(respFlags).toHaveLength(1);
    expect(respFlags[0]?.level).toBe('red');
  });

  it('suppresses skin-temp flags when local history is under 30 days, even in the full summary', () => {
    // Truncate the skin-temp series so the baseline window has < 30 contributing days.
    const historyStart = addDays(ASOF, -10);
    const base = makeStore({});
    const partial: Pick<Store, 'dailySeries' | 'sleepSession' | 'checkin'> = {
      dailySeries: (metric: MetricId, range: DateRange): DailyValue[] => {
        if (metric !== METRICS.skinTempNightly) return base.dailySeries(metric, range);
        const days: DailyValue[] = [];
        let d = historyStart > range.from ? historyStart : range.from;
        while (d <= range.to) {
          days.push({ date: d, value: d === ASOF ? 40.0 : 33.0 }); // huge deviation on ASOF
          d = addDays(d, 1);
        }
        return days;
      },
      sleepSession: () => null,
      checkin: () => null,
    };
    const store = partial as unknown as Store;
    const summary = dailySummary(store, ASOF);
    expect(summary.flags.filter((f) => f.metric === METRICS.skinTempNightly)).toHaveLength(0);
  });
});
