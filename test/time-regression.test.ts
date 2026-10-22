import { expect, it } from "vitest";
import { apiDateToIso, parseSince, toNumber } from "../src/util/time.js";

it("does not turn whitespace-only API measurements into zero", () => {
  expect(toNumber(" \t\n")).toBeNull();
  expect(toNumber(" 0 ")).toBe(0);
  expect(toNumber(" 71.5 ")).toBe(71.5);
});

it("rejects invalid calendar dates instead of archiving or normalizing them", () => {
  for (const date of [
    { day: 30, month: 2, year: 2026 },
    { day: 1, month: 13, year: 2026 },
    { day: 0, month: 1, year: 2026 },
    { day: 1, month: 1.5, year: 2026 },
  ]) {
    expect(apiDateToIso(date)).toBeNull();
  }
  expect(() => parseSince("2026-02-30")).toThrow();
  expect(apiDateToIso({ day: 29, month: 2, year: 2024 })).toBe("2024-02-29");
  expect(apiDateToIso({ day: 1, month: 1, year: 99 })).toBe("0099-01-01");
});

it("rejects relative durations outside the representable date range", () => {
  expect(() => parseSince("999999999999999999999999999999d")).toThrow();
  expect(parseSince("1d", new Date("2026-10-22T00:00:00Z")).toISOString()).toBe(
    "2026-10-21T00:00:00.000Z"
  );
});
