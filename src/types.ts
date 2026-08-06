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
  'steps',
  'distance',
  'heart-rate',
  'heart-rate-variability',
  'daily-heart-rate-variability',
  'daily-resting-heart-rate',
  'daily-oxygen-saturation',
  'sleep',
  'daily-respiratory-rate',
  'respiratory-rate-sleep-summary',
  'daily-sleep-temperature-derivations',
  'weight',
  'body-fat',
  'exercise',
  'active-zone-minutes',
  'active-energy-burned',
  'nutrition-log',
  'hydration-log',
] as const;

export type DataTypeId = (typeof DATA_TYPE_IDS)[number];

/** `{ year, month, day }` — month and day are 1-based. */
export interface ApiDate {
  year: number;
  month: number;
  day: number;
}

export interface ApiCivilTime {
  date: ApiDate;
  time?: { hours?: number; minutes?: number; seconds?: number };
}

/** A point in time. `physicalTime` is ISO 8601 UTC. */
export interface ApiSampleTime {
  physicalTime: string;
  utcOffset?: string;
  civilTime?: ApiCivilTime;
}

/** A half-open interval [startTime, endTime). */
export interface ApiInterval {
  startTime: string;
  endTime?: string;
  startUtcOffset?: string;
  endUtcOffset?: string;
  civilStartTime?: ApiCivilTime;
  civilEndTime?: ApiCivilTime;
}

export interface ApiDataSource {
  recordingMethod?: string;
  platform?: string;
  device?: Record<string, unknown>;
  application?: { packageName?: string };
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
  name?: string;
  dataSource?: ApiDataSource;
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
  restingHeartRate: 'rhr',
  hrvDailyAvg: 'hrv_daily_avg',
  hrvDeepSleep: 'hrv_deep_sleep',
  hrvSample: 'hrv_sample',
  hrvEntropy: 'hrv_entropy',
  nonRemHeartRate: 'non_rem_hr',
  heartRateSample: 'hr_sample',
  spo2Avg: 'spo2_avg',
  spo2Lower: 'spo2_lower',
  spo2Upper: 'spo2_upper',
  respiratoryRate: 'resp_rate',
  respRateDeepSleep: 'resp_rate_deep',
  respRateRemSleep: 'resp_rate_rem',
  respRateLightSleep: 'resp_rate_light',
  respRateFullSleep: 'resp_rate_full',
  skinTempNightly: 'skin_temp_nightly',
  skinTempBaseline: 'skin_temp_baseline',
  skinTempStddev30d: 'skin_temp_stddev_30d',
  weightKg: 'weight_kg',
  bodyFatPct: 'body_fat_pct',
  steps: 'steps',
  distanceM: 'distance_m',
  activeEnergyKcal: 'active_energy_kcal',
  activeZoneMinutes: 'azm',
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
  metric: MetricId;
  date: string;
  ts: string | null;
  value: number;
  unit: string;
  /** Natural key for idempotent upsert: unique per (metric, naturalKey). */
  naturalKey: string;
  platform: string | null;
  recordingMethod: string | null;
}

export type SleepStageType = 'AWAKE' | 'LIGHT' | 'DEEP' | 'REM';

export interface SleepStage {
  type: SleepStageType;
  startTs: string;
  endTs: string;
  minutes: number;
}

export interface SleepSession {
  naturalKey: string;
  /** Local calendar day the sleep session ENDS on — the "night of" waking. */
  date: string;
  startTs: string;
  endTs: string;
  type: string | null;
  totalMinutes: number;
  asleepMinutes: number;
  awakeMinutes: number;
  deepMinutes: number;
  remMinutes: number;
  lightMinutes: number;
  /** asleepMinutes / totalMinutes, 0..1. Null when totalMinutes is 0. */
  efficiency: number | null;
  stages: SleepStage[];
  platform: string | null;
}

export interface ExerciseSession {
  naturalKey: string;
  date: string;
  startTs: string;
  endTs: string | null;
  displayName: string | null;
  exerciseType: string | null;
  intensity: string | null;
  avgHeartRate: number | null;
  caloriesBurned: number | null;
  platform: string | null;
}

export interface NutritionEntry {
  naturalKey: string;
  date: string;
  ts: string;
  foodDisplayName: string | null;
  mealType: string | null;
  energyKcal: number | null;
  proteinG: number | null;
  carbsG: number | null;
  fatG: number | null;
}

export interface HydrationEntry {
  naturalKey: string;
  date: string;
  ts: string;
  milliliters: number;
}

/** Hourly aggregate of raw heart rate. Raw ~1Hz samples are never stored. */
export interface HeartRateHourly {
  naturalKey: string;
  date: string;
  /** ISO 8601 UTC, truncated to the hour. */
  hourTs: string;
  minBpm: number;
  maxBpm: number;
  avgBpm: number;
  sampleCount: number;
}

/** Subjective check-in. The only user-mutable record type. */
export interface Checkin {
  id?: number;
  date: string;
  ts: string;
  /** 1..10 */
  mood: number;
  note: string | null;
  tags: string[];
}

/**
 * Everything a parser can emit. A single API page may yield several kinds
 * (e.g. daily-hrv produces multiple Observations per point).
 */
export interface ParsedBatch {
  observations: Observation[];
  sleepSessions: SleepSession[];
  exercises: ExerciseSession[];
  nutrition: NutritionEntry[];
  hydration: HydrationEntry[];
  heartRateHourly: HeartRateHourly[];
}

export function emptyBatch(): ParsedBatch {
  return {
    observations: [],
    sleepSessions: [],
    exercises: [],
    nutrition: [],
    hydration: [],
    heartRateHourly: [],
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
  id: DataTypeId;
  /** Max records per page. sleep and exercise are hard-capped at 25. */
  pageSize: number;
  /**
   * Whether the API accepts AIP-160 date filters on this type.
   * `heart-rate` and `heart-rate-variability` return 400
   * INVALID_DATA_POINT_FILTER_DATA_TYPE_RESTRICTION and must be false.
   */
  supportsDateFilter: boolean;
  /** Field path used to build an AIP-160 filter, when supported. */
  filterField?: string;
  /** Parse one API page into normalized records. Must be pure and total. */
  parse(points: ApiDataPoint[]): ParsedBatch;
  /** Newest instant present in a page, for watermarking. Null if unknown. */
  newestTimestamp(points: ApiDataPoint[]): string | null;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export interface SyncWatermark {
  dataType: DataTypeId;
  /** ISO 8601 UTC of the newest point successfully persisted. */
  newestTs: string | null;
  lastSyncedAt: string;
}

export interface SyncOptions {
  since?: Date;
  /** Ignore watermarks and re-pull the full available window. */
  full?: boolean;
  dataTypes?: DataTypeId[];
  onProgress?(event: SyncProgress): void;
}

export interface SyncProgress {
  dataType: DataTypeId;
  pagesFetched: number;
  pointsParsed: number;
  rowsWritten: number;
  done: boolean;
  error?: string;
}

export interface SyncResult {
  dataType: DataTypeId;
  pagesFetched: number;
  pointsParsed: number;
  rowsWritten: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export type TrendDirection = 'rising' | 'falling' | 'flat';

export interface Baseline {
  metric: MetricId;
  /** Rolling window length in days. */
  windowDays: number;
  mean: number;
  stddev: number;
  /** Number of days that actually contributed. */
  n: number;
}

export interface MetricSnapshot {
  metric: MetricId;
  date: string;
  value: number | null;
  baseline: Baseline | null;
  /** value - baseline.mean. Null when either side is missing. */
  delta: number | null;
  /** Fractional change vs baseline mean. Null when baseline mean is 0. */
  deltaPct: number | null;
  trend: TrendDirection | null;
}

export type FlagLevel = 'yellow' | 'red';

export interface Flag {
  metric: MetricId;
  level: FlagLevel;
  message: string;
  value: number;
  baselineMean: number;
  /** Published basis for the threshold, surfaced by `vitals --quiet`. */
  basis: string;
}

export interface DailySummary {
  date: string;
  rhr: MetricSnapshot;
  hrv: MetricSnapshot;
  spo2: MetricSnapshot;
  respRate: MetricSnapshot;
  skinTemp: MetricSnapshot;
  sleep: SleepSession | null;
  checkin: Checkin | null;
  flags: Flag[];
  /** True when 2+ red flags agree, raising confidence to 80-90%. */
  multiMarker: boolean;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type VitalsErrorCode =
  | 'AUTH_MISSING'
  | 'AUTH_REFRESH_FAILED'
  | 'API_HTTP'
  | 'API_FILTER_UNSUPPORTED'
  | 'DB'
  | 'USAGE'
  | 'NO_DATA';

export class VitalsError extends Error {
  readonly code: VitalsErrorCode;
  /** Actionable next step shown to the user. */
  readonly hint?: string;
  override readonly cause?: unknown;

  constructor(code: VitalsErrorCode, message: string, opts?: { hint?: string; cause?: unknown }) {
    super(message);
    this.name = 'VitalsError';
    this.code = code;
    this.hint = opts?.hint;
    this.cause = opts?.cause;
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface Paths {
  dataDir: string;
  dbFile: string;
  /** Short-lived access tokens minted from a refresh token. */
  tokenCacheFile: string;
  /** vitals' own OAuth credentials, written by `vitals auth`. */
  credentialsFile: string;
  /**
   * Optional external credential file supplied via `VITALS_GOOGLE_TOKEN`, for
   * reusing a refresh token another tool already holds. Read, never written:
   * the owning tool may refresh it concurrently.
   */
  externalCredentialsFile: string | null;
}

export interface AccessToken {
  token: string;
  /** ISO 8601 UTC. */
  expiresAt: string;
}
