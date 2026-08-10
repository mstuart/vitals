/**
 * Shared type contract for vitals.
 *
 * Every module depends on this file and nothing in this file depends on any
 * module. Changing a type here is a cross-cutting change — do it deliberately.
 *
 * Data flows one direction:
 *   api -> datatypes (parse) -> store (persist) -> analyze (derive) -> cli/mcp/report (render)
 */

// ---------------------------------------------------------------------------
// Google Health API v4 wire format
// ---------------------------------------------------------------------------

/** The 18 data type ids vitals ingests. Values are URL path segments. */
export const DATA_TYPE_IDS = [
  "steps",
  "distance",
  "heart-rate",
  "heart-rate-variability",
  "daily-heart-rate-variability",
  "daily-resting-heart-rate",
  "daily-oxygen-saturation",
  "sleep",
  "daily-respiratory-rate",
  "respiratory-rate-sleep-summary",
  "daily-sleep-temperature-derivations",
  "weight",
  "body-fat",
  "exercise",
  "active-zone-minutes",
  "active-energy-burned",
  "nutrition-log",
  "hydration-log",
] as const;

export type DataTypeId = (typeof DATA_TYPE_IDS)[number];

/** `{ year, month, day }` — month and day are 1-based. */
export interface ApiDate {
  day: number;
  month: number;
  year: number;
}

export interface ApiCivilTime {
  date: ApiDate;
  time?: { hours?: number; minutes?: number; seconds?: number };
}

/** A point in time. `physicalTime` is ISO 8601 UTC. */
export interface ApiSampleTime {
  civilTime?: ApiCivilTime;
  physicalTime: string;
  utcOffset?: string;
}

/** A half-open interval [startTime, endTime). */
export interface ApiInterval {
  civilEndTime?: ApiCivilTime;
  civilStartTime?: ApiCivilTime;
  endTime?: string;
  endUtcOffset?: string;
  startTime: string;
  startUtcOffset?: string;
}

export interface ApiDataSource {
  application?: { packageName?: string };
  device?: Record<string, unknown>;
  platform?: string;
  recordingMethod?: string;
}

/**
 * One data point as returned by the API.
 *
 * `name` is NOT a reliable identifier: daily aggregate types omit it entirely,
 * and `respiratory-rate-sleep-summary` returns it with an empty trailing id
 * (`users/<id>/dataTypes/.../dataPoints/`). Natural keys are derived from
 * timestamps instead — see `naturalKey` in the datatypes registry.
 */
export interface ApiDataPoint {
  dataSource?: ApiDataSource;
  name?: string;
  [payload: string]: unknown;
}

export interface ApiDataPointsResponse {
  dataPoints?: ApiDataPoint[];
  nextPageToken?: string;
}

// ---------------------------------------------------------------------------
// Normalized storage model
// ---------------------------------------------------------------------------

/**
 * Stable metric identifiers used in the `observations` table and by analyze/.
 * These are vitals' own names, deliberately decoupled from API field names so
 * the storage layer survives API renames.
 */
export const METRICS = {
  activeEnergyKcal: "active_energy_kcal",
  activeZoneMinutes: "azm",
  bodyFatPct: "body_fat_pct",
  distanceM: "distance_m",
  heartRateSample: "hr_sample",
  hrvDailyAvg: "hrv_daily_avg",
  hrvDeepSleep: "hrv_deep_sleep",
  hrvEntropy: "hrv_entropy",
  hrvSample: "hrv_sample",
  nonRemHeartRate: "non_rem_hr",
  respiratoryRate: "resp_rate",
  respRateDeepSleep: "resp_rate_deep",
  respRateFullSleep: "resp_rate_full",
  respRateLightSleep: "resp_rate_light",
  respRateRemSleep: "resp_rate_rem",
  restingHeartRate: "rhr",
  skinTempBaseline: "skin_temp_baseline",
  skinTempNightly: "skin_temp_nightly",
  skinTempStddev30d: "skin_temp_stddev_30d",
  spo2Avg: "spo2_avg",
  spo2Lower: "spo2_lower",
  spo2Upper: "spo2_upper",
  steps: "steps",
  weightKg: "weight_kg",
} as const;

export type MetricId = (typeof METRICS)[keyof typeof METRICS];

/**
 * A single scalar measurement.
 *
 * `date` is the LOCAL calendar day (YYYY-MM-DD) the measurement belongs to,
 * derived using the point's own UTC offset. Analysis groups by `date`.
 * `ts` is the ISO 8601 UTC instant, or null for whole-day aggregates.
 */
export interface Observation {
  date: string;
  metric: MetricId;
  /** Natural key for idempotent upsert: unique per (metric, naturalKey). */
  naturalKey: string;
  platform: string | null;
  recordingMethod: string | null;
  ts: string | null;
  unit: string;
  value: number;
}

export type SleepStageType = "AWAKE" | "LIGHT" | "DEEP" | "REM";

export interface SleepStage {
  endTs: string;
  minutes: number;
  startTs: string;
  type: SleepStageType;
}

export interface SleepSession {
  asleepMinutes: number;
  awakeMinutes: number;
  /** Local calendar day the sleep session ENDS on — the "night of" waking. */
  date: string;
  deepMinutes: number;
  /** asleepMinutes / totalMinutes, 0..1. Null when totalMinutes is 0. */
  efficiency: number | null;
  endTs: string;
  lightMinutes: number;
  naturalKey: string;
  platform: string | null;
  remMinutes: number;
  stages: SleepStage[];
  startTs: string;
  totalMinutes: number;
  type: string | null;
}

export interface ExerciseSession {
  avgHeartRate: number | null;
  caloriesBurned: number | null;
  date: string;
  displayName: string | null;
  endTs: string | null;
  exerciseType: string | null;
  intensity: string | null;
  naturalKey: string;
  platform: string | null;
  startTs: string;
}

export interface NutritionEntry {
  carbsG: number | null;
  date: string;
  energyKcal: number | null;
  fatG: number | null;
  foodDisplayName: string | null;
  mealType: string | null;
  naturalKey: string;
  proteinG: number | null;
  ts: string;
}

export interface HydrationEntry {
  date: string;
  milliliters: number;
  naturalKey: string;
  ts: string;
}

/** Hourly aggregate of raw heart rate. Raw ~1Hz samples are never stored. */
export interface HeartRateHourly {
  avgBpm: number;
  date: string;
  /** ISO 8601 UTC, truncated to the hour. */
  hourTs: string;
  maxBpm: number;
  minBpm: number;
  naturalKey: string;
  sampleCount: number;
}

/** Subjective check-in. The only user-mutable record type. */
export interface Checkin {
  date: string;
  id?: number;
  /** 1..10 */
  mood: number;
  note: string | null;
  tags: string[];
  ts: string;
}

/**
 * Everything a parser can emit. A single API page may yield several kinds
 * (e.g. daily-hrv produces multiple Observations per point).
 */
export interface ParsedBatch {
  exercises: ExerciseSession[];
  heartRateHourly: HeartRateHourly[];
  hydration: HydrationEntry[];
  nutrition: NutritionEntry[];
  observations: Observation[];
  sleepSessions: SleepSession[];
}

export function emptyBatch(): ParsedBatch {
  return {
    exercises: [],
    heartRateHourly: [],
    hydration: [],
    nutrition: [],
    observations: [],
    sleepSessions: [],
  };
}

export function mergeBatches(batches: ParsedBatch[]): ParsedBatch {
  const out = emptyBatch();
  for (const b of batches) {
    out.observations.push(...b.observations);
    out.sleepSessions.push(...b.sleepSessions);
    out.exercises.push(...b.exercises);
    out.nutrition.push(...b.nutrition);
    out.hydration.push(...b.hydration);
    out.heartRateHourly.push(...b.heartRateHourly);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Data type registry
// ---------------------------------------------------------------------------

export interface DataTypeSpec {
  /** Field path used to build an AIP-160 filter, when supported. */
  filterField?: string;
  id: DataTypeId;
  /** Newest instant present in a page, for watermarking. Null if unknown. */
  newestTimestamp: (points: ApiDataPoint[]) => string | null;
  /** Max records per page. sleep and exercise are hard-capped at 25. */
  pageSize: number;
  /** Parse one API page into normalized records. Must be pure and total. */
  parse: (points: ApiDataPoint[]) => ParsedBatch;
  /**
   * Whether the API accepts AIP-160 date filters on this type.
   * `heart-rate` and `heart-rate-variability` return 400
   * INVALID_DATA_POINT_FILTER_DATA_TYPE_RESTRICTION and must be false.
   */
  supportsDateFilter: boolean;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface SyncWatermark {
  dataType: DataTypeId;
  lastSyncedAt: string;
  /** ISO 8601 UTC of the newest point successfully persisted. */
  newestTs: string | null;
}

export interface SyncOptions {
  dataTypes?: DataTypeId[];
  /** Ignore watermarks and re-pull the full available window. */
  full?: boolean;
  onProgress?: (event: SyncProgress) => void;
  since?: Date;
}

export interface SyncProgress {
  dataType: DataTypeId;
  done: boolean;
  error?: string;
  pagesFetched: number;
  pointsParsed: number;
  rowsWritten: number;
}

export interface SyncResult {
  dataType: DataTypeId;
  error?: string;
  pagesFetched: number;
  pointsParsed: number;
  rowsWritten: number;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export type TrendDirection = "rising" | "falling" | "flat";

export interface Baseline {
  mean: number;
  metric: MetricId;
  /** Number of days that actually contributed. */
  n: number;
  stddev: number;
  /** Rolling window length in days. */
  windowDays: number;
}

export interface MetricSnapshot {
  baseline: Baseline | null;
  date: string;
  /** value - baseline.mean. Null when either side is missing. */
  delta: number | null;
  /** Fractional change vs baseline mean. Null when baseline mean is 0. */
  deltaPct: number | null;
  metric: MetricId;
  trend: TrendDirection | null;
  value: number | null;
}

export type FlagLevel = "yellow" | "red";

export interface Flag {
  baselineMean: number;
  /** Published basis for the threshold, surfaced by `vitals --quiet`. */
  basis: string;
  level: FlagLevel;
  message: string;
  metric: MetricId;
  value: number;
}

export interface DailySummary {
  checkin: Checkin | null;
  date: string;
  flags: Flag[];
  hrv: MetricSnapshot;
  /** True when 2+ red flags agree, raising confidence to 80-90%. */
  multiMarker: boolean;
  respRate: MetricSnapshot;
  rhr: MetricSnapshot;
  skinTemp: MetricSnapshot;
  sleep: SleepSession | null;
  spo2: MetricSnapshot;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type VitalsErrorCode =
  | "AUTH_MISSING"
  | "AUTH_REFRESH_FAILED"
  | "API_HTTP"
  | "API_FILTER_UNSUPPORTED"
  | "DB"
  | "USAGE"
  | "NO_DATA";

export class VitalsError extends Error {
  readonly code: VitalsErrorCode;
  /** Actionable next step shown to the user. */
  readonly hint?: string;
  override readonly cause?: unknown;

  constructor(
    code: VitalsErrorCode,
    message: string,
    opts?: { hint?: string; cause?: unknown }
  ) {
    super(message);
    this.name = "VitalsError";
    this.code = code;
    this.hint = opts?.hint;
    this.cause = opts?.cause;
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface Paths {
  /** vitals' own OAuth credentials, written by `vitals auth`. */
  credentialsFile: string;
  dataDir: string;
  dbFile: string;
  /**
   * Optional external credential file supplied via `VITALS_GOOGLE_TOKEN`, for
   * reusing a refresh token another tool already holds. Read, never written:
   * the owning tool may refresh it concurrently.
   */
  externalCredentialsFile: string | null;
  /** Short-lived access tokens minted from a refresh token. */
  tokenCacheFile: string;
}

export interface AccessToken {
  /** ISO 8601 UTC. */
  expiresAt: string;
  token: string;
}
