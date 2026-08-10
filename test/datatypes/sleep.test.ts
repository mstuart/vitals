import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { exerciseSpec, sleepSpec } from "../../src/datatypes/sleep.js";
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

describe("sleepSpec", () => {
  const points = loadFixture("sleep");

  it("parses an empty page without error", () => {
    const batch = sleepSpec.parse([]);
    expect(batch.sleepSessions).toEqual([]);
  });

  it("does not throw on a malformed point", () => {
    const malformed: ApiDataPoint[] = [
      { sleep: { interval: {} } } as unknown as ApiDataPoint,
      { sleep: null } as unknown as ApiDataPoint,
      {} as ApiDataPoint,
    ];
    expect(() => sleepSpec.parse(malformed)).not.toThrow();
    const batch = sleepSpec.parse(malformed);
    expect(batch.sleepSessions).toEqual([]);
  });

  it("parses the real fixture into sensible sessions", () => {
    const batch = sleepSpec.parse(points);
    expect(batch.sleepSessions.length).toBeGreaterThan(0);

    const plausible = batch.sleepSessions.some(
      (s) => s.totalMinutes >= 60 && s.totalMinutes <= 900
    );
    expect(plausible).toBe(true);
  });

  it("stage minutes sum to <= totalMinutes for every session", () => {
    const batch = sleepSpec.parse(points);
    for (const session of batch.sleepSessions) {
      const stageSum = session.stages.reduce((acc, s) => acc + s.minutes, 0);
      expect(stageSum).toBeLessThanOrEqual(session.totalMinutes + 0.001);
    }
  });

  it("efficiency is between 0 and 1, or null", () => {
    const batch = sleepSpec.parse(points);
    for (const session of batch.sleepSessions) {
      if (session.efficiency === null) {
        continue;
      }
      expect(session.efficiency).toBeGreaterThanOrEqual(0);
      expect(session.efficiency).toBeLessThanOrEqual(1);
    }
  });

  it("a STAGES session with stages yields non-zero deep/rem/light", () => {
    const batch = sleepSpec.parse(points);
    const withStages = batch.sleepSessions.find((s) => s.stages.length > 0);
    expect(withStages).toBeDefined();
    expect(withStages?.deepMinutes).toBeGreaterThan(0);
    expect(withStages?.remMinutes).toBeGreaterThan(0);
    expect(withStages?.lightMinutes).toBeGreaterThan(0);
  });

  it("a CLASSIC session with no stages is emitted with zeroed stage minutes and null efficiency", () => {
    const classicPoint: ApiDataPoint = {
      sleep: {
        interval: {
          endTime: "2026-01-01T12:00:00Z",
          startTime: "2026-01-01T05:00:00Z",
        },
        type: "CLASSIC",
      },
    } as unknown as ApiDataPoint;

    const batch = sleepSpec.parse([classicPoint]);
    expect(batch.sleepSessions).toHaveLength(1);
    const [session] = batch.sleepSessions;
    expect(session?.type).toBe("CLASSIC");
    expect(session?.deepMinutes).toBe(0);
    expect(session?.remMinutes).toBe(0);
    expect(session?.lightMinutes).toBe(0);
    expect(session?.awakeMinutes).toBe(0);
    expect(session.asleepMinutes).toBe(0);
    expect(session.efficiency).toBeNull();
    expect(session.totalMinutes).toBe(420);
  });

  it("naturalKey is stable across two parses", () => {
    const batch1 = sleepSpec.parse(points);
    const batch2 = sleepSpec.parse(points);
    expect(batch1.sleepSessions.map((s) => s.naturalKey)).toEqual(
      batch2.sleepSessions.map((s) => s.naturalKey)
    );
  });

  it("date is the local day the session ends (wake day)", () => {
    const point: ApiDataPoint = {
      sleep: {
        interval: {
          endTime: "2026-01-02T07:10:00Z",
          endUtcOffset: "-25200s",
          startTime: "2026-01-01T23:40:00Z",
          startUtcOffset: "-25200s",
        },
        type: "CLASSIC",
      },
    } as unknown as ApiDataPoint;

    const batch = sleepSpec.parse([point]);
    expect(batch.sleepSessions).toHaveLength(1);
    // endTime 2026-01-02T07:10:00Z with -25200s (-7h) offset -> local day 2026-01-02
    expect(batch.sleepSessions.at(0)?.date).toBe("2026-01-02");
  });

  it("newestTimestamp returns the latest interval end in the page", () => {
    const newest = sleepSpec.newestTimestamp(points);
    expect(newest).not.toBeNull();
  });
});

describe("exerciseSpec", () => {
  const points = loadFixture("exercise");

  it("parses an empty page without error", () => {
    const batch = exerciseSpec.parse([]);
    expect(batch.exercises).toEqual([]);
  });

  it("does not throw on a malformed point", () => {
    const malformed: ApiDataPoint[] = [
      { exercise: {} } as unknown as ApiDataPoint,
      { exercise: null } as unknown as ApiDataPoint,
      {} as ApiDataPoint,
    ];
    expect(() => exerciseSpec.parse(malformed)).not.toThrow();
    const batch = exerciseSpec.parse(malformed);
    expect(batch.exercises).toEqual([]);
  });

  it("parses the real fixture into sensible exercise sessions", () => {
    const batch = exerciseSpec.parse(points);
    expect(batch.exercises.length).toBeGreaterThan(0);
  });

  it("resolves caloriesBurned defensively (caloriesKcal fallback)", () => {
    const batch = exerciseSpec.parse(points);
    const withCalories = batch.exercises.filter(
      (e) => e.caloriesBurned !== null
    );
    expect(withCalories.length).toBeGreaterThan(0);
    for (const e of withCalories) {
      expect(e.caloriesBurned).toBeGreaterThan(0);
    }
  });

  it("normalizes empty-string displayName/exerciseType/intensity to null", () => {
    const point: ApiDataPoint = {
      exercise: {
        displayName: "",
        exerciseType: "",
        intensity: "",
        interval: {
          endTime: "2026-01-01T10:30:00Z",
          startTime: "2026-01-01T10:00:00Z",
        },
        metricsSummary: {},
      },
    } as unknown as ApiDataPoint;

    const batch = exerciseSpec.parse([point]);
    expect(batch.exercises).toHaveLength(1);
    const [session] = batch.exercises;
    expect(session?.displayName).toBeNull();
    expect(session?.exerciseType).toBeNull();
    expect(session?.intensity).toBeNull();
  });

  it("allows a missing endTime (endTs null)", () => {
    const point: ApiDataPoint = {
      exercise: {
        displayName: "Run",
        interval: { startTime: "2026-01-01T10:00:00Z" },
        metricsSummary: {},
      },
    } as unknown as ApiDataPoint;

    const batch = exerciseSpec.parse([point]);
    expect(batch.exercises).toHaveLength(1);
    expect(batch.exercises.at(0)?.endTs).toBeNull();
  });

  it("naturalKey is stable across two parses", () => {
    const batch1 = exerciseSpec.parse(points);
    const batch2 = exerciseSpec.parse(points);
    expect(batch1.exercises.map((e) => e.naturalKey)).toEqual(
      batch2.exercises.map((e) => e.naturalKey)
    );
  });
});
