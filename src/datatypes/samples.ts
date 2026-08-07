/**
 * Point-sample data types: heart-rate (raw, aggregated to hourly buckets),
 * heart-rate-variability, weight, body-fat.
 *
 * heart-rate and heart-rate-variability reject AIP-160 date filters with
 * HTTP 400 INVALID_DATA_POINT_FILTER_DATA_TYPE_RESTRICTION — verified
 * behaviour, not a guess. Both must set supportsDateFilter: false and omit
 * filterField.
 */
import type {
  ApiCivilTime,
  ApiDataPoint,
  ApiSampleTime,
  DataTypeSpec,
  HeartRateHourly,
  Observation,
  ParsedBatch,
} from '../types.js';
import { METRICS, emptyBatch } from '../types.js';
import { localDateOfSample, toIsoUtc, toNumber, truncateToHour } from '../util/time.js';

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
}

/** Extract an `ApiSampleTime` from an unknown payload field, tolerating malformed input. */
function asSampleTime(v: unknown): ApiSampleTime | undefined {
  const r = asRecord(v);
  if (!r) return undefined;
  const physicalTime = r['physicalTime'];
  if (typeof physicalTime !== 'string') return undefined;
  const utcOffset = typeof r['utcOffset'] === 'string' ? r['utcOffset'] : undefined;
  const civilTime = r['civilTime'] as ApiCivilTime | undefined;
  return { physicalTime, utcOffset, civilTime };
}

function platformOf(point: ApiDataPoint): string | null {
  return point.dataSource?.platform ?? null;
}

function recordingMethodOf(point: ApiDataPoint): string | null {
  return point.dataSource?.recordingMethod ?? null;
}

/** Newest physicalTime among points whose `payloadKey` field carries a sampleTime. */
function newestSampleTimestamp(points: ApiDataPoint[], payloadKey: string): string | null {
  let newest: string | null = null;
  let newestMs = -Infinity;
  for (const p of points) {
    const payload = asRecord(p[payloadKey]);
    const sampleTime = payload ? asSampleTime(payload['sampleTime']) : undefined;
    if (!sampleTime) continue;
    const iso = toIsoUtc(sampleTime.physicalTime);
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (Number.isFinite(ms) && ms > newestMs) {
      newestMs = ms;
      newest = iso;
    }
  }
  return newest;
}

/**
 * Treat a 0 as "not measured" for quantities that cannot physiologically be
 * zero in a living person — an RMSSD of 0ms means identical consecutive beats,
 * a heart rate of 0 means no pulse, a weight or body-fat of 0 is nonsense.
 * Stored as real values they silently corrupt averages and correlations.
 */
function nonZero(value: number | null): number | null {
  return value === null || value === 0 ? null : value;
}

/** Build a simple point-sample -> single-Observation parser. */
function makeSampleObservationParser(
  payloadKey: string,
  valueField: string,
  metric: (typeof METRICS)[keyof typeof METRICS],
  unit: string,
): (points: ApiDataPoint[]) => ParsedBatch {
  return (points) => {
    const batch = emptyBatch();
    for (const point of points) {
      const payload = asRecord(point[payloadKey]);
      if (!payload) continue;
      const sampleTime = asSampleTime(payload['sampleTime']);
      if (!sampleTime) continue;
      const value = nonZero(toNumber(payload[valueField]));
      if (value === null) continue;
      const ts = toIsoUtc(sampleTime.physicalTime);
      if (!ts) continue;
      const date = localDateOfSample(sampleTime);
      if (!date) continue;

      const observation: Observation = {
        metric,
        date,
        ts,
        value,
        unit,
        naturalKey: ts,
        platform: platformOf(point),
        recordingMethod: recordingMethodOf(point),
      };
      batch.observations.push(observation);
    }
    return batch;
  };
}

// ---------------------------------------------------------------------------
// heart-rate — aggregated to hourly buckets, no Observations emitted
// ---------------------------------------------------------------------------

interface HourlyAccumulator {
  hourTs: string;
  date: string;
  min: number;
  max: number;
  sum: number;
  count: number;
}

function parseHeartRate(points: ApiDataPoint[]): ParsedBatch {
  const batch = emptyBatch();
  const buckets = new Map<string, HourlyAccumulator>();

  for (const point of points) {
    const payload = asRecord(point['heartRate']);
    if (!payload) continue;
    const sampleTime = asSampleTime(payload['sampleTime']);
    if (!sampleTime) continue;
    const bpm = nonZero(toNumber(payload['beatsPerMinute']));
    if (bpm === null) continue;
    const hourTs = truncateToHour(sampleTime.physicalTime);
    if (!hourTs) continue;
    const date = localDateOfSample(sampleTime);
    if (!date) continue;

    const existing = buckets.get(hourTs);
    if (existing) {
      existing.min = Math.min(existing.min, bpm);
      existing.max = Math.max(existing.max, bpm);
      existing.sum += bpm;
      existing.count += 1;
    } else {
      buckets.set(hourTs, { hourTs, date, min: bpm, max: bpm, sum: bpm, count: 1 });
    }
  }

  for (const acc of buckets.values()) {
    const hourly: HeartRateHourly = {
      naturalKey: acc.hourTs,
      date: acc.date,
      hourTs: acc.hourTs,
      minBpm: acc.min,
      maxBpm: acc.max,
      avgBpm: acc.sum / acc.count,
      sampleCount: acc.count,
    };
    batch.heartRateHourly.push(hourly);
  }

  return batch;
}

export const heartRateSpec: DataTypeSpec = {
  id: 'heart-rate',
  pageSize: 2880,
  supportsDateFilter: false,
  parse: parseHeartRate,
  newestTimestamp: (points) => newestSampleTimestamp(points, 'heartRate'),
};

// ---------------------------------------------------------------------------
// heart-rate-variability
// ---------------------------------------------------------------------------

export const heartRateVariabilitySpec: DataTypeSpec = {
  id: 'heart-rate-variability',
  pageSize: 500,
  supportsDateFilter: false,
  parse: makeSampleObservationParser(
    'heartRateVariability',
    'rootMeanSquareOfSuccessiveDifferencesMilliseconds',
    METRICS.hrvSample,
    'ms',
  ),
  newestTimestamp: (points) => newestSampleTimestamp(points, 'heartRateVariability'),
};

// ---------------------------------------------------------------------------
// weight
// ---------------------------------------------------------------------------

function parseWeight(points: ApiDataPoint[]): ParsedBatch {
  const batch = emptyBatch();
  for (const point of points) {
    const payload = asRecord(point['weight']);
    if (!payload) continue;
    const sampleTime = asSampleTime(payload['sampleTime']);
    if (!sampleTime) continue;
    const grams = nonZero(toNumber(payload['weightGrams']));
    if (grams === null) continue;
    const ts = toIsoUtc(sampleTime.physicalTime);
    if (!ts) continue;
    const date = localDateOfSample(sampleTime);
    if (!date) continue;

    const observation: Observation = {
      metric: METRICS.weightKg,
      date,
      ts,
      value: grams / 1000,
      unit: 'kg',
      naturalKey: ts,
      platform: platformOf(point),
      recordingMethod: recordingMethodOf(point),
    };
    batch.observations.push(observation);
  }
  return batch;
}

export const weightSpec: DataTypeSpec = {
  id: 'weight',
  pageSize: 100,
  supportsDateFilter: true,
  filterField: 'weight.sample_time.physical_time',
  parse: parseWeight,
  newestTimestamp: (points) => newestSampleTimestamp(points, 'weight'),
};

// ---------------------------------------------------------------------------
// body-fat
// ---------------------------------------------------------------------------

export const bodyFatSpec: DataTypeSpec = {
  id: 'body-fat',
  pageSize: 100,
  supportsDateFilter: true,
  filterField: 'body_fat.sample_time.physical_time',
  parse: makeSampleObservationParser('bodyFat', 'percentage', METRICS.bodyFatPct, 'pct'),
  newestTimestamp: (points) => newestSampleTimestamp(points, 'bodyFat'),
};
