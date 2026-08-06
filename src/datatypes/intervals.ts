/**
 * Interval-based data types: steps, distance, active-zone-minutes,
 * active-energy-burned.
 *
 * All four are keyed by AIP-160-filterable half-open intervals. `date` is the
 * local calendar day the interval STARTS on; `ts` is the normalized start
 * instant; the natural key is derived from the (normalized) start instant so
 * re-syncs upsert cleanly instead of duplicating rows.
 */
import type { ApiDataPoint, ApiInterval, DataTypeSpec, ParsedBatch } from '../types.js';
import { METRICS, emptyBatch } from '../types.js';
import { localDateOfIntervalStart, toIsoUtc, toNumber } from '../util/time.js';

function intervalOf(point: ApiDataPoint, payloadKey: string): ApiInterval | null {
  const payload = point[payloadKey];
  if (!payload || typeof payload !== 'object') return null;
  const interval = (payload as Record<string, unknown>).interval;
  if (!interval || typeof interval !== 'object') return null;
  return interval as ApiInterval;
}

function newestTimestampByPayload(points: ApiDataPoint[], payloadKey: string): string | null {
  let newest: string | null = null;
  for (const point of points) {
    const interval = intervalOf(point, payloadKey);
    if (!interval?.startTime) continue;
    const ts = toIsoUtc(interval.startTime);
    if (!ts) continue;
    if (newest === null || ts > newest) newest = ts;
  }
  return newest;
}

export const stepsSpec: DataTypeSpec = {
  id: 'steps',
  pageSize: 1000,
  supportsDateFilter: true,
  filterField: 'steps.interval.start_time',
  parse(points: ApiDataPoint[]): ParsedBatch {
    const batch = emptyBatch();
    for (const point of points) {
      const interval = intervalOf(point, 'steps');
      if (!interval?.startTime) continue;
      const payload = point.steps as Record<string, unknown>;
      const count = toNumber(payload.count);
      if (count === null) continue;
      const date = localDateOfIntervalStart(interval);
      const ts = toIsoUtc(interval.startTime);
      if (!date || !ts) continue;
      batch.observations.push({
        metric: METRICS.steps,
        date,
        ts,
        value: count,
        unit: 'count',
        naturalKey: ts,
        platform: point.dataSource?.platform ?? null,
        recordingMethod: point.dataSource?.recordingMethod ?? null,
      });
    }
    return batch;
  },
  newestTimestamp(points: ApiDataPoint[]): string | null {
    return newestTimestampByPayload(points, 'steps');
  },
};

export const distanceSpec: DataTypeSpec = {
  id: 'distance',
  pageSize: 1000,
  supportsDateFilter: true,
  filterField: 'distance.interval.start_time',
  parse(points: ApiDataPoint[]): ParsedBatch {
    const batch = emptyBatch();
    for (const point of points) {
      const interval = intervalOf(point, 'distance');
      if (!interval?.startTime) continue;
      const payload = point.distance as Record<string, unknown>;
      const millimeters = toNumber(payload.millimeters);
      if (millimeters === null) continue;
      const date = localDateOfIntervalStart(interval);
      const ts = toIsoUtc(interval.startTime);
      if (!date || !ts) continue;
      batch.observations.push({
        metric: METRICS.distanceM,
        date,
        ts,
        value: millimeters / 1000,
        unit: 'm',
        naturalKey: ts,
        platform: point.dataSource?.platform ?? null,
        recordingMethod: point.dataSource?.recordingMethod ?? null,
      });
    }
    return batch;
  },
  newestTimestamp(points: ApiDataPoint[]): string | null {
    return newestTimestampByPayload(points, 'distance');
  },
};

export const activeEnergyBurnedSpec: DataTypeSpec = {
  id: 'active-energy-burned',
  pageSize: 1000,
  supportsDateFilter: true,
  filterField: 'activeEnergyBurned.interval.start_time',
  parse(points: ApiDataPoint[]): ParsedBatch {
    const batch = emptyBatch();
    for (const point of points) {
      const interval = intervalOf(point, 'activeEnergyBurned');
      if (!interval?.startTime) continue;
      const payload = point.activeEnergyBurned as Record<string, unknown>;
      const kcal = toNumber(payload.kcal);
      if (kcal === null) continue;
      const date = localDateOfIntervalStart(interval);
      const ts = toIsoUtc(interval.startTime);
      if (!date || !ts) continue;
      batch.observations.push({
        metric: METRICS.activeEnergyKcal,
        date,
        ts,
        value: kcal,
        unit: 'kcal',
        naturalKey: ts,
        platform: point.dataSource?.platform ?? null,
        recordingMethod: point.dataSource?.recordingMethod ?? null,
      });
    }
    return batch;
  },
  newestTimestamp(points: ApiDataPoint[]): string | null {
    return newestTimestampByPayload(points, 'activeEnergyBurned');
  },
};

export const activeZoneMinutesSpec: DataTypeSpec = {
  id: 'active-zone-minutes',
  pageSize: 1000,
  supportsDateFilter: true,
  filterField: 'activeZoneMinutes.interval.start_time',
  parse(points: ApiDataPoint[]): ParsedBatch {
    const batch = emptyBatch();
    for (const point of points) {
      const interval = intervalOf(point, 'activeZoneMinutes');
      if (!interval?.startTime) continue;
      const payload = point.activeZoneMinutes as Record<string, unknown>;
      const minutes = toNumber(payload.activeZoneMinutes);
      if (minutes === null) continue;
      const zone = typeof payload.heartRateZone === 'string' ? payload.heartRateZone : 'UNKNOWN';
      const date = localDateOfIntervalStart(interval);
      const ts = toIsoUtc(interval.startTime);
      if (!date || !ts) continue;
      batch.observations.push({
        metric: METRICS.activeZoneMinutes,
        date,
        ts,
        value: minutes,
        unit: 'min',
        naturalKey: `${ts}|${zone}`,
        platform: point.dataSource?.platform ?? null,
        recordingMethod: point.dataSource?.recordingMethod ?? null,
      });
    }
    return batch;
  },
  newestTimestamp(points: ApiDataPoint[]): string | null {
    return newestTimestampByPayload(points, 'activeZoneMinutes');
  },
};
