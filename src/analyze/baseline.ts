/**
 * Rolling baselines, trend direction, and per-metric snapshots.
 *
 * Pure functions over `DailyValue[]` plus a thin `snapshot()` that pulls the
 * relevant series out of the Store. No network, no direct SQLite.
 */

import type { DailyValue, DateRange, Store } from "../store/api.js";
import type {
  Baseline,
  MetricId,
  MetricSnapshot,
  TrendDirection,
} from "../types.js";
import { addDays } from "../util/time.js";

/** Minimum number of contributing days required to report a baseline at all. */
const MIN_CONTRIBUTING_DAYS = 3;

/** Trend is 'flat' when the change is under this fraction of the older mean. */
const FLAT_TREND_THRESHOLD = 0.02;

/**
 * Mean and sample stddev over the window ENDING THE DAY BEFORE `asOf`.
 *
 * A baseline must never include the day being judged — otherwise a spike on
 * `asOf` would hide itself inside its own baseline. Days absent from `series`
 * (gaps) simply do not contribute; they are never treated as zero.
 *
 * Returns null when fewer than `MIN_CONTRIBUTING_DAYS` days contributed —
 * a baseline computed from 1-2 points is not worth reporting as one.
 */
export function rollingBaseline(
  series: DailyValue[],
  asOf: string,
  windowDays: number,
  metric: MetricId
): Baseline | null {
  const windowStart = addDays(asOf, -windowDays);
  const windowEnd = addDays(asOf, -1);

  const values = series
    .filter((d) => d.date >= windowStart && d.date <= windowEnd)
    .map((d) => d.value);

  const n = values.length;
  if (n < MIN_CONTRIBUTING_DAYS) {
    return null;
  }

  const mean = values.reduce((sum, v) => sum + v, 0) / n;
  const variance =
    values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1);
  const stddev = Math.sqrt(variance);

  return { mean, metric, n, stddev, windowDays };
}

/**
 * Compares the mean of the most recent half of the last `days` VALUES present
 * in `series` against the older half. Gaps are never zero-filled: the "last
 * `days`" is measured in contributing data points, not calendar days.
 *
 * Returns null when there are fewer than 2 contributing points (a trend needs
 * at least one point on each side to compare).
 */
export function trend(
  series: DailyValue[],
  days: number
): TrendDirection | null {
  if (days < 2) {
    return null;
  }

  const recent = series.slice(-days);
  if (recent.length < 2) {
    return null;
  }

  const mid = Math.floor(recent.length / 2);
  const older = recent.slice(0, mid);
  const newer = recent.slice(mid);
  if (older.length === 0 || newer.length === 0) {
    return null;
  }

  const meanOlder = older.reduce((sum, d) => sum + d.value, 0) / older.length;
  const meanNewer = newer.reduce((sum, d) => sum + d.value, 0) / newer.length;

  if (meanOlder === 0) {
    if (meanNewer === 0) {
      return "flat";
    }
    return meanNewer > 0 ? "rising" : "falling";
  }

  const pctChange = (meanNewer - meanOlder) / Math.abs(meanOlder);
  if (Math.abs(pctChange) < FLAT_TREND_THRESHOLD) {
    return "flat";
  }
  return pctChange > 0 ? "rising" : "falling";
}

/** Assembles value, baseline, delta, deltaPct, and trend for one metric/day. */
export function snapshot(
  store: Store,
  metric: MetricId,
  date: string,
  windowDays: number
): MetricSnapshot {
  const valueRange: DateRange = { from: date, to: date };
  const valueSeries = store.dailySeries(metric, valueRange);
  const value = valueSeries.at(0)?.value ?? null;

  const baselineRange: DateRange = {
    from: addDays(date, -windowDays),
    to: addDays(date, -1),
  };
  const baselineSeries = store.dailySeries(metric, baselineRange);
  const baseline = rollingBaseline(baselineSeries, date, windowDays, metric);

  const delta =
    value !== null && baseline !== null ? value - baseline.mean : null;
  const deltaPct =
    value !== null && baseline !== null && baseline.mean !== 0
      ? (value - baseline.mean) / baseline.mean
      : null;

  const trendRange: DateRange = {
    from: addDays(date, -(windowDays - 1)),
    to: date,
  };
  const trendSeries = store.dailySeries(metric, trendRange);
  const trendDirection = trend(trendSeries, windowDays);

  return {
    baseline,
    date,
    delta,
    deltaPct,
    metric,
    trend: trendDirection,
    value,
  };
}
