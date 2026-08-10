import { describe, expect, it } from "vitest";
import { buildCheckin, parseMood } from "../../src/cli/commands/note.js";
import { VitalsError } from "../../src/types.js";

describe("parseMood", () => {
  it("accepts the boundary values 1 and 10", () => {
    expect(parseMood("1")).toBe(1);
    expect(parseMood("10")).toBe(10);
  });

  it("raises VitalsError USAGE for out-of-range integers", () => {
    expect(() => parseMood("0")).toThrow(VitalsError);
    expect(() => parseMood("11")).toThrow(VitalsError);
    try {
      parseMood("11");
      throw new Error("expected parseMood to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(VitalsError);
      expect((err as VitalsError).code).toBe("USAGE");
      expect((err as VitalsError).hint).toBeTruthy();
    }
  });

  it("raises VitalsError USAGE for non-integers and non-numeric input", () => {
    expect(() => parseMood("4.5")).toThrow(VitalsError);
    expect(() => parseMood("wired")).toThrow(VitalsError);
    expect(() => parseMood("")).toThrow(VitalsError);
  });
});

describe("buildCheckin", () => {
  const now = new Date("2026-08-05T12:00:00.000Z");

  it("joins free-text words and keeps tags in order", () => {
    const c = buildCheckin(
      { mood: "4", tag: ["stress"], text: ["wired", "and", "tired"] },
      now
    );
    expect(c.mood).toBe(4);
    expect(c.note).toBe("wired and tired");
    expect(c.tags).toEqual(["stress"]);
    expect(c.date).toBe("2026-08-05");
  });

  it("stores note as null rather than an empty string when no text is given", () => {
    const c = buildCheckin({ mood: "6", tag: [], text: [] }, now);
    expect(c.note).toBeNull();
    expect(c.tags).toEqual([]);
  });

  it("propagates the mood validation error", () => {
    expect(() => buildCheckin({ mood: "99", tag: [], text: [] }, now)).toThrow(
      VitalsError
    );
  });
});
