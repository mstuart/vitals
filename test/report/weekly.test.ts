import { describe, expect, it } from 'vitest';

import { openStore } from '../../src/store/sqlite.js';
import { emptyBatch } from '../../src/types.js';
import type {
  HydrationEntry,
  NutritionEntry,
  Observation,
  ParsedBatch,
  SleepSession,
} from '../../src/types.js';
import { weeklyReport } from '../../src/report/weekly.js';
import { arrow, bar, center, fmt, rule, REPORT_WIDTH } from '../../src/report/render.js';

// ---------------------------------------------------------------------------
// render.ts primitives
// ---------------------------------------------------------------------------

describe('render primitives', () => {
  it('rule repeats the character to the exact width', () => {
    expect(rule(10)).toBe('──────────');
    expect(rule(5, '=')).toBe('=====');
    expect(rule(0)).toBe('');
  });

  it('center pads both sides and totals the requested width', () => {
    const out = center('HI', 6);
    expect(out).toHaveLength(6);
    expect(out.trim()).toBe('HI');
  });

  it('center returns text unchanged when it is already at or past width', () => {
    expect(center('too long already', 5)).toBe('too long already');
  });

  it('bar scales proportionally and clamps to width', () => {
    expect(bar(15, 30, 20)).toBe('█'.repeat(10));
    expect(bar(60, 30, 20)).toBe('█'.repeat(20)); // clamped at max
    expect(bar(0.001, 30, 20)).toBe('█'); // any positive value shows at least one block
  });

  it('bar renders nothing for non-positive or non-finite input', () => {
    expect(bar(0, 30, 20)).toBe('');
    expect(bar(-5, 30, 20)).toBe('');
    expect(bar(NaN, 30, 20)).toBe('');
  });

  it('arrow maps trend directions to glyphs and null to empty', () => {
    expect(arrow('rising')).toBe('↑');
    expect(arrow('falling')).toBe('↓');
    expect(arrow('flat')).toBe('→');
    expect(arrow(null)).toBe('');
  });

  it('fmt formats fixed-point and maps null/NaN to empty string', () => {
    expect(fmt(3.456, 1)).toBe('3.5');
    expect(fmt(70, 0)).toBe('70');
    expect(fmt(null)).toBe('');
    expect(fmt(NaN)).toBe('');
  });
});

// ---------------------------------------------------------------------------
// weeklyReport
// ---------------------------------------------------------------------------

function obs(overrides: Partial<Observation> & Pick<Observation, 'metric' | 'date' | 'value' | 'unit'>): Observation {
  return {
    ts: `${overrides.date}T08:00:00.000Z`,
    naturalKey: `${overrides.metric}-${overrides.date}`,
    platform: 'fitbit',
    recordingMethod: 'automatic',
    ...overrides,
  };
}

function sleep(overrides: Partial<SleepSession> & Pick<SleepSession, 'date'>): SleepSession {
  return {
    naturalKey: `sleep-${overrides.date}`,
    startTs: `${overrides.date}T05:00:00.000Z`,
    endTs: `${overrides.date}T13:00:00.000Z`,
    type: 'stages',
    totalMinutes: 480,
    asleepMinutes: 450,
    awakeMinutes: 30,
    deepMinutes: 90,
    remMinutes: 100,
    lightMinutes: 260,
    efficiency: 450 / 480,
    stages: [],
    platform: 'fitbit',
    ...overrides,
  };
}

function nutrition(overrides: Partial<NutritionEntry> & Pick<NutritionEntry, 'date' | 'ts'>): NutritionEntry {
  return {
    naturalKey: `nutr-${overrides.date}-${overrides.ts}`,
    foodDisplayName: 'Salad',
    mealType: 'LUNCH',
    energyKcal: 300,
    proteinG: 20,
    carbsG: 10,
    fatG: 5,
    ...overrides,
  };
}

function hydration(overrides: Partial<HydrationEntry> & Pick<HydrationEntry, 'date' | 'ts' | 'milliliters'>): HydrationEntry {
  return {
    naturalKey: `hydr-${overrides.date}-${overrides.ts}`,
    ...overrides,
  };
}

function knownBatch(): ParsedBatch {
  const batch = emptyBatch();

  // RHR: every day but 06-06 (gap), 06-10 (asOf) is elevated.
  batch.observations.push(
    obs({ metric: 'rhr', date: '2026-06-04', value: 65, unit: 'bpm' }),
    obs({ metric: 'rhr', date: '2026-06-05', value: 66, unit: 'bpm' }),
    // 2026-06-06 intentionally absent.
    obs({ metric: 'rhr', date: '2026-06-07', value: 68, unit: 'bpm' }),
    obs({ metric: 'rhr', date: '2026-06-08', value: 67, unit: 'bpm' }),
    obs({ metric: 'rhr', date: '2026-06-09', value: 70, unit: 'bpm' }),
    obs({ metric: 'rhr', date: '2026-06-10', value: 74, unit: 'bpm' }),
  );

  // HRV: every day but 06-05 (gap).
  batch.observations.push(
    obs({ metric: 'hrv_daily_avg', date: '2026-06-04', value: 20, unit: 'ms' }),
    // 2026-06-05 intentionally absent.
    obs({ metric: 'hrv_daily_avg', date: '2026-06-06', value: 18, unit: 'ms' }),
    obs({ metric: 'hrv_daily_avg', date: '2026-06-07', value: 22, unit: 'ms' }),
    obs({ metric: 'hrv_daily_avg', date: '2026-06-08', value: 19, unit: 'ms' }),
    obs({ metric: 'hrv_daily_avg', date: '2026-06-09', value: 21, unit: 'ms' }),
    obs({ metric: 'hrv_daily_avg', date: '2026-06-10', value: 15, unit: 'ms' }),
  );

  // Skin temperature, for the TEMPERATURE section.
  batch.observations.push(
    obs({ metric: 'skin_temp_baseline', date: '2026-06-09', value: 32, unit: 'C' }),
    obs({ metric: 'skin_temp_nightly', date: '2026-06-09', value: 31.5, unit: 'C' }),
  );

  // Activity.
  batch.observations.push(
    obs({ metric: 'steps', date: '2026-06-08', value: 4000, unit: 'count' }),
    obs({ metric: 'steps', date: '2026-06-09', value: 6000, unit: 'count' }),
    obs({ metric: 'azm', date: '2026-06-08', value: 20, unit: 'min' }),
    obs({ metric: 'azm', date: '2026-06-09', value: 15, unit: 'min' }),
  );

  batch.heartRateHourly.push(
    {
      naturalKey: 'hr-2026-06-08T08',
      date: '2026-06-08',
      hourTs: '2026-06-08T08:00:00.000Z',
      minBpm: 60,
      maxBpm: 90,
      avgBpm: 75,
      sampleCount: 100,
    },
    {
      naturalKey: 'hr-2026-06-09T08',
      date: '2026-06-09',
      hourTs: '2026-06-09T08:00:00.000Z',
      minBpm: 70,
      maxBpm: 110,
      avgBpm: 95,
      sampleCount: 50,
    },
  );

  batch.sleepSessions.push(
    sleep({ date: '2026-06-08', efficiency: 0.98, asleepMinutes: 470, deepMinutes: 90, remMinutes: 110 }),
    sleep({ date: '2026-06-09', efficiency: 0.8, asleepMinutes: 400, deepMinutes: 60, remMinutes: 60 }),
  );

  batch.nutrition.push(
    nutrition({ date: '2026-06-05', ts: '2026-06-05T23:00:00.000Z', foodDisplayName: 'Old Fashioned', energyKcal: null, proteinG: null }),
    nutrition({ date: '2026-06-05', ts: '2026-06-05T22:00:00.000Z', foodDisplayName: 'Steak Frites', energyKcal: 600, proteinG: 40 }),
    nutrition({ date: '2026-06-08', ts: '2026-06-08T18:00:00.000Z', foodDisplayName: 'Chicken Salad', energyKcal: 350, proteinG: 30 }),
  );

  batch.hydration.push(
    hydration({ date: '2026-06-05', ts: '2026-06-05T12:00:00.000Z', milliliters: 500 }), // low
    hydration({ date: '2026-06-08', ts: '2026-06-08T12:00:00.000Z', milliliters: 2000 }),
  );

  return batch;
}

const ASOF = '2026-06-10';

describe('weeklyReport', () => {
  it('returns a clear no-data message for a completely empty store', () => {
    const store = openStore(':memory:');
    const report = weeklyReport(store, { asOf: ASOF });
    store.close();

    expect(report).toMatch(/no data/i);
    expect(report).not.toMatch(/HEART/);
    for (const line of report.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(REPORT_WIDTH);
    }
  });

  it('renders section headers and known values from a populated store', () => {
    const store = openStore(':memory:');
    store.writeBatch(knownBatch());
    const report = weeklyReport(store, { asOf: ASOF, days: 7 });
    store.close();

    // Section headers, in order.
    const headerOrder = [
      'HEART',
      'RECOVERY',
      'ACTIVITY',
      'FOOD & DRINK',
      'SLEEP TEMPERATURE',
      'FLAGS & TRENDS',
      "THIS WEEK'S 3 ACTIONS",
    ];
    let cursor = -1;
    for (const h of headerOrder) {
      const idx = report.indexOf(h);
      expect(idx, `expected to find section "${h}"`).toBeGreaterThan(cursor);
      cursor = idx;
    }

    // Known aggregate values.
    expect(report).toContain('bpm avg'); // RHR summary line present
    expect(report).toContain('74'); // today's elevated RHR appears somewhere
    expect(report).toContain('ms avg RMSSD'); // HRV summary line present

    // Today's RHR (74) is 3+ bpm above the period baseline -> elevated flag + TODAY alert.
    expect(report).toMatch(/TODAY: RHR=74bpm/);
    expect(report).toMatch(/RHR 74bpm today/);

    // Alcohol detection from nutrition log.
    expect(report).toMatch(/Alcohol logged on 2026-06-05/);
    expect(report).toContain('Old Fashioned');

    // Sleep best/worst.
    expect(report).toContain('2026-06-08');
    expect(report).toContain('2026-06-09');
  });

  it('renders a day with no HRV reading as blank, never as a 0ms bar', () => {
    const store = openStore(':memory:');
    store.writeBatch(knownBatch());
    const report = weeklyReport(store, { asOf: ASOF, days: 7 });
    store.close();

    const lines = report.split('\n');
    const gapLine = lines.find((l) => l.trimStart().startsWith('06-05:'));
    expect(gapLine).toBeDefined();
    // The gap day must not render a value or a bar — just the date label.
    expect(gapLine).toBe('  06-05:');
    expect(gapLine).not.toMatch(/0ms/);
    expect(gapLine).not.toMatch(/█/);

    // A day that does have HRV data renders a bar and a value.
    const dataLine = lines.find((l) => l.trimStart().startsWith('06-04:'));
    expect(dataLine).toBeDefined();
    expect(dataLine).toMatch(/█/);
    expect(dataLine).toMatch(/20ms/);
  });

  it('never emits a line longer than the 72-column report width', () => {
    const store = openStore(':memory:');
    store.writeBatch(knownBatch());
    const report = weeklyReport(store, { asOf: ASOF, days: 7 });
    store.close();

    for (const line of report.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(REPORT_WIDTH);
    }
  });

  it('handles a store with data outside the requested window as if it were empty for that window', () => {
    const store = openStore(':memory:');
    store.writeBatch(knownBatch());
    // Ask for a report far in the future, past all recorded data.
    const report = weeklyReport(store, { asOf: '2030-01-01', days: 7 });
    store.close();

    expect(report).toContain('HEART');
    expect(report).toMatch(/RHR:\s+no data for this period/);
    expect(report).toMatch(/HRV:\s+no data for this period/);
    for (const line of report.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(REPORT_WIDTH);
    }
  });
});
