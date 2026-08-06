/**
 * Weekly health report, rendered from the local Store rather than from live
 * API pulls, so it works offline and covers days the API no longer serves.
 *
 * Section order: HEART, RECOVERY, ACTIVITY,
 * FOOD & DRINK, SLEEP TEMPERATURE, FLAGS & TRENDS, THIS WEEK'S 3 ACTIONS.
 * "ACTIVITY & SEDENTARY" is shortened to "ACTIVITY" because vitals does not
 * ingest sedentary-period data (it is not one of the 18 registered data
 * types — see src/types.ts DATA_TYPE_IDS), so there is nothing to render.
 *
 * The critical divergence from the original: the Store may have GAPS (sync
 * hasn't run, a data type failed, history predates first sync). A day with
 * no observation is rendered BLANK, never as 0 — a 0 bpm resting heart rate
 * would read as a medical emergency. Every section here checks `.size`/
 * `.length` before computing an aggregate, and every per-day loop looks the
 * day up rather than assuming it is present.
 */
import type { HydrationEntry, MetricId, NutritionEntry, TrendDirection } from '../types.js';
import { METRICS } from '../types.js';
import type { DateRange, Store } from '../store/api.js';
import { addDays } from '../util/time.js';
import { arrow, center, fmt, rule, bar, REPORT_WIDTH } from './render.js';

export interface WeeklyReportOptions {
  /** Local calendar day (YYYY-MM-DD) the report is generated for. */
  asOf: string;
  /** Lookback window in days, inclusive of `asOf`. Defaults to 7. */
  days?: number;
}

const DEFAULT_DAYS = 7;

/** HRV timeline bar scale: matches the original script's `h/30*20` chart. */
const HRV_BAR_MAX_MS = 30;
const HRV_BAR_WIDTH = 20;

/**
 * bpm above the period baseline before "today" is flagged elevated. Matches
 * the >3bpm red threshold basis used in src/analyze/flags.ts (Li et al. 2020).
 */
const RHR_ELEVATED_DELTA = 3;

/** Percent of sleep that is neither deep nor REM before it counts as "high light". */
const HIGH_LIGHT_SLEEP_PCT = 62;

/** Milliliters equivalent to the ~40oz/day low-hydration line in the original. */
const LOW_HYDRATION_ML = 40 * 29.5735;

const ML_PER_OZ = 29.5735;

const ALCOHOL_KEYWORDS = [
  'whiskey',
  'bourbon',
  'old fashioned',
  'beer',
  'wine',
  'cocktail',
  'alcohol',
  'vodka',
  'tequila',
  'rum',
  'gin',
];

type Add = (line?: string) => void;

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function mmdd(date: string): string {
  return date.slice(5);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function cToF(celsius: number): number {
  return (celsius * 9) / 5 + 32;
}

function buildDateList(from: string, to: string): string[] {
  const dates: string[] = [];
  let d = from;
  let guard = 0;
  while (d <= to && guard < 10000) {
    dates.push(d);
    d = addDays(d, 1);
    guard += 1;
  }
  return dates;
}

function seriesMap(store: Store, metric: MetricId, range: DateRange): Map<string, number> {
  const m = new Map<string, number>();
  for (const dv of store.dailySeries(metric, range)) m.set(dv.date, dv.value);
  return m;
}

/**
 * Rising/falling/flat by comparing the mean of the first half of
 * present-data days against the mean of the last half, in date order. Gaps
 * are never zero-filled — only days that actually have a value count.
 * Needs at least 4 contributing days on each side to be worth reporting.
 */
function trendOverDates(dateList: string[], valueMap: Map<string, number>): TrendDirection | null {
  const present = dateList.filter((d) => valueMap.has(d));
  if (present.length < 4) return null;

  const half = Math.floor(present.length / 2);
  const older = present.slice(0, half).map((d) => valueMap.get(d) as number);
  const newer = present.slice(present.length - half).map((d) => valueMap.get(d) as number);

  const meanOlder = mean(older);
  const meanNewer = mean(newer);
  if (meanOlder === null || meanNewer === null) return null;

  const delta = meanNewer - meanOlder;
  const threshold = Math.abs(meanOlder) * 0.02 || 0.01;
  if (Math.abs(delta) < threshold) return 'flat';
  return delta > 0 ? 'rising' : 'falling';
}

function trendLabel(t: TrendDirection): string {
  if (t === 'rising') return 'rising';
  if (t === 'falling') return 'falling';
  return 'stable';
}

function formatTime(ts: string): string {
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  let h = d.getUTCHours();
  const m = d.getUTCMinutes();
  const ampm = h < 12 ? 'AM' : 'PM';
  h = h % 12;
  if (h === 0) h = 12;
  return `${h}:${String(m).padStart(2, '0')}${ampm}`;
}

function isAlcohol(foodDisplayName: string | null): boolean {
  const food = (foodDisplayName ?? '').toLowerCase();
  return ALCOHOL_KEYWORDS.some((k) => food.includes(k));
}

function sumMillilitersByDate(hydration: HydrationEntry[]): Map<string, number> {
  const byDate = new Map<string, number>();
  for (const h of hydration) byDate.set(h.date, (byDate.get(h.date) ?? 0) + h.milliliters);
  return byDate;
}

function noDataMessage(): string {
  return [
    rule(REPORT_WIDTH, '='),
    center('VITALS — WEEKLY HEALTH REPORT', REPORT_WIDTH),
    rule(REPORT_WIDTH, '='),
    '',
    'No data available yet. Run `vitals sync` to pull data, then try again.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function renderHeader(asOf: string, from: string, days: number, add: Add): void {
  add(rule(REPORT_WIDTH, '='));
  add(center('VITALS — WEEKLY HEALTH REPORT', REPORT_WIDTH));
  add(center(`Report generated: ${asOf}  (last ${days}d: ${from} to ${asOf})`, REPORT_WIDTH));
  add(rule(REPORT_WIDTH, '='));
}

function renderHeartSection(
  store: Store,
  range: DateRange,
  dateList: string[],
  add: Add,
): void {
  add('');
  add(rule(REPORT_WIDTH));
  add(center('HEART', REPORT_WIDTH));
  add(rule(REPORT_WIDTH));

  const rhrMap = seriesMap(store, METRICS.restingHeartRate, range);
  const rhrValues = [...rhrMap.values()];
  if (rhrValues.length > 0) {
    const avg = mean(rhrValues) as number;
    const min = Math.min(...rhrValues);
    const max = Math.max(...rhrValues);
    add(`RHR:  ${fmt(avg, 0)} bpm avg (${fmt(min, 0)}-${fmt(max, 0)} range)`);
    const t = trendOverDates(dateList, rhrMap);
    if (t) add(`    Trend: ${arrow(t)} ${trendLabel(t)}`);
  } else {
    add('RHR:  no data for this period');
  }

  const hrvMap = seriesMap(store, METRICS.hrvDailyAvg, range);
  if (hrvMap.size > 0) {
    const avg = mean([...hrvMap.values()]) as number;
    let peakDate = '';
    let peakVal = -Infinity;
    let lowDate = '';
    let lowVal = Infinity;
    for (const [d, v] of hrvMap) {
      if (v > peakVal) {
        peakVal = v;
        peakDate = d;
      }
      if (v < lowVal) {
        lowVal = v;
        lowDate = d;
      }
    }
    add(`HRV:  ${fmt(avg, 0)}ms avg RMSSD`);
    add(`      Peak: ${fmt(peakVal, 0)}ms (${peakDate}) | Low: ${fmt(lowVal, 0)}ms (${lowDate})`);
    const t = trendOverDates(dateList, hrvMap);
    if (t) add(`      Trend: ${arrow(t)} ${trendLabel(t)}`);
  } else {
    add('HRV:  no data for this period');
  }

  const hrRows = store.heartRateHourly(range);
  if (hrRows.length > 0) {
    const avgs = hrRows.map((r) => r.avgBpm);
    const avgHr = mean(avgs) as number;
    const under80 = (avgs.filter((v) => v < 80).length / avgs.length) * 100;
    const over100 = (avgs.filter((v) => v >= 100).length / avgs.length) * 100;
    const sampleCount = hrRows.reduce((s, r) => s + r.sampleCount, 0);
    add(
      `HR:   ${fmt(avgHr, 0)}bpm avg | <80: ${fmt(under80, 0)}% | >=100: ${fmt(over100, 0)}% | (${sampleCount} samples)`,
    );
  }

  add('');
  add('HRV Timeline:');
  for (const d of dateList) {
    const h = hrvMap.get(d);
    if (h === undefined) {
      // No HRV reading this day — blank, not a 0ms bar.
      add(`  ${mmdd(d)}:`);
      continue;
    }
    const b = bar(h, HRV_BAR_MAX_MS, HRV_BAR_WIDTH);
    const r = rhrMap.get(d);
    const rhrLabel = r !== undefined ? ` RHR=${fmt(r, 0)}` : '';
    add(`  ${mmdd(d)}: ${b} ${fmt(h, 0)}ms${rhrLabel}`);
  }
}

function renderRecoverySection(store: Store, range: DateRange, dateList: string[], asOf: string, add: Add): void {
  add('');
  add(rule(REPORT_WIDTH));
  add(center('RECOVERY', REPORT_WIDTH));
  add(rule(REPORT_WIDTH));

  const sessions = store.sleepSessions(range);
  if (sessions.length > 0) {
    const effs = sessions
      .map((s) => s.efficiency)
      .filter((e): e is number => e !== null);
    if (effs.length > 0) {
      add(`Sleep:  ${fmt(mean(effs.map((e) => e * 100)) as number, 0)}% avg efficiency`);
    }
    const avgAsleep = mean(sessions.map((s) => s.asleepMinutes)) as number;
    add(`        ${fmt(avgAsleep, 0)}min avg (${fmt(avgAsleep / 60, 1)}h)`);

    const withStages = sessions.filter((s) => s.asleepMinutes > 0);
    if (withStages.length > 0) {
      const deepPct = mean(withStages.map((s) => (s.deepMinutes / s.asleepMinutes) * 100)) as number;
      const remPct = mean(withStages.map((s) => (s.remMinutes / s.asleepMinutes) * 100)) as number;
      add(`        Deep: ${fmt(deepPct, 0)}% | REM: ${fmt(remPct, 0)}%`);
    }

    const withEff = sessions.filter((s): s is typeof s & { efficiency: number } => s.efficiency !== null);
    if (withEff.length > 0) {
      const best = withEff.reduce((a, b) => (b.efficiency > a.efficiency ? b : a));
      const worst = withEff.reduce((a, b) => (b.efficiency < a.efficiency ? b : a));
      const stageStr = (s: (typeof withEff)[number]): string => {
        if (s.asleepMinutes <= 0) return 'Deep=n/a  REM=n/a';
        const deep = (s.deepMinutes / s.asleepMinutes) * 100;
        const rem = (s.remMinutes / s.asleepMinutes) * 100;
        return `Deep=${fmt(deep, 1)}%  REM=${fmt(rem, 1)}%`;
      };
      add(`Best:   ${best.date} — ${fmt(best.efficiency * 100, 1)}%eff  ${stageStr(best)}`);
      add(`Worst:  ${worst.date} — ${fmt(worst.efficiency * 100, 1)}%eff  ${stageStr(worst)}`);
    }
  } else {
    add('Sleep:  no data for this period');
  }

  add('');
  add('RHR ↔ HRV Correlation:');
  const rhrMap = seriesMap(store, METRICS.restingHeartRate, range);
  const hrvMap = seriesMap(store, METRICS.hrvDailyAvg, range);
  let anyCorrelation = false;
  for (const d of dateList) {
    const r = rhrMap.get(d);
    const h = hrvMap.get(d);
    if (r === undefined || h === undefined) continue;
    anyCorrelation = true;
    add(`  ${mmdd(d)}: RHR=${fmt(r, 0)} HRV=${fmt(h, 0)}ms`);
  }
  if (!anyCorrelation) add('  no overlapping RHR/HRV data for this period');

  const todayRhr = rhrMap.get(asOf);
  if (todayRhr !== undefined) {
    const others = dateList
      .filter((d) => d !== asOf)
      .map((d) => rhrMap.get(d))
      .filter((v): v is number => v !== undefined);
    const baseline = mean(others);
    if (baseline !== null) {
      add('');
      if (todayRhr > baseline + RHR_ELEVATED_DELTA) {
        add(`⚠ TODAY: RHR=${fmt(todayRhr, 0)}bpm — above your ${fmt(baseline, 0)} avg. Consider easy day.`);
      } else {
        add(`✓ TODAY: RHR=${fmt(todayRhr, 0)}bpm — good recovery baseline.`);
      }
    }
  }
}

function renderActivitySection(store: Store, range: DateRange, add: Add): void {
  add('');
  add(rule(REPORT_WIDTH));
  add(center('ACTIVITY', REPORT_WIDTH));
  add(rule(REPORT_WIDTH));

  const azmObs = store.observations(METRICS.activeZoneMinutes, range);
  if (azmObs.length > 0) {
    const total = azmObs.reduce((s, o) => s + o.value, 0);
    add(`AZM:    ${fmt(total, 0)} min this period`);
  } else {
    add('AZM:    no data for this period');
  }

  const stepsObs = store.observations(METRICS.steps, range);
  if (stepsObs.length > 0) {
    const total = stepsObs.reduce((s, o) => s + o.value, 0);
    add(`Steps:  ${fmt(total, 0)} total`);
  } else {
    add('Steps:  no data for this period');
  }
}

function renderFoodSection(store: Store, range: DateRange, add: Add): void {
  add('');
  add(rule(REPORT_WIDTH));
  add(center('FOOD & DRINK', REPORT_WIDTH));
  add(rule(REPORT_WIDTH));

  const entries = store.nutrition(range);
  if (entries.length > 0) {
    const byDate = new Map<string, NutritionEntry[]>();
    for (const e of entries) {
      const arr = byDate.get(e.date) ?? [];
      arr.push(e);
      byDate.set(e.date, arr);
    }
    for (const d of [...byDate.keys()].sort()) {
      add(`  ${d}:`);
      const dayEntries = byDate.get(d) ?? [];
      for (const e of dayEntries) {
        const time = formatTime(e.ts);
        const cal = e.energyKcal !== null ? ` ${fmt(e.energyKcal, 0)}cal` : '';
        const pro = e.proteinG !== null ? ` P=${fmt(e.proteinG, 0)}g` : '';
        add(`    ${time}: ${e.foodDisplayName ?? '(unnamed)'}${cal}${pro}`);
      }
    }
  } else {
    add('  No food logs for this period.');
  }

  const hydration = store.hydration(range);
  if (hydration.length > 0) {
    const byDate = sumMillilitersByDate(hydration);
    const avgOz = (mean([...byDate.values()]) as number) / ML_PER_OZ;
    add(`Hydration: ${fmt(avgOz, 0)} oz/day avg`);
  }
}

function renderTemperatureSection(store: Store, range: DateRange, add: Add): void {
  const nightly = seriesMap(store, METRICS.skinTempNightly, range);
  const baseline = seriesMap(store, METRICS.skinTempBaseline, range);
  if (nightly.size === 0 && baseline.size === 0) return; // matches original: section is omitted entirely when empty

  add('');
  add(rule(REPORT_WIDTH));
  add(center('SLEEP TEMPERATURE', REPORT_WIDTH));
  add(rule(REPORT_WIDTH));

  const dates = [...new Set([...nightly.keys(), ...baseline.keys()])].sort().slice(-3);
  for (const d of dates) {
    const b = baseline.get(d);
    if (b === undefined) continue;
    const nl = nightly.get(d);
    const nightStr = nl !== undefined ? `${fmt(cToF(nl), 1)}°F` : 'n/a';
    add(`  ${d}: Baseline ${fmt(cToF(b), 1)}°F → Sleep ${nightStr}`);
  }
}

function computeFlags(store: Store, range: DateRange, dateList: string[], asOf: string): string[] {
  const flags: string[] = [];
  const rhrMap = seriesMap(store, METRICS.restingHeartRate, range);
  const hrvMap = seriesMap(store, METRICS.hrvDailyAvg, range);

  const todayRhr = rhrMap.get(asOf);
  if (todayRhr !== undefined) {
    const others = dateList
      .filter((d) => d !== asOf)
      .map((d) => rhrMap.get(d))
      .filter((v): v is number => v !== undefined);
    const baseline = mean(others);
    if (baseline !== null && todayRhr > baseline + RHR_ELEVATED_DELTA) {
      flags.push(`⚠ RHR ${fmt(todayRhr, 0)}bpm today — above your ${fmt(baseline, 0)} avg. Consider rest.`);
    }
  }

  const hrvTrend = trendOverDates(dateList, hrvMap);
  if (hrvTrend === 'falling') {
    flags.push('↓ HRV declining this period. Check sleep and hydration.');
  } else if (hrvTrend === 'rising') {
    flags.push('↑ HRV improving this period. Keep doing what works.');
  }

  const nutrition = store.nutrition(range);
  const alcoholDates = new Set<string>();
  for (const e of nutrition) {
    if (isAlcohol(e.foodDisplayName)) alcoholDates.add(e.date);
  }
  if (alcoholDates.size > 0) {
    flags.push(`🥃 Alcohol logged on ${[...alcoholDates].sort().join(', ')}. Expect a 48h recovery tax.`);
  }

  const hydration = store.hydration(range);
  if (hydration.length > 0) {
    const byDate = sumMillilitersByDate(hydration);
    const lowDays = [...byDate.values()].filter((ml) => ml < LOW_HYDRATION_ML).length;
    if (lowDays > 0) {
      flags.push(`💧 ${lowDays} day(s) with low water intake — hydration helps HRV.`);
    }
  }

  const sessions = store.sleepSessions(range);
  const highLightDates = sessions
    .filter((s) => s.asleepMinutes > 0)
    .filter((s) => 100 - (s.deepMinutes / s.asleepMinutes) * 100 - (s.remMinutes / s.asleepMinutes) * 100 > HIGH_LIGHT_SLEEP_PCT)
    .map((s) => s.date);
  if (highLightDates.length > 0) {
    flags.push(`🛌 High light sleep (>${HIGH_LIGHT_SLEEP_PCT}%): ${highLightDates.join(', ')}.`);
  }

  if (flags.length === 0) flags.push('✓ No significant flags. Steady recovery.');

  return flags;
}

function renderFlagsSection(flags: string[], add: Add): void {
  add('');
  add(rule(REPORT_WIDTH));
  add(center('FLAGS & TRENDS', REPORT_WIDTH));
  add(rule(REPORT_WIDTH));
  for (const f of flags) add(`  ${f}`);
}

function renderActionsSection(store: Store, range: DateRange, asOf: string, add: Add): void {
  add('');
  add(rule(REPORT_WIDTH));
  add(center("THIS WEEK'S 3 ACTIONS", REPORT_WIDTH));
  add(rule(REPORT_WIDTH));

  const rhrMap = seriesMap(store, METRICS.restingHeartRate, range);
  const todayRhr = rhrMap.get(asOf);
  add('');
  add('1. WATCH YOUR RHR');
  if (todayRhr !== undefined) {
    add(`   Today's RHR is ${fmt(todayRhr, 0)}bpm. When it runs 3+ bpm above baseline, pull back.`);
  } else {
    add('   Check your RHR first thing each morning.');
  }

  const nutrition = store.nutrition(range);
  const hadAlcohol = nutrition.some((e) => isAlcohol(e.foodDisplayName));
  add('');
  add('2. ALCOHOL = 48-HOUR RECOVERY TAX');
  add(
    hadAlcohol
      ? '   Alcohol detected this period. Each drink costs ~2 recovery nights.'
      : '   No alcohol logged. Recovery data confirms what you see.',
  );

  const hydration = store.hydration(range);
  add('');
  add('3. HYDRATION = HRV LEVERAGE');
  if (hydration.length > 0) {
    const byDate = sumMillilitersByDate(hydration);
    const avgOz = (mean([...byDate.values()]) as number) / ML_PER_OZ;
    add(`   Water logged: ${fmt(avgOz, 0)} oz/day. More water tends to lift HRV.`);
  } else {
    add('   No hydration logs for this period.');
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function weeklyReport(store: Store, opts: WeeklyReportOptions): string {
  const days = opts.days ?? DEFAULT_DAYS;
  const asOf = opts.asOf;

  if (store.coverage() === null) {
    return noDataMessage();
  }

  const from = addDays(asOf, -(days - 1));
  const range: DateRange = { from, to: asOf };
  const dateList = buildDateList(from, asOf);

  const lines: string[] = [];
  const add: Add = (line = '') => lines.push(line);

  renderHeader(asOf, from, days, add);
  renderHeartSection(store, range, dateList, add);
  renderRecoverySection(store, range, dateList, asOf, add);
  renderActivitySection(store, range, add);
  renderFoodSection(store, range, add);
  renderTemperatureSection(store, range, add);
  const flags = computeFlags(store, range, dateList, asOf);
  renderFlagsSection(flags, add);
  renderActionsSection(store, range, asOf, add);

  add('');
  add(rule(REPORT_WIDTH));
  add(`Next report: ${addDays(asOf, 7)}`);
  add(`Data: vitals local store (${days}-day window)`);
  add(rule(REPORT_WIDTH));

  return lines.join('\n');
}
