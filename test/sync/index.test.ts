import { describe, expect, it } from "vitest";
import type {
  ListDataPointsOptions,
  VitalsApiClient,
} from "../../src/api/client.js";
import type { Store } from "../../src/store/api.js";
import { openStore } from "../../src/store/sqlite.js";
import { syncAll } from "../../src/sync/index.js";
import type {
  ApiDataPoint,
  ApiDataPointsResponse,
  DataTypeId,
} from "../../src/types.js";
import { METRICS, VitalsError } from "../../src/types.js";

// ---------------------------------------------------------------------------
// Fixture builders — real payload shapes for the specs under test.
// ---------------------------------------------------------------------------

function hrPoint(iso: string, bpm: number): ApiDataPoint {
  return {
    dataSource: { platform: "FITBIT", recordingMethod: "PASSIVELY_MEASURED" },
    heartRate: {
      beatsPerMinute: String(bpm),
      sampleTime: { physicalTime: iso, utcOffset: "0s" },
    },
  };
}

function weightPoint(iso: string, grams: number): ApiDataPoint {
  return {
    dataSource: { platform: "FITBIT", recordingMethod: "MANUAL_ENTRY" },
    weight: {
      sampleTime: { physicalTime: iso, utcOffset: "0s" },
      weightGrams: String(grams),
    },
  };
}

function bodyFatPoint(iso: string, pct: number): ApiDataPoint {
  return {
    bodyFat: {
      percentage: String(pct),
      sampleTime: { physicalTime: iso, utcOffset: "0s" },
    },
    dataSource: { platform: "FITBIT", recordingMethod: "MANUAL_ENTRY" },
  };
}

function page(points: ApiDataPoint[]): ApiDataPointsResponse {
  return { dataPoints: points };
}

// ---------------------------------------------------------------------------
// Fake client
// ---------------------------------------------------------------------------

interface FakeClientConfig {
  /** Records every `pages()` call, including how many pages were yielded. */
  callLog?: { dataType: DataTypeId; filter: string | undefined }[];
  /** Canned pages per data type, returned in order regardless of pageToken. */
  pagesByType?: Partial<Record<DataTypeId, ApiDataPointsResponse[]>>;
  /** Data types that always throw the given error, regardless of filter. */
  throwAlways?: Partial<Record<DataTypeId, Error>>;
  /** Data types that throw API_FILTER_UNSUPPORTED when called with a filter. */
  throwOnFilter?: Set<DataTypeId>;
  /** Counts how many pages were actually yielded (not just written) per type. */
  yieldedCounts?: Partial<Record<DataTypeId, number>>;
}

function makeFakeClient(config: FakeClientConfig): VitalsApiClient {
  function listDataPoints(
    _id: DataTypeId,
    _o?: ListDataPointsOptions
  ): Promise<ApiDataPointsResponse> {
    return Promise.resolve({ dataPoints: [] });
  }

  // biome-ignore lint/suspicious/useAwait: The fake must implement the client's async-generator contract even though canned pages need no awaits.
  async function* pages(
    id: DataTypeId,
    o: ListDataPointsOptions = {}
  ): AsyncGenerator<ApiDataPointsResponse> {
    config.callLog?.push({ dataType: id, filter: o.filter });

    const alwaysErr = config.throwAlways?.[id];
    if (alwaysErr) {
      throw alwaysErr;
    }

    if (o.filter !== undefined && config.throwOnFilter?.has(id)) {
      throw new VitalsError(
        "API_FILTER_UNSUPPORTED",
        `Data type "${id}" rejects filters.`
      );
    }

    const pagesForType = config.pagesByType?.[id] ?? [];
    for (const p of pagesForType) {
      config.yieldedCounts ??= {};
      config.yieldedCounts[id] = (config.yieldedCounts[id] ?? 0) + 1;
      yield p;
    }
  }

  return { listDataPoints, pages };
}

function freshStore(): Store {
  return openStore(":memory:");
}

describe("syncAll", () => {
  it("stops paging early once a page predates the window by more than 2 hours", async () => {
    const since = new Date("2026-08-01T00:00:00Z");
    // Pages arrive newest-first, as the real API does.
    const p1 = page([hrPoint("2026-08-02T10:00:00Z", 60)]); // within window
    const p2 = page([hrPoint("2026-08-01T05:00:00Z", 61)]); // within window
    const p3 = page([hrPoint("2026-07-31T20:00:00Z", 62)]); // since - 4h: past the 2h grace, stop here
    const p4 = page([hrPoint("2026-07-30T20:00:00Z", 63)]); // must never be fetched

    const yieldedCounts: Partial<Record<DataTypeId, number>> = {};
    const client = makeFakeClient({
      pagesByType: { "heart-rate": [p1, p2, p3, p4] },
      yieldedCounts,
    });
    const store = freshStore();

    const [result] = await syncAll(store, client, {
      dataTypes: ["heart-rate"],
      since,
    });

    expect(result?.error).toBeUndefined();
    // Only p1 and p2 were consumed (written); p3's presence stopped paging
    // before a 4th page could ever be requested.
    expect(result?.pagesFetched).toBe(2);
    expect(yieldedCounts["heart-rate"]).toBe(3);

    store.close();
  });

  it("falls back to unfiltered paging when the API rejects the date filter", async () => {
    const since = new Date("2026-08-01T00:00:00Z");
    const unfilteredPage = page([weightPoint("2026-08-03T08:00:00Z", 70_000)]);

    const callLog: { dataType: DataTypeId; filter: string | undefined }[] = [];
    const client = makeFakeClient({
      callLog,
      pagesByType: { weight: [unfilteredPage] },
      throwOnFilter: new Set(["weight"]),
    });
    const store = freshStore();

    const [result] = await syncAll(store, client, {
      dataTypes: ["weight"],
      since,
    });

    expect(result?.error).toBeUndefined();
    expect(result?.rowsWritten).toBe(1);
    // First call carried a filter and failed; second call (fallback) had none.
    expect(callLog).toHaveLength(2);
    expect(callLog[0]?.filter).toBeDefined();
    expect(callLog[1]?.filter).toBeUndefined();

    const wm = store.getWatermark("weight");
    expect(wm?.newestTs).toBe("2026-08-03T08:00:00.000Z");

    store.close();
  });

  it("does not let one failing data type prevent others from syncing", async () => {
    const since = new Date("2026-08-01T00:00:00Z");
    const okPage = page([bodyFatPoint("2026-08-03T08:00:00Z", 18.5)]);

    const client = makeFakeClient({
      pagesByType: { "body-fat": [okPage] },
      throwAlways: { weight: new Error("boom") },
    });
    const store = freshStore();

    const results = await syncAll(store, client, {
      dataTypes: ["weight", "body-fat"],
      since,
    });

    const weightResult = results.find((r) => r.dataType === "weight");
    const bodyFatResult = results.find((r) => r.dataType === "body-fat");

    expect(weightResult?.error).toBe("boom");
    expect(bodyFatResult?.error).toBeUndefined();
    expect(bodyFatResult?.rowsWritten).toBe(1);

    store.close();
  });

  it("does not advance the watermark for a failed data type", async () => {
    const since = new Date("2026-08-01T00:00:00Z");
    const client = makeFakeClient({
      throwAlways: { weight: new Error("boom") },
    });
    const store = freshStore();

    await syncAll(store, client, { dataTypes: ["weight"], since });

    expect(store.getWatermark("weight")).toBeNull();

    store.close();
  });

  it("advances the watermark to the newest timestamp actually persisted", async () => {
    const since = new Date("2026-08-01T00:00:00Z");
    const p1 = page([weightPoint("2026-08-02T09:00:00Z", 70_100)]);
    const p2 = page([weightPoint("2026-08-04T09:00:00Z", 70_200)]); // newest
    const client = makeFakeClient({ pagesByType: { weight: [p1, p2] } });
    const store = freshStore();

    const [result] = await syncAll(store, client, {
      dataTypes: ["weight"],
      since,
    });

    expect(result?.error).toBeUndefined();
    const wm = store.getWatermark("weight");
    expect(wm?.newestTs).toBe("2026-08-04T09:00:00.000Z");

    store.close();
  });

  it("is idempotent across two runs over the same canned pages", async () => {
    const since = new Date("2026-08-01T00:00:00Z");
    const pages = [
      page([weightPoint("2026-08-02T09:00:00Z", 70_100)]),
      page([weightPoint("2026-08-04T09:00:00Z", 70_200)]),
    ];
    const client = makeFakeClient({ pagesByType: { weight: pages } });
    const store = freshStore();

    await syncAll(store, client, { dataTypes: ["weight"], since });
    const firstCount = store.observations(METRICS.weightKg, {
      from: "2000-01-01",
      to: "2099-01-01",
    }).length;

    // Second run: fake client still returns the same canned pages regardless
    // of the (now-advanced) watermark, mirroring a resync over an overlapping
    // window. Row count must not change.
    await syncAll(store, client, { dataTypes: ["weight"], since });
    const secondCount = store.observations(METRICS.weightKg, {
      from: "2000-01-01",
      to: "2099-01-01",
    }).length;

    expect(firstCount).toBe(2);
    expect(secondCount).toBe(firstCount);

    store.close();
  });
});
