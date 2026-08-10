/**
 * The storage interface.
 *
 * `analyze`, `sync`, `cli`, and `mcp` code against this interface, never
 * against SQLite directly. Implemented by `src/store/sqlite.ts`.
 */
import type {
  Checkin,
  DataTypeId,
  ExerciseSession,
  HeartRateHourly,
  HydrationEntry,
  MetricId,
  NutritionEntry,
  Observation,
  ParsedBatch,
  SleepSession,
  SyncWatermark,
} from "../types.js";

/** A metric value on a given local day. */
export interface DailyValue {
  date: string;
  value: number;
}

export interface DateRange {
  /** Inclusive `YYYY-MM-DD`. */
  from: string;
  /** Inclusive `YYYY-MM-DD`. */
  to: string;
}

export interface Store {
  addCheckin: (c: Omit<Checkin, "id">) => Checkin;
  allWatermarks: () => SyncWatermark[];
  checkin: (date: string) => Checkin | null;
  checkins: (range: DateRange) => Checkin[];

  close: () => void;

  /** Earliest and latest dates with any data. Null when the store is empty. */
  coverage: () => DateRange | null;

  /**
   * One value per day for a metric, ascending by date.
   *
   * When a metric has several observations on one day (e.g. weight measured
   * twice), the daily value is the mean. Days with no observation are absent
   * rather than zero-filled — callers must not treat a gap as a zero.
   */
  dailySeries: (metric: MetricId, range: DateRange) => DailyValue[];
  exercises: (range: DateRange) => ExerciseSession[];

  getWatermark: (dataType: DataTypeId) => SyncWatermark | null;
  heartRateHourly: (range: DateRange) => HeartRateHourly[];
  hydration: (range: DateRange) => HydrationEntry[];

  /** Most recent value for a metric at or before `onOrBefore`. */
  latest: (metric: MetricId, onOrBefore?: string) => DailyValue | null;
  nutrition: (range: DateRange) => NutritionEntry[];

  /** All raw observations for a metric in range, ascending by ts. */
  observations: (metric: MetricId, range: DateRange) => Observation[];
  setWatermark: (w: SyncWatermark) => void;
  sleepSession: (date: string) => SleepSession | null;

  sleepSessions: (range: DateRange) => SleepSession[];
  /**
   * Persist a parsed batch. Idempotent: re-applying the same batch must not
   * change row counts or values. Returns the number of rows inserted or
   * updated across all record kinds.
   */
  writeBatch: (batch: ParsedBatch) => number;
}
