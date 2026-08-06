import { describe, expect, it } from 'vitest';

import { openStore } from '../../src/store/sqlite.js';
import { emptyBatch } from '../../src/types.js';
import type { Observation, ParsedBatch, SleepSession } from '../../src/types.js';
import type { Store } from '../../src/store/api.js';
import {
  vitalsBody,
  vitalsCoverage,
  vitalsHeart,
  vitalsLogCheckin,
  vitalsSleep,
  vitalsToday,
  vitalsWeeklyReport,
} from '../../src/mcp/tools.js';

function obs(overrides: Partial<Observation> = {}): Observation {
  const date = overrides.date ?? '2026-06-01';
  const ts = overrides.ts ?? `${date}T08:00:00.000Z`;
  return {
    metric: 'rhr',
    date,
    ts,
    value: 55,
    unit: 'bpm',
    naturalKey: `${overrides.metric ?? 'rhr'}-${date}-${ts}`,
    platform: 'fitbit',
    recordingMethod: 'automatic',
    ...overrides,
  };
}

function sleepSession(overrides: Partial<SleepSession> = {}): SleepSession {
  return {
    naturalKey: `sleep-${overrides.date ?? '2026-06-01'}`,
    date: '2026-06-01',
    startTs: '2026-05-31T23:30:00.000Z',
    endTs: '2026-06-01T07:00:00.000Z',
    type: 'stages',
    totalMinutes: 450,
    asleepMinutes: 420,
    awakeMinutes: 30,
    deepMinutes: 90,
    remMinutes: 100,
    lightMinutes: 230,
    efficiency: 420 / 450,
    stages: [],
    platform: 'fitbit',
    ...overrides,
  };
}

function batchWith(partial: Partial<ParsedBatch>): ParsedBatch {
  return { ...emptyBatch(), ...partial };
}

/** Builds a store seeded with ~35 days of rhr/hrv/weight data ending on `to`. */
function seededStore(): Store {
  const store = openStore(':memory:');
  const observations: Observation[] = [];
  const dates = Array.from({ length: 35 }, (_, i) => {
    const d = new Date(Date.parse('2026-06-01T00:00:00Z') + i * 86400000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  });
  for (const date of dates) {
    observations.push(obs({ metric: 'rhr', date, ts: `${date}T08:00:00.000Z`, value: 55, unit: 'bpm' }));
    observations.push(
      obs({ metric: 'hrv_daily_avg', date, ts: `${date}T08:00:00.000Z`, value: 45, unit: 'ms' }),
    );
    observations.push(
      obs({ metric: 'weight_kg', date, ts: `${date}T07:00:00.000Z`, value: 80, unit: 'kg' }),
    );
  }
  // Give the last date an elevated RHR so a flag fires in vitals_today.
  const lastDate = dates[dates.length - 1] as string;
  observations.push(
    obs({ metric: 'rhr', date: lastDate, ts: `${lastDate}T09:00:00.000Z`, value: 65, unit: 'bpm', naturalKey: 'rhr-spike' }),
  );

  store.writeBatch(
    batchWith({
      observations,
      sleepSessions: [sleepSession({ date: lastDate, naturalKey: `sleep-${lastDate}` })],
    }),
  );
  return store;
}

const LAST_DATE = '2026-07-05'; // 2026-06-01 + 34 days

describe('vitals_today', () => {
  it('returns a DailySummary for the given date', async () => {
    const store = seededStore();
    const result = await vitalsToday(store, { date: LAST_DATE });
    store.close();

    expect(result.isError).toBeUndefined();
    const summary = result.structuredContent?.result as { date: string; flags: unknown[] };
    expect(summary.date).toBe(LAST_DATE);
    expect(Array.isArray(summary.flags)).toBe(true);
  });

  it('defaults to today when no date is given', async () => {
    const store = openStore(':memory:');
    const result = await vitalsToday(store, {});
    store.close();
    expect(result.isError).toBeUndefined();
  });

  it('rejects a malformed date', async () => {
    const store = openStore(':memory:');
    const result = await vitalsToday(store, { date: 'not-a-date' });
    store.close();
    expect(result.isError).toBe(true);
    const payload = result.structuredContent as { code: string };
    expect(payload.code).toBe('USAGE');
  });
});

describe('vitals_sleep', () => {
  it('returns sleep sessions in range', async () => {
    const store = seededStore();
    const result = await vitalsSleep(store, { from: '2026-06-01', to: LAST_DATE });
    store.close();

    expect(result.isError).toBeUndefined();
    const data = result.structuredContent?.result as { sessions: SleepSession[] };
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0]?.date).toBe(LAST_DATE);
  });
});

describe('vitals_heart', () => {
  it('returns rhr/hrv series with baselines', async () => {
    const store = seededStore();
    const result = await vitalsHeart(store, { from: '2026-06-01', to: LAST_DATE });
    store.close();

    expect(result.isError).toBeUndefined();
    const data = result.structuredContent?.result as {
      rhr: { series: unknown[]; baseline: { mean: number } | null };
      hrv: { series: unknown[]; baseline: { mean: number } | null };
    };
    expect(data.rhr.series.length).toBeGreaterThan(0);
    expect(data.rhr.baseline).not.toBeNull();
    expect(data.rhr.baseline?.mean).toBeCloseTo(55, 0);
    expect(data.hrv.baseline).not.toBeNull();
  });
});

describe('vitals_body', () => {
  it('returns weight/body-fat series', async () => {
    const store = seededStore();
    const result = await vitalsBody(store, { from: '2026-06-01', to: LAST_DATE });
    store.close();

    expect(result.isError).toBeUndefined();
    const data = result.structuredContent?.result as { weightKg: unknown[]; bodyFatPct: unknown[] };
    expect(data.weightKg.length).toBeGreaterThan(0);
    expect(data.bodyFatPct).toHaveLength(0);
  });
});

describe('vitals_weekly_report', () => {
  it('returns the rendered report text', async () => {
    const store = seededStore();
    const result = await vitalsWeeklyReport(store, { asOf: LAST_DATE, days: 7 });
    store.close();

    expect(result.isError).toBeUndefined();
    const data = result.structuredContent?.result as { report: string };
    expect(typeof data.report).toBe('string');
    expect(data.report).toContain('WEEKLY HEALTH REPORT');
  });

  it('reports no data on an empty store', async () => {
    const store = openStore(':memory:');
    const result = await vitalsWeeklyReport(store, { asOf: '2026-06-01' });
    store.close();

    expect(result.isError).toBeUndefined();
    const data = result.structuredContent?.result as { report: string };
    expect(data.report).toContain('No data available yet');
  });
});

describe('vitals_log_checkin', () => {
  it('records a valid check-in', async () => {
    const store = openStore(':memory:');
    const result = await vitalsLogCheckin(store, {
      date: '2026-06-01',
      mood: 7,
      note: 'felt good',
      tags: ['energetic'],
    });

    expect(result.isError).toBeUndefined();
    const checkin = result.structuredContent?.result as { mood: number; date: string; note: string | null };
    expect(checkin.mood).toBe(7);
    expect(checkin.date).toBe('2026-06-01');
    expect(checkin.note).toBe('felt good');

    expect(store.checkin('2026-06-01')?.mood).toBe(7);
    store.close();
  });

  it('rejects mood 0', async () => {
    const store = openStore(':memory:');
    const result = await vitalsLogCheckin(store, { mood: 0 });
    store.close();

    expect(result.isError).toBe(true);
    const payload = result.structuredContent as { code: string };
    expect(payload.code).toBe('USAGE');
  });

  it('rejects mood 11', async () => {
    const store = openStore(':memory:');
    const result = await vitalsLogCheckin(store, { mood: 11 });
    store.close();

    expect(result.isError).toBe(true);
    const payload = result.structuredContent as { code: string };
    expect(payload.code).toBe('USAGE');
  });
});

describe('vitals_coverage', () => {
  it('reports empty on an empty store rather than throwing', async () => {
    const store = openStore(':memory:');
    const result = await vitalsCoverage(store, {});
    store.close();

    expect(result.isError).toBeUndefined();
    const data = result.structuredContent?.result as { empty: boolean; from: string | null; to: string | null };
    expect(data.empty).toBe(true);
    expect(data.from).toBeNull();
    expect(data.to).toBeNull();
  });

  it('reports the actual date range on a seeded store', async () => {
    const store = seededStore();
    const result = await vitalsCoverage(store, {});
    store.close();

    expect(result.isError).toBeUndefined();
    const data = result.structuredContent?.result as { empty: boolean; from: string; to: string };
    expect(data.empty).toBe(false);
    expect(data.from).toBe('2026-06-01');
    expect(data.to).toBe(LAST_DATE);
  });
});
