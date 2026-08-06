/**
 * sleep + exercise data types.
 *
 * Both are hard-capped at pageSize 25 by the API and do not support AIP-160
 * date filtering.
 */
import type {
  ApiDataPoint,
  ApiInterval,
  DataTypeSpec,
  ExerciseSession,
  ParsedBatch,
  SleepStage,
  SleepStageType,
} from '../types.js';
import { emptyBatch } from '../types.js';
import { localDateOfIntervalEnd, minutesBetween, toNumber } from '../util/time.js';

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

interface RawSleepStage {
  type?: string;
  startTime?: string;
  endTime?: string;
}

interface RawSleep {
  interval?: ApiInterval;
  type?: string;
  stages?: RawSleepStage[];
}

const SLEEP_STAGE_TYPES: readonly SleepStageType[] = ['AWAKE', 'LIGHT', 'DEEP', 'REM'];

function isSleepStageType(v: string | undefined): v is SleepStageType {
  return v !== undefined && (SLEEP_STAGE_TYPES as readonly string[]).includes(v);
}

/** Empty string -> null. Everything else passed through unchanged. */
function nullIfEmpty(v: string | null | undefined): string | null {
  if (v === undefined || v === null || v === '') return null;
  return v;
}

function parseSleepPoint(point: ApiDataPoint, batch: ParsedBatch): void {
  const raw = point['sleep'] as RawSleep | undefined;
  if (!raw) return;

  const interval = raw.interval;
  const startTs = interval?.startTime;
  const endTs = interval?.endTime;
  if (!interval || !startTs || !endTs) return;

  const date = localDateOfIntervalEnd(interval);
  if (!date) return;

  const totalMinutes = minutesBetween(startTs, endTs);

  const stages: SleepStage[] = [];
  let deepMinutes = 0;
  let remMinutes = 0;
  let lightMinutes = 0;
  let awakeMinutes = 0;

  for (const rawStage of raw.stages ?? []) {
    const stageType = rawStage.type;
    const stageStart = rawStage.startTime;
    const stageEnd = rawStage.endTime;
    if (!isSleepStageType(stageType) || !stageStart || !stageEnd) continue;

    const minutes = minutesBetween(stageStart, stageEnd);
    stages.push({ type: stageType, startTs: stageStart, endTs: stageEnd, minutes });

    switch (stageType) {
      case 'DEEP':
        deepMinutes += minutes;
        break;
      case 'REM':
        remMinutes += minutes;
        break;
      case 'LIGHT':
        lightMinutes += minutes;
        break;
      case 'AWAKE':
        awakeMinutes += minutes;
        break;
    }
  }

  const asleepMinutes = deepMinutes + remMinutes + lightMinutes;
  // A stage-less CLASSIC session has no basis for an efficiency figure at
  // all (not "0% asleep") — null it rather than reporting a false zero.
  const efficiency =
    stages.length === 0 || totalMinutes === 0 ? null : asleepMinutes / totalMinutes;

  batch.sleepSessions.push({
    naturalKey: startTs,
    date,
    startTs,
    endTs,
    type: nullIfEmpty(raw.type),
    totalMinutes,
    asleepMinutes,
    awakeMinutes,
    deepMinutes,
    remMinutes,
    lightMinutes,
    efficiency,
    stages,
    platform: point.dataSource?.platform ?? null,
  });
}

export const sleepSpec: DataTypeSpec = {
  id: 'sleep',
  pageSize: 25,
  supportsDateFilter: false,
  parse(points: ApiDataPoint[]): ParsedBatch {
    const batch = emptyBatch();
    for (const point of points) {
      try {
        parseSleepPoint(point, batch);
      } catch {
        // skip malformed point
      }
    }
    return batch;
  },
  newestTimestamp(points: ApiDataPoint[]): string | null {
    let newest: string | null = null;
    for (const point of points) {
      const raw = point['sleep'] as RawSleep | undefined;
      const end = raw?.interval?.endTime ?? raw?.interval?.startTime;
      if (!end) continue;
      if (newest === null || end > newest) newest = end;
    }
    return newest;
  },
};

// ---------------------------------------------------------------------------
// exercise
// ---------------------------------------------------------------------------

interface RawExerciseMetricsSummary {
  averageHeartRateBeatsPerMinute?: unknown;
  caloriesBurned?: unknown;
  caloriesKcal?: unknown;
}

interface RawExercise {
  interval?: ApiInterval;
  displayName?: string;
  exerciseType?: string;
  intensity?: string;
  metricsSummary?: RawExerciseMetricsSummary;
}

/**
 * caloriesBurned may show up under different keys/shapes across sources:
 * a bare scalar (`caloriesKcal: 222`), a string scalar, or an object with a
 * kcal/energy field. Try the known shapes defensively.
 */
function extractCaloriesBurned(summary: RawExerciseMetricsSummary | undefined): number | null {
  if (!summary) return null;

  const direct = toNumber(summary.caloriesBurned);
  if (direct !== null) return direct;

  if (summary.caloriesBurned && typeof summary.caloriesBurned === 'object') {
    const obj = summary.caloriesBurned as Record<string, unknown>;
    const kcal = toNumber(obj['kcal'] ?? obj['energy'] ?? obj['value']);
    if (kcal !== null) return kcal;
  }

  return toNumber(summary.caloriesKcal);
}

function parseExercisePoint(point: ApiDataPoint, batch: ParsedBatch): void {
  const raw = point['exercise'] as RawExercise | undefined;
  if (!raw) return;

  const interval = raw.interval;
  const startTs = interval?.startTime;
  if (!interval || !startTs) return;

  const date = localDateOfIntervalEnd(interval);
  if (!date) return;

  const endTs = interval.endTime ?? null;
  const summary = raw.metricsSummary;

  const session: ExerciseSession = {
    naturalKey: startTs,
    date,
    startTs,
    endTs,
    displayName: nullIfEmpty(raw.displayName),
    exerciseType: nullIfEmpty(raw.exerciseType),
    intensity: nullIfEmpty(raw.intensity),
    avgHeartRate: toNumber(summary?.averageHeartRateBeatsPerMinute),
    caloriesBurned: extractCaloriesBurned(summary),
    platform: point.dataSource?.platform ?? null,
  };

  batch.exercises.push(session);
}

export const exerciseSpec: DataTypeSpec = {
  id: 'exercise',
  pageSize: 25,
  supportsDateFilter: false,
  parse(points: ApiDataPoint[]): ParsedBatch {
    const batch = emptyBatch();
    for (const point of points) {
      try {
        parseExercisePoint(point, batch);
      } catch {
        // skip malformed point
      }
    }
    return batch;
  },
  newestTimestamp(points: ApiDataPoint[]): string | null {
    let newest: string | null = null;
    for (const point of points) {
      const raw = point['exercise'] as RawExercise | undefined;
      const ts = raw?.interval?.endTime ?? raw?.interval?.startTime;
      if (!ts) continue;
      if (newest === null || ts > newest) newest = ts;
    }
    return newest;
  },
};
