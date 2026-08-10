import { describe, expect, it } from "vitest";
import {
  formatBareSummary,
  formatCheckinConfirmation,
  formatHeartTable,
  formatJson,
  formatNumber,
  formatPercent,
  formatQuiet,
  mergeDailySeries,
  renderToday,
} from "../../src/cli/format.js";
import type {
  DailySummary,
  Flag,
  MetricSnapshot,
  SleepSession,
} from "../../src/types.js";

function snap(overrides: Partial<MetricSnapshot> = {}): MetricSnapshot {
  return {
    baseline: { mean: 60, metric: "rhr", n: 30, stddev: 2, windowDays: 30 },
    date: "2026-08-05",
    delta: 7,
    deltaPct: 0.1,
    metric: "rhr",
    trend: "falling",
    value: 67,
    ...overrides,
  };
}

function emptySnap(metric: MetricSnapshot["metric"]): MetricSnapshot {
  return {
    baseline: null,
    date: "2026-08-05",
    delta: null,
    deltaPct: null,
    metric,
    trend: null,
    value: null,
  };
}

const sleepSession: SleepSession = {
  asleepMinutes: 432,
  awakeMinutes: 0,
  date: "2026-08-05",
  deepMinutes: 66,
  efficiency: 0.93,
  endTs: "2026-08-05T06:12:00.000Z",
  lightMinutes: 270,
  naturalKey: "sleep-1",
  platform: "fitbit",
  remMinutes: 96,
  stages: [],
  startTs: "2026-08-04T23:00:00.000Z",
  totalMinutes: 432,
  type: "stages",
};

const flag: Flag = {
  baselineMean: 37.0,
  basis: "Oura illness prediction",
  level: "red",
  message: "temp +1.1C vs baseline (2 nights)",
  metric: "skin_temp_nightly",
  value: 38.1,
};

function summary(overrides: Partial<DailySummary> = {}): DailySummary {
  return {
    checkin: null,
    date: "2026-08-05",
    flags: [],
    hrv: snap({ metric: "hrv_daily_avg", trend: "flat", value: 21 }),
    multiMarker: false,
    respRate: emptySnap("resp_rate"),
    rhr: snap({ metric: "rhr", value: 67 }),
    skinTemp: emptySnap("skin_temp_nightly"),
    sleep: sleepSession,
    spo2: snap({ metric: "spo2_avg", trend: "flat", value: 96.9 }),
    ...overrides,
  };
}

describe("formatNumber", () => {
  it("renders a missing value as an em dash, never 0 or NaN", () => {
    expect(formatNumber(null)).toBe("—");
    expect(formatNumber(Number.NaN)).toBe("—");
  });

  it("formats a real value to the requested precision", () => {
    expect(formatNumber(67.4, 0)).toBe("67");
    expect(formatNumber(7.2345, 1)).toBe("7.2");
  });
});

describe("formatPercent", () => {
  it("renders a missing value as an em dash", () => {
    expect(formatPercent(null)).toBe("—");
  });

  it("renders a 0..1 fraction as a whole-number percent, not a fraction-as-percent", () => {
    expect(formatPercent(0.93)).toBe("93%");
    expect(formatPercent(1)).toBe("100%");
  });
});

describe("formatBareSummary", () => {
  it("renders a missing metric as an em dash, not 0 or NaN", () => {
    const s = summary({ rhr: emptySnap("rhr") });
    const [line] = formatBareSummary(s).split("\n");
    expect(line).toContain("RHR —");
    expect(line).not.toContain("RHR 0");
    expect(line).not.toContain("NaN");
  });

  it("renders sleep efficiency as a percent, not a raw fraction", () => {
    const [line] = formatBareSummary(summary()).split("\n");
    expect(line).toContain("93%eff");
    expect(line).not.toContain("0.93%");
  });

  it("appends one line per active flag", () => {
    const out = formatBareSummary(summary({ flags: [flag] }));
    const lines = out.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("⚠");
    expect(lines[1]).toContain(flag.message);
  });
});

describe("formatQuiet", () => {
  it("emits an empty string when there are no flags — silence means healthy", () => {
    expect(formatQuiet(summary({ flags: [] }))).toBe("");
  });

  it("emits one line per flag when flags are present", () => {
    const out = formatQuiet(summary({ flags: [flag] }));
    expect(out).toBe(`⚠ ${flag.message}`);
  });
});

describe("renderToday", () => {
  it("quiet + no flags: empty output, exit 0", () => {
    const r = renderToday(summary({ flags: [] }), { quiet: true });
    expect(r).toEqual({ exitCode: 0, output: "" });
  });

  it("quiet + flags: non-empty output, exit 1", () => {
    const r = renderToday(summary({ flags: [flag] }), { quiet: true });
    expect(r.output.length).toBeGreaterThan(0);
    expect(r.exitCode).toBe(1);
  });

  it("json output parses as JSON and exits 0", () => {
    const r = renderToday(summary(), { json: true });
    expect(r.exitCode).toBe(0);
    expect(() => JSON.parse(r.output)).not.toThrow();
    const parsed = JSON.parse(r.output) as { date: string };
    expect(parsed.date).toBe("2026-08-05");
  });

  it("quiet takes priority over json", () => {
    const r = renderToday(summary({ flags: [] }), { json: true, quiet: true });
    expect(r).toEqual({ exitCode: 0, output: "" });
  });
});

describe("formatJson", () => {
  it("round-trips through JSON.parse", () => {
    const data = { a: 1, b: [1, 2, 3], c: null };
    expect(JSON.parse(formatJson(data))).toEqual(data);
  });
});

describe("mergeDailySeries / formatHeartTable", () => {
  it("leaves a day with no HRV value as an em dash, not 0", () => {
    const rows = mergeDailySeries([{ date: "2026-08-05", value: 67 }], []);
    expect(rows).toEqual([{ date: "2026-08-05", hrv: null, rhr: 67 }]);
    const table = formatHeartTable(rows);
    expect(table).toContain("HRV —");
    expect(table).not.toContain("HRV 0");
  });
});

describe("formatCheckinConfirmation", () => {
  it("includes mood, date, and tags when present", () => {
    const out = formatCheckinConfirmation({
      date: "2026-08-05",
      mood: 4,
      note: "wired and tired",
      tags: ["stress"],
      ts: "2026-08-05T12:00:00.000Z",
    });
    expect(out).toBe("Logged mood 4/10 for 2026-08-05 [stress].");
  });

  it("omits the bracket when there are no tags", () => {
    const out = formatCheckinConfirmation({
      date: "2026-08-05",
      mood: 7,
      note: null,
      tags: [],
      ts: "2026-08-05T12:00:00.000Z",
    });
    expect(out).toBe("Logged mood 7/10 for 2026-08-05.");
  });
});
