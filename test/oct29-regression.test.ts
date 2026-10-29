import { expect, it, vi } from "vitest";
import { createClient } from "../src/api/client.js";
import { nutritionLogSpec } from "../src/datatypes/logs.js";
import { vitalsLogCheckin, vitalsSleep } from "../src/mcp/tools.js";
import { openStore } from "../src/store/sqlite.js";
import { syncAll } from "../src/sync/index.js";

it("reports truncated pagination instead of marking an incomplete sync successful", async () => {
  let count = 0;
  const client = createClient({
    fetchImpl: vi.fn(() => {
      count += 1;
      return Promise.resolve(
        Response.json({ dataPoints: [], nextPageToken: String(count) })
      );
    }),
    getToken: async () => "test-token",
  });
  const store = openStore(":memory:");
  try {
    const [result] = await syncAll(store, client, { dataTypes: ["steps"] });
    expect(result?.error).toContain("pagination limit");
    expect(count).toBe(500);
    expect(store.getWatermark("steps")).toBeNull();
  } finally {
    store.close();
  }
});

it("ignores unknown prototype-named nutrients without overwriting fat", () => {
  const batch = nutritionLogSpec.parse([
    {
      nutritionLog: {
        interval: { startTime: "2026-10-01T12:00:00Z" },
        nutrients: [
          { nutrient: "FAT", quantity: { grams: "5" } },
          { nutrient: "constructor", quantity: { grams: "999" } },
        ],
      },
    },
  ]);
  expect(batch.nutrition[0]?.fatG).toBe(5);
});

it("rejects impossible MCP calendar dates before persisting check-ins", async () => {
  const store = openStore(":memory:");
  try {
    const result = await vitalsLogCheckin(store, {
      date: "2026-02-30",
      mood: 5,
    });
    expect(result.isError).toBe(true);
    expect(store.checkin("2026-02-30")).toBeNull();
  } finally {
    store.close();
  }
});

it("rejects inverted MCP date ranges", async () => {
  const store = openStore(":memory:");
  try {
    const result = await vitalsSleep(store, {
      from: "2026-10-10",
      to: "2026-10-01",
    });
    expect(result.isError).toBe(true);
  } finally {
    store.close();
  }
});

it("retains a newer existing watermark when backfilling older observations", async () => {
  const store = openStore(":memory:");
  const newestTs = "2026-10-10T12:00:00.000Z";
  store.setWatermark({ dataType: "steps", lastSyncedAt: newestTs, newestTs });
  const client = createClient({
    fetchImpl: vi.fn(() =>
      Promise.resolve(
        Response.json({
          dataPoints: [
            {
              steps: {
                count: "10",
                interval: { startTime: "2026-10-01T12:00:00Z" },
              },
            },
          ],
        })
      )
    ),
    getToken: async () => "test-token",
  });
  try {
    const [result] = await syncAll(store, client, {
      dataTypes: ["steps"],
      since: new Date("2026-10-01T00:00:00Z"),
    });
    expect(result?.error).toBeUndefined();
    expect(result?.rowsWritten).toBe(1);
    expect(store.getWatermark("steps")?.newestTs).toBe(newestTs);
  } finally {
    store.close();
  }
});

it("accepts a valid leap day and an inclusive single-day range", async () => {
  const store = openStore(":memory:");
  try {
    const checkin = await vitalsLogCheckin(store, {
      date: "2028-02-29",
      mood: 5,
    });
    expect(checkin.isError).toBeUndefined();
    const range = await vitalsSleep(store, {
      from: "2028-02-29",
      to: "2028-02-29",
    });
    expect(range.isError).toBeUndefined();
  } finally {
    store.close();
  }
});

it("completes normally when page 500 is the terminal page", async () => {
  let count = 0;
  const client = createClient({
    fetchImpl: vi.fn(() => {
      count += 1;
      return Promise.resolve(
        Response.json({
          dataPoints: [],
          nextPageToken: count < 500 ? String(count) : undefined,
        })
      );
    }),
    getToken: async () => "test-token",
  });
  for await (const page of client.pages("steps")) {
    expect(page.dataPoints).toEqual([]);
  }
  expect(count).toBe(500);
});
