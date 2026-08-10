/**
 * Interval-based data types: steps, distance, active-zone-minutes,
 * active-energy-burned.
 *
 * All four are keyed by AIP-160-filterable half-open intervals. `date` is the
 * local calendar day the interval STARTS on; `ts` is the normalized start
 * instant; the natural key is derived from the (normalized) start instant so
 * re-syncs upsert cleanly instead of duplicating rows.
 */
import type {
  ApiDataPoint,
  ApiInterval,
  DataTypeSpec,
  ParsedBatch,
} from "../types.js";
import { emptyBatch, METRICS } from "../types.js";
import { localDateOfIntervalStart, toIsoUtc, toNumber } from "../util/time.js";

function intervalOf(
  point: ApiDataPoint,
  payloadKey: string
): ApiInterval | null {
  const payload = point[payloadKey];
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const { interval } = payload as Record<string, unknown>;
  if (!interval || typeof interval !== "object") {
    return null;
  }
  return interval as ApiInterval;
}

function newestTimestampByPayload(
  points: ApiDataPoint[],
  payloadKey: string
): string | null {
  let newest: string | null = null;
  for (const point of points) {
    const interval = intervalOf(point, payloadKey);
    if (!interval?.startTime) {
      continue;
    }
    const ts = toIsoUtc(interval.startTime);
    if (!ts) {
      continue;
    }
    if (newest === null || ts > newest) {
      newest = ts;
    }
  }
  return newest;
}

export const stepsSpec: DataTypeSpec = {
  filterField: "steps.interval.start_time",
  id: "steps",
  newestTimestamp(points: ApiDataPoint[]): string | null {
    return newestTimestampByPayload(points, "steps");
  },
  pageSize: 1000,
  parse(points: ApiDataPoint[]): ParsedBatch {
    const batch = emptyBatch();
    for (const point of points) {
      const interval = intervalOf(point, "steps");
      if (!interval?.startTime) {
        continue;
      }
      const payload = point.steps as Record<string, unknown>;
      const count = toNumber(payload.count);
      if (count === null) {
        continue;
      }
      const date = localDateOfIntervalStart(interval);
      const ts = toIsoUtc(interval.startTime);
      if (!(date && ts)) {
        continue;
      }
      batch.observations.push({
        date,
        metric: METRICS.steps,
        naturalKey: ts,
        platform: point.dataSource?.platform ?? null,
        recordingMethod: point.dataSource?.recordingMethod ?? null,
        ts,
        unit: "count",
        value: count,
      });
    }
    return batch;
  },
  supportsDateFilter: true,
};

export const distanceSpec: DataTypeSpec = {
  filterField: "distance.interval.start_time",
  id: "distance",
  newestTimestamp(points: ApiDataPoint[]): string | null {
    return newestTimestampByPayload(points, "distance");
  },
  pageSize: 1000,
  parse(points: ApiDataPoint[]): ParsedBatch {
    const batch = emptyBatch();
    for (const point of points) {
      const interval = intervalOf(point, "distance");
      if (!interval?.startTime) {
        continue;
      }
      const payload = point.distance as Record<string, unknown>;
      const millimeters = toNumber(payload.millimeters);
      if (millimeters === null) {
        continue;
      }
      const date = localDateOfIntervalStart(interval);
      const ts = toIsoUtc(interval.startTime);
      if (!(date && ts)) {
        continue;
      }
      batch.observations.push({
        date,
        metric: METRICS.distanceM,
        naturalKey: ts,
        platform: point.dataSource?.platform ?? null,
        recordingMethod: point.dataSource?.recordingMethod ?? null,
        ts,
        unit: "m",
        value: millimeters / 1000,
      });
    }
    return batch;
  },
  supportsDateFilter: true,
};

export const activeEnergyBurnedSpec: DataTypeSpec = {
  filterField: "activeEnergyBurned.interval.start_time",
  id: "active-energy-burned",
  newestTimestamp(points: ApiDataPoint[]): string | null {
    return newestTimestampByPayload(points, "activeEnergyBurned");
  },
  pageSize: 1000,
  parse(points: ApiDataPoint[]): ParsedBatch {
    const batch = emptyBatch();
    for (const point of points) {
      const interval = intervalOf(point, "activeEnergyBurned");
      if (!interval?.startTime) {
        continue;
      }
      const payload = point.activeEnergyBurned as Record<string, unknown>;
      const kcal = toNumber(payload.kcal);
      if (kcal === null) {
        continue;
      }
      const date = localDateOfIntervalStart(interval);
      const ts = toIsoUtc(interval.startTime);
      if (!(date && ts)) {
        continue;
      }
      batch.observations.push({
        date,
        metric: METRICS.activeEnergyKcal,
        naturalKey: ts,
        platform: point.dataSource?.platform ?? null,
        recordingMethod: point.dataSource?.recordingMethod ?? null,
        ts,
        unit: "kcal",
        value: kcal,
      });
    }
    return batch;
  },
  supportsDateFilter: true,
};

export const activeZoneMinutesSpec: DataTypeSpec = {
  filterField: "activeZoneMinutes.interval.start_time",
  id: "active-zone-minutes",
  newestTimestamp(points: ApiDataPoint[]): string | null {
    return newestTimestampByPayload(points, "activeZoneMinutes");
  },
  pageSize: 1000,
  parse(points: ApiDataPoint[]): ParsedBatch {
    const batch = emptyBatch();
    for (const point of points) {
      const interval = intervalOf(point, "activeZoneMinutes");
      if (!interval?.startTime) {
        continue;
      }
      const payload = point.activeZoneMinutes as Record<string, unknown>;
      const minutes = toNumber(payload.activeZoneMinutes);
      if (minutes === null) {
        continue;
      }
      const zone =
        typeof payload.heartRateZone === "string"
          ? payload.heartRateZone
          : "UNKNOWN";
      const date = localDateOfIntervalStart(interval);
      const ts = toIsoUtc(interval.startTime);
      if (!(date && ts)) {
        continue;
      }
      batch.observations.push({
        date,
        metric: METRICS.activeZoneMinutes,
        naturalKey: `${ts}|${zone}`,
        platform: point.dataSource?.platform ?? null,
        recordingMethod: point.dataSource?.recordingMethod ?? null,
        ts,
        unit: "min",
        value: minutes,
      });
    }
    return batch;
  },
  supportsDateFilter: true,
};
