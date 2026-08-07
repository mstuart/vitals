/**
 * Daily aggregate data types: whole-day (or whole-sleep) rollups keyed by
 * calendar date rather than an interval or point sample.
 *
 * All six types here are date-keyed aggregates. The API does not support
 * AIP-160 date filtering on them, so `supportsDateFilter` is false and vitals
 * filters client-side.
 */
import type {
  ApiDataPoint,
  ApiDate,
  ApiSampleTime,
  DataTypeSpec,
  Observation,
  ParsedBatch,
} from '../types.js';
import { METRICS, emptyBatch } from '../types.js';
import { apiDateToIso, localDateOfSample, toNumber } from '../util/time.js';

function platformOf(p: ApiDataPoint): string | null {
  return p.dataSource?.platform ?? null;
}

function recordingMethodOf(p: ApiDataPoint): string | null {
  return p.dataSource?.recordingMethod ?? null;
}

/** Narrow an unknown payload value to a plain record, or null. */
function asRecord(v: unknown): Record<string, unknown> | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

/**
 * Shared parse loop for the five `daily-*` types: one payload object keyed by
 * `payloadKey`, dated via `payload.date`, producing whole-day observations
 * (ts null) via `extract`.
 */
function parseDailyAggregate(
  points: ApiDataPoint[],
  payloadKey: string,
  extract: (payload: Record<string, unknown>) => Array<{ metric: (typeof METRICS)[keyof typeof METRICS]; value: number | null; unit: string }>,
): ParsedBatch {
  const batch = emptyBatch();
  for (const point of points) {
    const payload = asRecord(point[payloadKey]);
    if (!payload) continue;
    const date = apiDateToIso(payload.date as ApiDate | undefined);
    if (!date) continue;
    const platform = platformOf(point);
    const recordingMethod = recordingMethodOf(point);
    for (const { metric, value, unit } of extract(payload)) {
      if (value === null) continue;
      const obs: Observation = {
        metric,
        date,
        ts: null,
        value,
        unit,
        naturalKey: date,
        platform,
        recordingMethod,
      };
      batch.observations.push(obs);
    }
  }
  return batch;
}

/** Newest date among daily-aggregate points, as a UTC midnight instant. */
function newestDailyTimestamp(points: ApiDataPoint[], payloadKey: string): string | null {
  let newest: string | null = null;
  for (const point of points) {
    const payload = asRecord(point[payloadKey]);
    if (!payload) continue;
    const date = apiDateToIso(payload.date as ApiDate | undefined);
    if (!date) continue;
    const iso = `${date}T00:00:00.000Z`;
    if (newest === null || iso > newest) newest = iso;
  }
  return newest;
}

// ---------------------------------------------------------------------------
// daily-resting-heart-rate
// ---------------------------------------------------------------------------

export const dailyRestingHeartRateSpec: DataTypeSpec = {
  id: 'daily-resting-heart-rate',
  pageSize: 35,
  supportsDateFilter: false,
  parse(points) {
    return parseDailyAggregate(points, 'dailyRestingHeartRate', (payload) => [
      { metric: METRICS.restingHeartRate, value: toNumber(payload.beatsPerMinute), unit: 'bpm' },
    ]);
  },
  newestTimestamp(points) {
    return newestDailyTimestamp(points, 'dailyRestingHeartRate');
  },
};

/** Treat a 0 reading as "not measured" rather than a real value. */
function nonZero(value: number | null): number | null {
  return value === null || value === 0 ? null : value;
}

// ---------------------------------------------------------------------------
// daily-heart-rate-variability
// ---------------------------------------------------------------------------

export const dailyHeartRateVariabilitySpec: DataTypeSpec = {
  id: 'daily-heart-rate-variability',
  pageSize: 35,
  supportsDateFilter: false,
  parse(points) {
    return parseDailyAggregate(points, 'dailyHeartRateVariability', (payload) => [
      {
        metric: METRICS.hrvDailyAvg,
        value: toNumber(payload.averageHeartRateVariabilityMilliseconds),
        unit: 'ms',
      },
      {
        metric: METRICS.hrvDeepSleep,
        // A 0 here means deep-sleep HRV was not derived for that night, not
        // that variability was zero — which is physiologically impossible in a
        // living person. Stored as a real value it drags any correlation
        // against it the wrong way, so drop it as missing.
        value: nonZero(toNumber(payload.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds)),
        unit: 'ms',
      },
      {
        metric: METRICS.nonRemHeartRate,
        value: toNumber(payload.nonRemHeartRateBeatsPerMinute),
        unit: 'bpm',
      },
      { metric: METRICS.hrvEntropy, value: toNumber(payload.entropy), unit: '' },
    ]);
  },
  newestTimestamp(points) {
    return newestDailyTimestamp(points, 'dailyHeartRateVariability');
  },
};

// ---------------------------------------------------------------------------
// daily-oxygen-saturation
// ---------------------------------------------------------------------------

/**
 * Percentages at or below this are sensor artifacts from the band losing
 * skin contact (commonly reported as exactly 50.0), not genuine readings.
 * Genuine desaturations reach the 70s, so the threshold is 70, not 90.
 */
const SPO2_ARTIFACT_MAX = 70;

export const dailyOxygenSaturationSpec: DataTypeSpec = {
  id: 'daily-oxygen-saturation',
  pageSize: 35,
  supportsDateFilter: false,
  parse(points) {
    return parseDailyAggregate(points, 'dailyOxygenSaturation', (payload) => {
      const avg = toNumber(payload.averagePercentage);
      const lower = toNumber(payload.lowerBoundPercentage);
      const upper = toNumber(payload.upperBoundPercentage);
      return [
        {
          metric: METRICS.spo2Avg,
          value: avg !== null && avg > SPO2_ARTIFACT_MAX ? avg : null,
          unit: 'pct',
        },
        {
          metric: METRICS.spo2Lower,
          value: lower !== null && lower > SPO2_ARTIFACT_MAX ? lower : null,
          unit: 'pct',
        },
        {
          metric: METRICS.spo2Upper,
          value: upper !== null && upper > SPO2_ARTIFACT_MAX ? upper : null,
          unit: 'pct',
        },
      ];
    });
  },
  newestTimestamp(points) {
    return newestDailyTimestamp(points, 'dailyOxygenSaturation');
  },
};

// ---------------------------------------------------------------------------
// daily-respiratory-rate
// ---------------------------------------------------------------------------

export const dailyRespiratoryRateSpec: DataTypeSpec = {
  id: 'daily-respiratory-rate',
  pageSize: 35,
  supportsDateFilter: false,
  parse(points) {
    return parseDailyAggregate(points, 'dailyRespiratoryRate', (payload) => [
      { metric: METRICS.respiratoryRate, value: toNumber(payload.breathsPerMinute), unit: 'brpm' },
    ]);
  },
  newestTimestamp(points) {
    return newestDailyTimestamp(points, 'dailyRespiratoryRate');
  },
};

// ---------------------------------------------------------------------------
// daily-sleep-temperature-derivations
// ---------------------------------------------------------------------------

export const dailySleepTemperatureDerivationsSpec: DataTypeSpec = {
  id: 'daily-sleep-temperature-derivations',
  pageSize: 35,
  supportsDateFilter: false,
  parse(points) {
    return parseDailyAggregate(points, 'dailySleepTemperatureDerivations', (payload) => [
      {
        metric: METRICS.skinTempNightly,
        value: toNumber(payload.nightlyTemperatureCelsius),
        unit: 'C',
      },
      {
        // Genuinely NaN for the first 7-30 days of history; toNumber() maps
        // NaN to null, which parseDailyAggregate skips.
        metric: METRICS.skinTempBaseline,
        value: toNumber(payload.baselineTemperatureCelsius),
        unit: 'C',
      },
      {
        metric: METRICS.skinTempStddev30d,
        value: toNumber(payload.relativeNightlyStddev30dCelsius),
        unit: 'C',
      },
    ]);
  },
  newestTimestamp(points) {
    return newestDailyTimestamp(points, 'dailySleepTemperatureDerivations');
  },
};

// ---------------------------------------------------------------------------
// respiratory-rate-sleep-summary
// ---------------------------------------------------------------------------

/** A breathsPerMinute of 0 means "not detected" for that sleep stage. */
function statBreathsPerMinute(payload: Record<string, unknown>, key: string): number | null {
  const stats = asRecord(payload[key]);
  if (!stats) return null;
  const value = toNumber(stats.breathsPerMinute);
  if (value === null || value === 0) return null;
  return value;
}

export const respiratoryRateSleepSummarySpec: DataTypeSpec = {
  id: 'respiratory-rate-sleep-summary',
  pageSize: 35,
  supportsDateFilter: false,
  parse(points) {
    const batch = emptyBatch();
    for (const point of points) {
      const payload = asRecord(point.respiratoryRateSleepSummary);
      if (!payload) continue;
      const sampleTime = asRecord(payload.sampleTime) as ApiSampleTime | null;
      if (!sampleTime) continue;
      const physicalTime = sampleTime.physicalTime;
      if (typeof physicalTime !== 'string' || physicalTime === '') continue;
      const date = localDateOfSample(sampleTime);
      if (!date) continue;

      const platform = platformOf(point);
      const recordingMethod = recordingMethodOf(point);
      const entries: Array<{ metric: (typeof METRICS)[keyof typeof METRICS]; key: string }> = [
        { metric: METRICS.respRateFullSleep, key: 'fullSleepStats' },
        { metric: METRICS.respRateDeepSleep, key: 'deepSleepStats' },
        { metric: METRICS.respRateRemSleep, key: 'remSleepStats' },
        { metric: METRICS.respRateLightSleep, key: 'lightSleepStats' },
      ];

      for (const { metric, key } of entries) {
        const value = statBreathsPerMinute(payload, key);
        if (value === null) continue;
        const obs: Observation = {
          metric,
          date,
          ts: physicalTime,
          value,
          unit: 'brpm',
          naturalKey: date,
          platform,
          recordingMethod,
        };
        batch.observations.push(obs);
      }
    }
    return batch;
  },
  newestTimestamp(points) {
    let newest: string | null = null;
    for (const point of points) {
      const payload = asRecord(point.respiratoryRateSleepSummary);
      if (!payload) continue;
      const sampleTime = asRecord(payload.sampleTime);
      if (!sampleTime) continue;
      const physicalTime = sampleTime.physicalTime;
      if (typeof physicalTime !== 'string' || physicalTime === '') continue;
      if (newest === null || physicalTime > newest) newest = physicalTime;
    }
    return newest;
  },
};
