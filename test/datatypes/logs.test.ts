import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  hydrationLogSpec,
  nutritionLogSpec,
} from "../../src/datatypes/logs.js";
import type { ApiDataPoint, ApiDataPointsResponse } from "../../src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name: string): ApiDataPoint[] {
  const raw = readFileSync(
    path.join(__dirname, "..", "fixtures", "api", `${name}.json`),
    "utf-8"
  );
  const parsed = JSON.parse(raw) as ApiDataPointsResponse;
  return parsed.dataPoints ?? [];
}

describe("nutritionLogSpec", () => {
  const points = loadFixture("nutrition-log");

  it("supports date filtering", () => {
    expect(nutritionLogSpec.supportsDateFilter).toBe(true);
    expect(nutritionLogSpec.filterField).toBe(
      "nutritionLog.interval.start_time"
    );
  });

  it("parses an empty page without error", () => {
    expect(nutritionLogSpec.parse([]).nutrition).toEqual([]);
  });

  it("does not throw on a malformed point", () => {
    const malformed: ApiDataPoint[] = [
      { nutritionLog: {} } as unknown as ApiDataPoint,
      { nutritionLog: null } as unknown as ApiDataPoint,
      {} as ApiDataPoint,
    ];
    expect(() => nutritionLogSpec.parse(malformed)).not.toThrow();
    expect(nutritionLogSpec.parse(malformed).nutrition).toEqual([]);
  });

  it("parses the real fixture into nutrition entries", () => {
    const batch = nutritionLogSpec.parse(points);
    expect(batch.nutrition.length).toBeGreaterThan(0);
  });

  it("maps PROTEIN/CARBOHYDRATES/FAT into proteinG/carbsG/fatG", () => {
    const point: ApiDataPoint = {
      nutritionLog: {
        energy: { kcal: 100 },
        foodDisplayName: "Test Food",
        interval: { startTime: "2026-01-01T10:00:00Z" },
        mealType: "DINNER",
        nutrients: [
          { nutrient: "PROTEIN", quantity: { grams: 10 } },
          { nutrient: "CARBOHYDRATES", quantity: { grams: 20 } },
          { nutrient: "FAT", quantity: { grams: 5 } },
          { nutrient: "SODIUM", quantity: { grams: 0.5 } },
        ],
      },
    } as unknown as ApiDataPoint;

    const batch = nutritionLogSpec.parse([point]);
    expect(batch.nutrition).toHaveLength(1);
    const [entry] = batch.nutrition;
    expect(entry?.proteinG).toBe(10);
    expect(entry?.carbsG).toBe(20);
    expect(entry?.fatG).toBe(5);
    expect(entry?.energyKcal).toBe(100);
    expect(entry?.foodDisplayName).toBe("Test Food");
    expect(entry?.mealType).toBe("DINNER");
  });

  it("a missing nutrient is null, not zero", () => {
    const point: ApiDataPoint = {
      nutritionLog: {
        foodDisplayName: "Only Protein",
        interval: { startTime: "2026-01-01T10:00:00Z" },
        nutrients: [{ nutrient: "PROTEIN", quantity: { grams: 8 } }],
      },
    } as unknown as ApiDataPoint;

    const batch = nutritionLogSpec.parse([point]);
    expect(batch.nutrition).toHaveLength(1);
    const [entry] = batch.nutrition;
    expect(entry?.proteinG).toBe(8);
    expect(entry?.carbsG).toBeNull();
    expect(entry?.fatG).toBeNull();
  });

  it("missing/zero energy resolves to null or a plausible number, never NaN", () => {
    const batch = nutritionLogSpec.parse(points);
    for (const entry of batch.nutrition) {
      if (entry.energyKcal === null) {
        continue;
      }
      expect(Number.isFinite(entry.energyKcal)).toBe(true);
    }
  });

  it("natural key combines start instant and food display name", () => {
    const point: ApiDataPoint = {
      nutritionLog: {
        foodDisplayName: "Apple",
        interval: { startTime: "2026-01-01T10:00:00Z" },
      },
    } as unknown as ApiDataPoint;
    const batch = nutritionLogSpec.parse([point]);
    expect(batch.nutrition.at(0)?.naturalKey).toBe(
      "2026-01-01T10:00:00.000Z|Apple"
    );
  });

  it("naturalKey is stable across two parses", () => {
    const batch1 = nutritionLogSpec.parse(points);
    const batch2 = nutritionLogSpec.parse(points);
    expect(batch1.nutrition.map((n) => n.naturalKey)).toEqual(
      batch2.nutrition.map((n) => n.naturalKey)
    );
  });

  it("newestTimestamp returns the latest interval start in the page", () => {
    expect(nutritionLogSpec.newestTimestamp(points)).not.toBeNull();
    expect(nutritionLogSpec.newestTimestamp([])).toBeNull();
  });
});

describe("hydrationLogSpec", () => {
  const points = loadFixture("hydration-log");

  it("supports date filtering", () => {
    expect(hydrationLogSpec.supportsDateFilter).toBe(true);
    expect(hydrationLogSpec.filterField).toBe(
      "hydrationLog.interval.start_time"
    );
  });

  it("parses an empty page without error", () => {
    expect(hydrationLogSpec.parse([]).hydration).toEqual([]);
  });

  it("does not throw on a malformed point", () => {
    const malformed: ApiDataPoint[] = [
      { hydrationLog: {} } as unknown as ApiDataPoint,
      { hydrationLog: null } as unknown as ApiDataPoint,
      {} as ApiDataPoint,
    ];
    expect(() => hydrationLogSpec.parse(malformed)).not.toThrow();
    expect(hydrationLogSpec.parse(malformed).hydration).toEqual([]);
  });

  it("parses the real fixture into hydration entries with milliliters", () => {
    const batch = hydrationLogSpec.parse(points);
    expect(batch.hydration.length).toBeGreaterThan(0);
    for (const entry of batch.hydration) {
      expect(typeof entry.milliliters).toBe("number");
      expect(entry.milliliters).toBeGreaterThan(0);
    }
  });

  it("naturalKey is the normalized interval start instant", () => {
    const point: ApiDataPoint = {
      hydrationLog: {
        amountConsumed: { milliliters: 250 },
        interval: { startTime: "2026-01-01T10:00:00Z" },
      },
    } as unknown as ApiDataPoint;
    const batch = hydrationLogSpec.parse([point]);
    expect(batch.hydration).toHaveLength(1);
    expect(batch.hydration.at(0)?.naturalKey).toBe("2026-01-01T10:00:00.000Z");
    expect(batch.hydration.at(0)?.milliliters).toBe(250);
  });

  it("naturalKey is stable across two parses", () => {
    const batch1 = hydrationLogSpec.parse(points);
    const batch2 = hydrationLogSpec.parse(points);
    expect(batch1.hydration.map((h) => h.naturalKey)).toEqual(
      batch2.hydration.map((h) => h.naturalKey)
    );
  });

  it("newestTimestamp returns the latest interval start in the page", () => {
    expect(hydrationLogSpec.newestTimestamp(points)).not.toBeNull();
    expect(hydrationLogSpec.newestTimestamp([])).toBeNull();
  });
});
