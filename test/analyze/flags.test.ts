import { describe, expect, it } from 'vitest';
import { evaluateFlags } from '../../src/analyze/flags.js';
import type { Baseline, MetricSnapshot } from '../../src/types.js';
import { METRICS } from '../../src/types.js';

function makeBaseline(mean: number, n: number, metric: MetricSnapshot['metric']): Baseline {
  return { metric, windowDays: 30, mean, stddev: 1, n };
}

function makeSnapshot(
  metric: MetricSnapshot['metric'],
  date: string,
  value: number,
  baseline: Baseline | null,
): MetricSnapshot {
  const delta = baseline ? value - baseline.mean : null;
  const deltaPct = baseline && baseline.mean !== 0 ? (delta as number) / baseline.mean : null;
  return { metric, date, value, baseline, delta, deltaPct, trend: null };
}

describe('evaluateFlags — rhr', () => {
  const metric = METRICS.restingHeartRate;

  it('does not fire exactly at baseline + 2 (just inside)', () => {
    const b = makeBaseline(60, 30, metric);
    const flags = evaluateFlags([makeSnapshot(metric, '2026-07-05', 62, b)]);
    expect(flags).toHaveLength(0);
  });

  it('fires yellow just above baseline + 2', () => {
    const b = makeBaseline(60, 30, metric);
    const flags = evaluateFlags([makeSnapshot(metric, '2026-07-05', 62.1, b)]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.level).toBe('yellow');
    expect(flags[0]?.basis).toMatch(/Li et al\. 2020/);
  });

  it('is yellow, not red, exactly at baseline + 3', () => {
    const b = makeBaseline(60, 30, metric);
    const flags = evaluateFlags([makeSnapshot(metric, '2026-07-05', 63, b)]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.level).toBe('yellow');
  });

  it('fires red just above baseline + 3', () => {
    const b = makeBaseline(60, 30, metric);
    const flags = evaluateFlags([makeSnapshot(metric, '2026-07-05', 63.1, b)]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.level).toBe('red');
  });

  it('does not fire without a baseline', () => {
    const flags = evaluateFlags([makeSnapshot(metric, '2026-07-05', 200, null)]);
    expect(flags).toHaveLength(0);
  });
});

describe('evaluateFlags — hrv', () => {
  const metric = METRICS.hrvDailyAvg;

  it('does not fire exactly at baseline * 0.90 (just inside)', () => {
    const b = makeBaseline(50, 30, metric);
    const flags = evaluateFlags([makeSnapshot(metric, '2026-07-05', 45, b)]);
    expect(flags).toHaveLength(0);
  });

  it('fires yellow just below baseline * 0.90', () => {
    const b = makeBaseline(50, 30, metric);
    const flags = evaluateFlags([makeSnapshot(metric, '2026-07-05', 44.9, b)]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.level).toBe('yellow');
    expect(flags[0]?.basis).toMatch(/HRV4Training/);
  });

  it('is yellow, not red, exactly at baseline * 0.80', () => {
    const b = makeBaseline(50, 30, metric);
    const flags = evaluateFlags([makeSnapshot(metric, '2026-07-05', 40, b)]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.level).toBe('yellow');
  });

  it('fires red just below baseline * 0.80', () => {
    const b = makeBaseline(50, 30, metric);
    const flags = evaluateFlags([makeSnapshot(metric, '2026-07-05', 39.9, b)]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.level).toBe('red');
  });
});

describe('evaluateFlags — skin temp', () => {
  const metric = METRICS.skinTempNightly;

  it('is suppressed entirely when baseline has fewer than 30 contributing days, even with a large delta', () => {
    const b = makeBaseline(33.0, 10, metric); // only 10 days of local history
    const flags = evaluateFlags([makeSnapshot(metric, '2026-07-05', 36.0, b)]); // +3.0C
    expect(flags).toHaveLength(0);
  });

  it('does not fire exactly at baseline + 0.5 (just inside), once 30 days exist', () => {
    const b = makeBaseline(33.0, 30, metric);
    const flags = evaluateFlags([makeSnapshot(metric, '2026-07-05', 33.5, b)]);
    expect(flags).toHaveLength(0);
  });

  it('fires yellow just above baseline + 0.5', () => {
    const b = makeBaseline(33.0, 30, metric);
    const flags = evaluateFlags([makeSnapshot(metric, '2026-07-05', 33.51, b)]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.level).toBe('yellow');
    expect(flags[0]?.basis).toMatch(/Oura/);
  });

  it('is yellow, not red, exactly at baseline + 1.0', () => {
    const b = makeBaseline(33.0, 30, metric);
    const flags = evaluateFlags([makeSnapshot(metric, '2026-07-05', 34.0, b)]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.level).toBe('yellow');
  });

  it('fires red just above baseline + 1.0', () => {
    const b = makeBaseline(33.0, 30, metric);
    const flags = evaluateFlags([makeSnapshot(metric, '2026-07-05', 34.01, b)]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.level).toBe('red');
  });
});

describe('evaluateFlags — respiratory rate consecutive-night rule', () => {
  const metric = METRICS.respiratoryRate;

  it('does not fire exactly at baseline + 2 (just inside)', () => {
    const b = makeBaseline(14, 30, metric);
    const flags = evaluateFlags([makeSnapshot(metric, '2026-07-05', 16, b)]);
    expect(flags).toHaveLength(0);
  });

  it('fires yellow on a single elevated night with no prior-night data at all', () => {
    const b = makeBaseline(14, 30, metric);
    const today = makeSnapshot(metric, '2026-07-05', 16.1, b);
    const flags = evaluateFlags([today]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.level).toBe('yellow');
    expect(flags[0]?.basis).toMatch(/Visible Health/);
  });

  it('fires yellow when the prior night was NOT elevated', () => {
    const b = makeBaseline(14, 30, metric);
    const yesterday = makeSnapshot(metric, '2026-07-04', 14, b); // normal
    const today = makeSnapshot(metric, '2026-07-05', 16.5, b); // elevated
    const flags = evaluateFlags([yesterday, today]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.level).toBe('yellow');
  });

  it('fires red only on the SECOND of two consecutive elevated nights', () => {
    const b = makeBaseline(14, 30, metric);
    const yesterday = makeSnapshot(metric, '2026-07-04', 16.5, b); // elevated
    const today = makeSnapshot(metric, '2026-07-05', 16.5, b); // elevated
    const flags = evaluateFlags([yesterday, today]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.level).toBe('red');
    expect(flags[0]?.value).toBe(16.5);
  });

  it('reports only yellow when evaluated as of the FIRST elevated night (second night not yet known)', () => {
    const b = makeBaseline(14, 30, metric);
    const dayBefore = makeSnapshot(metric, '2026-07-03', 14, b); // normal
    const yesterday = makeSnapshot(metric, '2026-07-04', 16.5, b); // elevated — this is "today" as of this evaluation
    const flags = evaluateFlags([dayBefore, yesterday]);
    expect(flags).toHaveLength(1);
    expect(flags[0]?.level).toBe('yellow');
  });

  it('does not fire when neither night is elevated', () => {
    const b = makeBaseline(14, 30, metric);
    const yesterday = makeSnapshot(metric, '2026-07-04', 14, b);
    const today = makeSnapshot(metric, '2026-07-05', 14, b);
    expect(evaluateFlags([yesterday, today])).toHaveLength(0);
  });
});

describe('evaluateFlags — metrics with no defined threshold', () => {
  it('never fires for spo2, regardless of deviation', () => {
    const b = makeBaseline(97, 30, METRICS.spo2Avg);
    const flags = evaluateFlags([makeSnapshot(METRICS.spo2Avg, '2026-07-05', 88, b)]);
    expect(flags).toHaveLength(0);
  });
});

describe('evaluateFlags — combining multiple metrics', () => {
  it('evaluates each metric independently and returns all fired flags', () => {
    const rhrBaseline = makeBaseline(60, 30, METRICS.restingHeartRate);
    const hrvBaseline = makeBaseline(50, 30, METRICS.hrvDailyAvg);
    const flags = evaluateFlags([
      makeSnapshot(METRICS.restingHeartRate, '2026-07-05', 63.1, rhrBaseline), // red
      makeSnapshot(METRICS.hrvDailyAvg, '2026-07-05', 44.9, hrvBaseline), // yellow
    ]);
    expect(flags).toHaveLength(2);
    expect(flags.map((f) => f.level).sort()).toEqual(['red', 'yellow']);
  });
});
