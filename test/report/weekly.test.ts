import { describe, expect, it } from "vitest";
import {
  arrow,
  bar,
  center,
  fmt,
  REPORT_WIDTH,
  rule,
} from "../../src/report/render.js";
import { weeklyReport } from "../../src/report/weekly.js";
import { openStore } from "../../src/store/sqlite.js";
import type {
  HydrationEntry,
  NutritionEntry,
  Observation,
  ParsedBatch,
  SleepSession,
} from "../../src/types.js";
import { emptyBatch } from "../../src/types.js";

const NO_DATA_RE = /no data/i;
const HEART_RE = /HEART/;
const TODAY_RHR_RE = /TODAY: RHR=74bpm/;
const RHR_TODAY_RE = /RHR 74bpm today/;
const ALCOHOL_LOG_RE = /Alcohol logged on 2026-06-05/;
const ZERO_MS_RE = /0ms/;
const BAR_RE = /█/;
const TWENTY_MS_RE = /20ms/;
const RHR_NO_DATA_RE = /RHR:\s+no data for this period/;
const HRV_NO_DATA_RE = /HRV:\s+no data for this period/;

// ---------------------------------------------------------------------------
// render.ts primitives
// ---------------------------------------------------------------------------

describe("render primitives", () => {
  it("rule repeats the character to the exact width", () => {
    expect(rule(10)).toBe("──────────");
    expect(rule(5, "=")).toBe("=====");
    expect(rule(0)).toBe("");
  });

  it("center pads both sides and totals the requested width", () => {
    const out = center("HI", 6);
    expect(out).toHaveLength(6);
    expect(out.trim()).toBe("HI");
  });

  it("center returns text unchanged when it is already at or past width", () => {
    expect(center("too long already", 5)).toBe("too long already");
  });

  it("bar scales proportionally and clamps to width", () => {
    expect(bar(15, 30, 20)).toBe("█".repeat(10));
    expect(bar(60, 30, 20)).toBe("█".repeat(20)); // clamped at max
    expect(bar(0.001, 30, 20)).toBe("█"); // any positive value shows at least one block
  });

  it("bar renders nothing for non-positive or non-finite input", () => {
    expect(bar(0, 30, 20)).toBe("");
    expect(bar(-5, 30, 20)).toBe("");
    expect(bar(Number.NaN, 30, 20)).toBe("");
  });

  it("arrow maps trend directions to glyphs and null to empty", () => {
    expect(arrow("rising")).toBe("↑");
    expect(arrow("falling")).toBe("↓");
    expect(arrow("flat")).toBe("→");
    expect(arrow(null)).toBe("");
  });

  it("fmt formats fixed-point and maps null/NaN to empty string", () => {
    expect(fmt(3.456, 1)).toBe("3.5");
    expect(fmt(70, 0)).toBe("70");
    expect(fmt(null)).toBe("");
    expect(fmt(Number.NaN)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// weeklyReport
// ---------------------------------------------------------------------------

function obs(
  overrides: Partial<Observation> &
    Pick<Observation, "metric" | "date" | "value" | "unit">
): Observation {
  return {
    naturalKey: `${overrides.metric}-${overrides.date}`,
    platform: "fitbit",
    recordingMethod: "automatic",
    ts: `${overrides.date}T08:00:00.000Z`,
    ...overrides,
  };
}

function sleep(
  overrides: Partial<SleepSession> & Pick<SleepSession, "date">
): SleepSession {
  return {
    asleepMinutes: 450,
    awakeMinutes: 30,
    deepMinutes: 90,
    efficiency: 450 / 480,
    endTs: `${overrides.date}T13:00:00.000Z`,
    lightMinutes: 260,
    naturalKey: `sleep-${overrides.date}`,
    platform: "fitbit",
    remMinutes: 100,
    stages: [],
    startTs: `${overrides.date}T05:00:00.000Z`,
    totalMinutes: 480,
    type: "stages",
    ...overrides,
  };
}

function nutrition(
  overrides: Partial<NutritionEntry> & Pick<NutritionEntry, "date" | "ts">
): NutritionEntry {
  return {
    carbsG: 10,
    energyKcal: 300,
    fatG: 5,
    foodDisplayName: "Salad",
    mealType: "LUNCH",
    naturalKey: `nutr-${overrides.date}-${overrides.ts}`,
    proteinG: 20,
    ...overrides,
  };
}

function hydration(
  overrides: Partial<HydrationEntry> &
    Pick<HydrationEntry, "date" | "ts" | "milliliters">
): HydrationEntry {
  return {
    naturalKey: `hydr-${overrides.date}-${overrides.ts}`,
    ...overrides,
  };
}

function knownBatch(): ParsedBatch {
  const batch = emptyBatch();

  // RHR: every day but 06-06 (gap), 06-10 (asOf) is elevated.
  batch.observations.push(
    obs({ date: "2026-06-04", metric: "rhr", unit: "bpm", value: 65 }),
    obs({ date: "2026-06-05", metric: "rhr", unit: "bpm", value: 66 }),
    // 2026-06-06 intentionally absent.
    obs({ date: "2026-06-07", metric: "rhr", unit: "bpm", value: 68 }),
    obs({ date: "2026-06-08", metric: "rhr", unit: "bpm", value: 67 }),
    obs({ date: "2026-06-09", metric: "rhr", unit: "bpm", value: 70 }),
    obs({ date: "2026-06-10", metric: "rhr", unit: "bpm", value: 74 })
  );

  // HRV: every day but 06-05 (gap).
  batch.observations.push(
    obs({ date: "2026-06-04", metric: "hrv_daily_avg", unit: "ms", value: 20 }),
    // 2026-06-05 intentionally absent.
    obs({ date: "2026-06-06", metric: "hrv_daily_avg", unit: "ms", value: 18 }),
    obs({ date: "2026-06-07", metric: "hrv_daily_avg", unit: "ms", value: 22 }),
    obs({ date: "2026-06-08", metric: "hrv_daily_avg", unit: "ms", value: 19 }),
    obs({ date: "2026-06-09", metric: "hrv_daily_avg", unit: "ms", value: 21 }),
    obs({ date: "2026-06-10", metric: "hrv_daily_avg", unit: "ms", value: 15 })
  );

  // Skin temperature, for the TEMPERATURE section.
  batch.observations.push(
    obs({
      date: "2026-06-09",
      metric: "skin_temp_baseline",
      unit: "C",
      value: 32,
    }),
    obs({
      date: "2026-06-09",
      metric: "skin_temp_nightly",
      unit: "C",
      value: 31.5,
    })
  );

  // Activity.
  batch.observations.push(
    obs({ date: "2026-06-08", metric: "steps", unit: "count", value: 4000 }),
    obs({ date: "2026-06-09", metric: "steps", unit: "count", value: 6000 }),
    obs({ date: "2026-06-08", metric: "azm", unit: "min", value: 20 }),
    obs({ date: "2026-06-09", metric: "azm", unit: "min", value: 15 })
  );

  batch.heartRateHourly.push(
    {
      avgBpm: 75,
      date: "2026-06-08",
      hourTs: "2026-06-08T08:00:00.000Z",
      maxBpm: 90,
      minBpm: 60,
      naturalKey: "hr-2026-06-08T08",
      sampleCount: 100,
    },
    {
      avgBpm: 95,
      date: "2026-06-09",
      hourTs: "2026-06-09T08:00:00.000Z",
      maxBpm: 110,
      minBpm: 70,
      naturalKey: "hr-2026-06-09T08",
      sampleCount: 50,
    }
  );

  batch.sleepSessions.push(
    sleep({
      asleepMinutes: 470,
      date: "2026-06-08",
      deepMinutes: 90,
      efficiency: 0.98,
      remMinutes: 110,
    }),
    sleep({
      asleepMinutes: 400,
      date: "2026-06-09",
      deepMinutes: 60,
      efficiency: 0.8,
      remMinutes: 60,
    })
  );

  batch.nutrition.push(
    nutrition({
      date: "2026-06-05",
      energyKcal: null,
      foodDisplayName: "Old Fashioned",
      proteinG: null,
      ts: "2026-06-05T23:00:00.000Z",
    }),
    nutrition({
      date: "2026-06-05",
      energyKcal: 600,
      foodDisplayName: "Steak Frites",
      proteinG: 40,
      ts: "2026-06-05T22:00:00.000Z",
    }),
    nutrition({
      date: "2026-06-08",
      energyKcal: 350,
      foodDisplayName: "Chicken Salad",
      proteinG: 30,
      ts: "2026-06-08T18:00:00.000Z",
    })
  );

  batch.hydration.push(
    hydration({
      date: "2026-06-05",
      milliliters: 500,
      ts: "2026-06-05T12:00:00.000Z",
    }), // low
    hydration({
      date: "2026-06-08",
      milliliters: 2000,
      ts: "2026-06-08T12:00:00.000Z",
    })
  );

  return batch;
}

const ASOF = "2026-06-10";

describe("weeklyReport", () => {
  it("returns a clear no-data message for a completely empty store", () => {
    const store = openStore(":memory:");
    const report = weeklyReport(store, { asOf: ASOF });
    store.close();

    expect(report).toMatch(NO_DATA_RE);
    expect(report).not.toMatch(HEART_RE);
    for (const line of report.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(REPORT_WIDTH);
    }
  });

  it("renders section headers and known values from a populated store", () => {
    const store = openStore(":memory:");
    store.writeBatch(knownBatch());
    const report = weeklyReport(store, { asOf: ASOF, days: 7 });
    store.close();

    // Section headers, in order.
    const headerOrder = [
      "HEART",
      "RECOVERY",
      "ACTIVITY",
      "FOOD & DRINK",
      "SLEEP TEMPERATURE",
      "FLAGS & TRENDS",
      "THIS WEEK'S 3 ACTIONS",
    ];
    let cursor = -1;
    for (const h of headerOrder) {
      const idx = report.indexOf(h);
      expect(idx, `expected to find section "${h}"`).toBeGreaterThan(cursor);
      cursor = idx;
    }

    // Known aggregate values.
    expect(report).toContain("bpm avg"); // RHR summary line present
    expect(report).toContain("74"); // today's elevated RHR appears somewhere
    expect(report).toContain("ms avg RMSSD"); // HRV summary line present

    // Today's RHR (74) is 3+ bpm above the period baseline -> elevated flag + TODAY alert.
    expect(report).toMatch(TODAY_RHR_RE);
    expect(report).toMatch(RHR_TODAY_RE);

    // Alcohol detection from nutrition log.
    expect(report).toMatch(ALCOHOL_LOG_RE);
    expect(report).toContain("Old Fashioned");

    // Sleep best/worst.
    expect(report).toContain("2026-06-08");
    expect(report).toContain("2026-06-09");
  });

  it("renders a day with no HRV reading as blank, never as a 0ms bar", () => {
    const store = openStore(":memory:");
    store.writeBatch(knownBatch());
    const report = weeklyReport(store, { asOf: ASOF, days: 7 });
    store.close();

    const lines = report.split("\n");
    const gapLine = lines.find((l) => l.trimStart().startsWith("06-05:"));
    expect(gapLine).toBeDefined();
    // The gap day must not render a value or a bar — just the date label.
    expect(gapLine).toBe("  06-05:");
    expect(gapLine).not.toMatch(ZERO_MS_RE);
    expect(gapLine).not.toMatch(BAR_RE);

    // A day that does have HRV data renders a bar and a value.
    const dataLine = lines.find((l) => l.trimStart().startsWith("06-04:"));
    expect(dataLine).toBeDefined();
    expect(dataLine).toMatch(BAR_RE);
    expect(dataLine).toMatch(TWENTY_MS_RE);
  });

  it("never emits a line longer than the 72-column report width", () => {
    const store = openStore(":memory:");
    store.writeBatch(knownBatch());
    const report = weeklyReport(store, { asOf: ASOF, days: 7 });
    store.close();

    for (const line of report.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(REPORT_WIDTH);
    }
  });

  it("handles a store with data outside the requested window as if it were empty for that window", () => {
    const store = openStore(":memory:");
    store.writeBatch(knownBatch());
    // Ask for a report far in the future, past all recorded data.
    const report = weeklyReport(store, { asOf: "2030-01-01", days: 7 });
    store.close();

    expect(report).toContain("HEART");
    expect(report).toMatch(RHR_NO_DATA_RE);
    expect(report).toMatch(HRV_NO_DATA_RE);
    for (const line of report.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(REPORT_WIDTH);
    }
  });
});
