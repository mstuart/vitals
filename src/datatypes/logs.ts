/**
 * Log-style interval data types: nutrition-log, hydration-log.
 *
 * Both support AIP-160 date filtering. `date` is the local day the interval
 * STARTS on; `ts` is the normalized start instant.
 */
import type { ApiDataPoint, ApiInterval, DataTypeSpec, ParsedBatch } from '../types.js';
import { emptyBatch } from '../types.js';
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

const NUTRIENT_FIELD: Record<string, 'proteinG' | 'carbsG' | 'fatG'> = {
  PROTEIN: 'proteinG',
  CARBOHYDRATES: 'carbsG',
  FAT: 'fatG',
};

export const nutritionLogSpec: DataTypeSpec = {
  id: 'nutrition-log',
  pageSize: 1000,
  supportsDateFilter: true,
  filterField: 'nutritionLog.interval.start_time',
  parse(points: ApiDataPoint[]): ParsedBatch {
    const batch = emptyBatch();
    for (const point of points) {
      const interval = intervalOf(point, 'nutritionLog');
      if (!interval?.startTime) continue;
      const payload = point.nutritionLog as Record<string, unknown>;
      const date = localDateOfIntervalStart(interval);
      const ts = toIsoUtc(interval.startTime);
      if (!date || !ts) continue;

      const foodDisplayName =
        typeof payload.foodDisplayName === 'string' ? payload.foodDisplayName : null;
      const mealType = typeof payload.mealType === 'string' ? payload.mealType : null;

      const energy = payload.energy;
      const energyKcal =
        energy && typeof energy === 'object'
          ? toNumber((energy as Record<string, unknown>).kcal)
          : null;

      let proteinG: number | null = null;
      let carbsG: number | null = null;
      let fatG: number | null = null;
      const nutrients = payload.nutrients;
      if (Array.isArray(nutrients)) {
        for (const entry of nutrients) {
          if (!entry || typeof entry !== 'object') continue;
          const nutrient = (entry as Record<string, unknown>).nutrient;
          if (typeof nutrient !== 'string') continue;
          const field = NUTRIENT_FIELD[nutrient];
          if (!field) continue;
          const quantity = (entry as Record<string, unknown>).quantity;
          const grams =
            quantity && typeof quantity === 'object'
              ? toNumber((quantity as Record<string, unknown>).grams)
              : null;
          if (field === 'proteinG') proteinG = grams;
          else if (field === 'carbsG') carbsG = grams;
          else fatG = grams;
        }
      }

      batch.nutrition.push({
        naturalKey: `${ts}|${foodDisplayName ?? ''}`,
        date,
        ts,
        foodDisplayName,
        mealType,
        energyKcal,
        proteinG,
        carbsG,
        fatG,
      });
    }
    return batch;
  },
  newestTimestamp(points: ApiDataPoint[]): string | null {
    return newestTimestampByPayload(points, 'nutritionLog');
  },
};

export const hydrationLogSpec: DataTypeSpec = {
  id: 'hydration-log',
  pageSize: 1000,
  supportsDateFilter: true,
  filterField: 'hydrationLog.interval.start_time',
  parse(points: ApiDataPoint[]): ParsedBatch {
    const batch = emptyBatch();
    for (const point of points) {
      const interval = intervalOf(point, 'hydrationLog');
      if (!interval?.startTime) continue;
      const payload = point.hydrationLog as Record<string, unknown>;
      const amountConsumed = payload.amountConsumed;
      const milliliters =
        amountConsumed && typeof amountConsumed === 'object'
          ? toNumber((amountConsumed as Record<string, unknown>).milliliters)
          : null;
      if (milliliters === null) continue;
      const date = localDateOfIntervalStart(interval);
      const ts = toIsoUtc(interval.startTime);
      if (!date || !ts) continue;

      batch.hydration.push({
        naturalKey: ts,
        date,
        ts,
        milliliters,
      });
    }
    return batch;
  },
  newestTimestamp(points: ApiDataPoint[]): string | null {
    return newestTimestampByPayload(points, 'hydrationLog');
  },
};
