/**
 * Log-style interval data types: nutrition-log, hydration-log.
 *
 * Both support AIP-160 date filtering. `date` is the local day the interval
 * STARTS on; `ts` is the normalized start instant.
 */
import type {
  ApiDataPoint,
  ApiInterval,
  DataTypeSpec,
  ParsedBatch,
} from "../types.js";
import { emptyBatch } from "../types.js";
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

const NUTRIENT_FIELD: Record<string, "proteinG" | "carbsG" | "fatG"> = {
  CARBOHYDRATES: "carbsG",
  FAT: "fatG",
  PROTEIN: "proteinG",
};

export const nutritionLogSpec: DataTypeSpec = {
  filterField: "nutritionLog.interval.start_time",
  id: "nutrition-log",
  newestTimestamp(points: ApiDataPoint[]): string | null {
    return newestTimestampByPayload(points, "nutritionLog");
  },
  pageSize: 1000,
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Nutrition parsing validates one nested API payload atomically.
  parse(points: ApiDataPoint[]): ParsedBatch {
    const batch = emptyBatch();
    for (const point of points) {
      const interval = intervalOf(point, "nutritionLog");
      if (!interval?.startTime) {
        continue;
      }
      const payload = point.nutritionLog as Record<string, unknown>;
      const date = localDateOfIntervalStart(interval);
      const ts = toIsoUtc(interval.startTime);
      if (!(date && ts)) {
        continue;
      }

      const foodDisplayName =
        typeof payload.foodDisplayName === "string"
          ? payload.foodDisplayName
          : null;
      const mealType =
        typeof payload.mealType === "string" ? payload.mealType : null;

      const { energy, nutrients } = payload;
      const energyKcal =
        energy && typeof energy === "object"
          ? toNumber((energy as Record<string, unknown>).kcal)
          : null;

      let proteinG: number | null = null;
      let carbsG: number | null = null;
      let fatG: number | null = null;
      if (Array.isArray(nutrients)) {
        for (const entry of nutrients) {
          if (!entry || typeof entry !== "object") {
            continue;
          }
          const { nutrient, quantity } = entry as Record<string, unknown>;
          if (typeof nutrient !== "string") {
            continue;
          }
          const field = NUTRIENT_FIELD[nutrient];
          if (!field) {
            continue;
          }
          const grams =
            quantity && typeof quantity === "object"
              ? toNumber((quantity as Record<string, unknown>).grams)
              : null;
          if (field === "proteinG") {
            proteinG = grams;
          } else if (field === "carbsG") {
            carbsG = grams;
          } else {
            fatG = grams;
          }
        }
      }

      batch.nutrition.push({
        carbsG,
        date,
        energyKcal,
        fatG,
        foodDisplayName,
        mealType,
        naturalKey: `${ts}|${foodDisplayName ?? ""}`,
        proteinG,
        ts,
      });
    }
    return batch;
  },
  supportsDateFilter: true,
};

export const hydrationLogSpec: DataTypeSpec = {
  filterField: "hydrationLog.interval.start_time",
  id: "hydration-log",
  newestTimestamp(points: ApiDataPoint[]): string | null {
    return newestTimestampByPayload(points, "hydrationLog");
  },
  pageSize: 1000,
  parse(points: ApiDataPoint[]): ParsedBatch {
    const batch = emptyBatch();
    for (const point of points) {
      const interval = intervalOf(point, "hydrationLog");
      if (!interval?.startTime) {
        continue;
      }
      const payload = point.hydrationLog as Record<string, unknown>;
      const { amountConsumed } = payload;
      const milliliters =
        amountConsumed && typeof amountConsumed === "object"
          ? toNumber((amountConsumed as Record<string, unknown>).milliliters)
          : null;
      if (milliliters === null) {
        continue;
      }
      const date = localDateOfIntervalStart(interval);
      const ts = toIsoUtc(interval.startTime);
      if (!(date && ts)) {
        continue;
      }

      batch.hydration.push({
        date,
        milliliters,
        naturalKey: ts,
        ts,
      });
    }
    return batch;
  },
  supportsDateFilter: true,
};
