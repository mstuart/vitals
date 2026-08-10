/**
 * MCP tool handlers over the same read layer the CLI uses (Store + analyze +
 * report).
 *
 * Every handler is a plain `(store, args) => Promise<ToolResult>` function so
 * it can be unit-tested without a transport — `server.ts` wires these into
 * `McpServer.registerTool`. Inputs are validated with zod; a validation
 * failure or a thrown `VitalsError` becomes an `isError` result rather than a
 * thrown exception, matching how MCP clients expect tool failures to surface.
 */
import { z } from "zod";

import { snapshot } from "../analyze/baseline.js";
import { dailySummary, WINDOW_DAYS } from "../analyze/summary.js";
import { weeklyReport } from "../report/weekly.js";
import type { DateRange, Store } from "../store/api.js";
import { METRICS, VitalsError } from "../types.js";
import { addDays, today } from "../util/time.js";

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  /** Index signature so this shape structurally satisfies the SDK's CallToolResult. */
  [key: string]: unknown;
}

function okResult(data: unknown): ToolResult {
  return {
    content: [{ text: JSON.stringify(data, null, 2), type: "text" }],
    structuredContent: { result: data },
  };
}

function errResult(e: VitalsError): ToolResult {
  const payload = { code: e.code, hint: e.hint ?? null, message: e.message };
  return {
    content: [{ text: JSON.stringify(payload, null, 2), type: "text" }],
    isError: true,
    structuredContent: payload,
  };
}

/**
 * Validates `args` against `schema`, then runs `fn` with the parsed input.
 * Zod failures and thrown `VitalsError`s both become `isError` results
 * instead of propagating — anything else rethrows.
 */
function withHandler<T>(
  schema: z.ZodType<T>,
  args: unknown,
  fn: (parsed: T) => unknown
): ToolResult {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(
        (i) => `${i.path.length > 0 ? `${i.path.join(".")}: ` : ""}${i.message}`
      )
      .join("; ");
    return errResult(
      new VitalsError("USAGE", `Invalid arguments: ${detail}`, {
        hint: "Check the tool input schema and retry with valid arguments.",
      })
    );
  }
  try {
    return okResult(fn(parsed.data));
  } catch (e) {
    if (e instanceof VitalsError) {
      return errResult(e);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Shared input pieces
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const dateField = z
  .string()
  .regex(DATE_RE, "Expected date in YYYY-MM-DD format");

/** Default lookback window for range-shaped tools when no bounds are given. */
const DEFAULT_RANGE_DAYS = 14;

const rangeInputSchema = z.object({
  /** Lookback window ending at `to` (or today), used when `from` is omitted. */
  days: z.number().int().positive().optional(),
  from: dateField.optional(),
  to: dateField.optional(),
});
type RangeInput = z.infer<typeof rangeInputSchema>;

function resolveRange(input: RangeInput, defaultDays: number): DateRange {
  const to = input.to ?? today();
  const from = input.from ?? addDays(to, -((input.days ?? defaultDays) - 1));
  return { from, to };
}

// ---------------------------------------------------------------------------
// vitals_today
// ---------------------------------------------------------------------------

export const vitalsTodayInputSchema = z.object({
  /** Local calendar day to summarize. Defaults to today. */
  date: dateField.optional(),
});

export function vitalsToday(store: Store, args: unknown): Promise<ToolResult> {
  return Promise.resolve(
    withHandler(vitalsTodayInputSchema, args, (parsed) => {
      const date = parsed.date ?? today();
      return dailySummary(store, date);
    })
  );
}

// ---------------------------------------------------------------------------
// vitals_sleep
// ---------------------------------------------------------------------------

export const vitalsSleepInputSchema = rangeInputSchema;

export function vitalsSleep(store: Store, args: unknown): Promise<ToolResult> {
  return Promise.resolve(
    withHandler(vitalsSleepInputSchema, args, (parsed) => {
      const range = resolveRange(parsed, DEFAULT_RANGE_DAYS);
      return { range, sessions: store.sleepSessions(range) };
    })
  );
}

// ---------------------------------------------------------------------------
// vitals_heart
// ---------------------------------------------------------------------------

export const vitalsHeartInputSchema = rangeInputSchema;

export function vitalsHeart(store: Store, args: unknown): Promise<ToolResult> {
  return Promise.resolve(
    withHandler(vitalsHeartInputSchema, args, (parsed) => {
      const range = resolveRange(parsed, DEFAULT_RANGE_DAYS);
      const rhrSnapshot = snapshot(
        store,
        METRICS.restingHeartRate,
        range.to,
        WINDOW_DAYS
      );
      const hrvSnapshot = snapshot(
        store,
        METRICS.hrvDailyAvg,
        range.to,
        WINDOW_DAYS
      );
      return {
        hrv: {
          baseline: hrvSnapshot.baseline,
          series: store.dailySeries(METRICS.hrvDailyAvg, range),
          trend: hrvSnapshot.trend,
        },
        range,
        rhr: {
          baseline: rhrSnapshot.baseline,
          series: store.dailySeries(METRICS.restingHeartRate, range),
          trend: rhrSnapshot.trend,
        },
      };
    })
  );
}

// ---------------------------------------------------------------------------
// vitals_body
// ---------------------------------------------------------------------------

export const vitalsBodyInputSchema = rangeInputSchema;

export function vitalsBody(store: Store, args: unknown): Promise<ToolResult> {
  return Promise.resolve(
    withHandler(vitalsBodyInputSchema, args, (parsed) => {
      const range = resolveRange(parsed, DEFAULT_RANGE_DAYS);
      return {
        bodyFatPct: store.dailySeries(METRICS.bodyFatPct, range),
        range,
        weightKg: store.dailySeries(METRICS.weightKg, range),
      };
    })
  );
}

// ---------------------------------------------------------------------------
// vitals_weekly_report
// ---------------------------------------------------------------------------

export const vitalsWeeklyReportInputSchema = z.object({
  /** Local calendar day the report is generated for. Defaults to today. */
  asOf: dateField.optional(),
  /** Lookback window in days, inclusive of `asOf`. Defaults to 7. */
  days: z.number().int().positive().optional(),
});

export function vitalsWeeklyReport(
  store: Store,
  args: unknown
): Promise<ToolResult> {
  return Promise.resolve(
    withHandler(vitalsWeeklyReportInputSchema, args, (parsed) => {
      const asOf = parsed.asOf ?? today();
      const report = weeklyReport(store, { asOf, days: parsed.days });
      return { asOf, days: parsed.days ?? 7, report };
    })
  );
}

// ---------------------------------------------------------------------------
// vitals_log_checkin
// ---------------------------------------------------------------------------

export const vitalsLogCheckinInputSchema = z.object({
  /** Local calendar day the check-in belongs to. Defaults to today. */
  date: dateField.optional(),
  /** Subjective mood, 1 (worst) to 10 (best). */
  mood: z
    .number()
    .int()
    .min(1, "mood must be between 1 and 10")
    .max(10, "mood must be between 1 and 10"),
  note: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
});

export function vitalsLogCheckin(
  store: Store,
  args: unknown
): Promise<ToolResult> {
  return Promise.resolve(
    withHandler(vitalsLogCheckinInputSchema, args, (parsed) => {
      const date = parsed.date ?? today();
      const ts = new Date().toISOString();
      return store.addCheckin({
        date,
        mood: parsed.mood,
        note: parsed.note ?? null,
        tags: parsed.tags ?? [],
        ts,
      });
    })
  );
}

// ---------------------------------------------------------------------------
// vitals_coverage
// ---------------------------------------------------------------------------

export const vitalsCoverageInputSchema = z.object({});

export function vitalsCoverage(
  store: Store,
  args: unknown
): Promise<ToolResult> {
  return Promise.resolve(
    withHandler(vitalsCoverageInputSchema, args, () => {
      const range = store.coverage();
      if (range === null) {
        return { empty: true, from: null, to: null };
      }
      return { empty: false, from: range.from, to: range.to };
    })
  );
}
