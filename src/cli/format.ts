/**
 * Pure CLI rendering — text and JSON formatting only.
 *
 * No Store access, no network, no process I/O: every function here is a
 * total function of its arguments so it is unit-testable without spawning a
 * subprocess. `cli/commands/*.ts` call these to turn domain data into the
 * strings `cli/index.ts` writes to stdout.
 */

import { arrow } from "../report/render.js";
import type { DailyValue } from "../store/api.js";
import type {
  Checkin,
  DailySummary,
  Flag,
  MetricSnapshot,
  SleepSession,
  SyncResult,
} from "../types.js";

/** Missing/non-finite values render as this — never 0, never "NaN". */
const MISSING = "—";

/** Fixed-point formatting. Null and non-finite numbers render as `MISSING`. */
export function formatNumber(value: number | null, digits = 0): string {
  if (value === null || !Number.isFinite(value)) {
    return MISSING;
  }
  return value.toFixed(digits);
}

/** `value` is a 0..1 fraction; renders as a whole-number percent, e.g. 0.93 -> "93%". */
export function formatPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return MISSING;
  }
  return `${Math.round(value * 100)}%`;
}

export function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

// ---------------------------------------------------------------------------
// Bare summary ("vitals" / "vitals --quiet")
// ---------------------------------------------------------------------------

function rhrPart(s: MetricSnapshot): string {
  if (s.value === null) {
    return `RHR ${MISSING}`;
  }
  const glyph = arrow(s.trend);
  const base = `RHR ${s.value.toFixed(0)}`;
  return glyph ? `${base} ${glyph}` : base;
}

function hrvPart(s: MetricSnapshot): string {
  if (s.value === null) {
    return `HRV ${MISSING}`;
  }
  const glyph = arrow(s.trend);
  const base = `HRV ${s.value.toFixed(0)}ms`;
  return glyph ? `${base} ${glyph}` : base;
}

function spo2Part(s: MetricSnapshot): string {
  if (s.value === null) {
    return `SpO2 ${MISSING}`;
  }
  return `SpO2 ${s.value.toFixed(1)}%`;
}

function sleepPart(sleep: SleepSession | null): string {
  if (!sleep) {
    return `Sleep ${MISSING}`;
  }
  const hours = formatNumber(sleep.asleepMinutes / 60, 1);
  const eff = formatPercent(sleep.efficiency);
  return `Sleep ${hours}h ${eff}eff`;
}

function flagLine(f: Flag): string {
  return `⚠ ${f.message}`;
}

/** The bare `vitals` summary line plus one line per active flag. */
export function formatBareSummary(s: DailySummary): string {
  const line = [
    rhrPart(s.rhr),
    hrvPart(s.hrv),
    sleepPart(s.sleep),
    spo2Part(s.spo2),
  ].join("  ");
  const lines = [line, ...s.flags.map(flagLine)];
  return lines.join("\n");
}

/** Alerts-only rendering. Empty string when there are no flags — silence means healthy. */
export function formatQuiet(s: DailySummary): string {
  if (s.flags.length === 0) {
    return "";
  }
  return s.flags.map(flagLine).join("\n");
}

export interface RenderResult {
  exitCode: number;
  output: string;
}

/**
 * Decides what the bare/`--quiet` command prints and exits with. `--quiet`
 * wins over `--json`: cron invokes `--quiet` expecting silence-or-alert text,
 * never a JSON envelope.
 */
export function renderToday(
  summary: DailySummary,
  opts: { quiet?: boolean; json?: boolean }
): RenderResult {
  const hasFlags = summary.flags.length > 0;
  if (opts.quiet) {
    return {
      exitCode: hasFlags ? 1 : 0,
      output: hasFlags ? formatQuiet(summary) : "",
    };
  }
  if (opts.json) {
    return { exitCode: 0, output: formatJson(summary) };
  }
  return { exitCode: 0, output: formatBareSummary(summary) };
}

// ---------------------------------------------------------------------------
// Series tables (sleep/heart/body)
// ---------------------------------------------------------------------------

export function formatSleepTable(sessions: SleepSession[]): string {
  if (sessions.length === 0) {
    return "No sleep sessions in range.";
  }
  return sessions
    .map((s) => {
      const hours = formatNumber(s.asleepMinutes / 60, 1);
      const eff = formatPercent(s.efficiency);
      const deep = formatNumber(s.deepMinutes / 60, 1);
      const rem = formatNumber(s.remMinutes / 60, 1);
      return `${s.date}  ${hours}h  ${eff}eff  deep ${deep}h  rem ${rem}h`;
    })
    .join("\n");
}

export interface HeartRow {
  date: string;
  hrv: number | null;
  rhr: number | null;
}

/** Merge two daily series into a date-unioned, date-sorted row set. Gaps stay null, never 0. */
export function mergeDailySeries(
  rhr: DailyValue[],
  hrv: DailyValue[]
): HeartRow[] {
  const dates = new Set<string>();
  const rhrMap = new Map<string, number>();
  const hrvMap = new Map<string, number>();
  for (const d of rhr) {
    dates.add(d.date);
    rhrMap.set(d.date, d.value);
  }
  for (const d of hrv) {
    dates.add(d.date);
    hrvMap.set(d.date, d.value);
  }
  return [...dates].sort().map((date) => ({
    date,
    hrv: hrvMap.get(date) ?? null,
    rhr: rhrMap.get(date) ?? null,
  }));
}

export function formatHeartTable(rows: HeartRow[]): string {
  if (rows.length === 0) {
    return "No heart data in range.";
  }
  return rows
    .map(
      (r) =>
        `${r.date}  RHR ${formatNumber(r.rhr, 0)}  HRV ${formatNumber(r.hrv, 0)}ms`
    )
    .join("\n");
}

export interface BodyRow {
  bodyFatPct: number | null;
  date: string;
  weightKg: number | null;
}

/** Merge weight and body-fat daily series into a date-unioned, date-sorted row set. */
export function mergeBodySeries(
  weight: DailyValue[],
  bodyFat: DailyValue[]
): BodyRow[] {
  const dates = new Set<string>();
  const weightMap = new Map<string, number>();
  const fatMap = new Map<string, number>();
  for (const d of weight) {
    dates.add(d.date);
    weightMap.set(d.date, d.value);
  }
  for (const d of bodyFat) {
    dates.add(d.date);
    fatMap.set(d.date, d.value);
  }
  return [...dates].sort().map((date) => ({
    bodyFatPct: fatMap.get(date) ?? null,
    date,
    weightKg: weightMap.get(date) ?? null,
  }));
}

export function formatBodyTable(rows: BodyRow[]): string {
  if (rows.length === 0) {
    return "No body data in range.";
  }
  return rows
    .map(
      (r) =>
        `${r.date}  ${formatNumber(r.weightKg, 1)}kg  ${formatNumber(r.bodyFatPct, 1)}% bf`
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// pull / note
// ---------------------------------------------------------------------------

export function formatPullResults(results: SyncResult[]): string {
  if (results.length === 0) {
    return "Nothing to sync.";
  }
  return results
    .map((r) =>
      r.error
        ? `${r.dataType}: ERROR ${r.error}`
        : `${r.dataType}: ${r.rowsWritten} rows (${r.pagesFetched} pages, ${r.pointsParsed} points)`
    )
    .join("\n");
}

export function formatCheckinConfirmation(c: Checkin): string {
  const tagSuffix = c.tags.length > 0 ? ` [${c.tags.join(", ")}]` : "";
  return `Logged mood ${c.mood}/10 for ${c.date}${tagSuffix}.`;
}
