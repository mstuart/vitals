/**
 * Sync orchestration: pulls every registered data type from the Health API
 * and persists it via the Store.
 *
 * Per data type:
 *   1. Resolve the window start (`opts.since`, else the stored watermark
 *      unless `opts.full`, else 30 days ago).
 *   2. If the type supports AIP-160 date filters, page with a server-side
 *      filter. If the API rejects the filter at runtime
 *      (`API_FILTER_UNSUPPORTED`), fall back to unfiltered paging.
 *   3. Otherwise (or on fallback) page unfiltered, stopping as soon as a
 *      page's newest timestamp predates the window start by more than two
 *      hours — without this, high-frequency types like heart-rate (~1Hz
 *      samples, ~48 minutes per page) would page back through all of
 *      history on every sync.
 *   4. Parse + write each consumed page, and advance the watermark to the
 *      newest timestamp actually persisted.
 *
 * A failure in one data type is caught and reported in its own SyncResult;
 * it never aborts the rest of the run, and its watermark is left untouched
 * so the next run re-pulls from the same point.
 */

import type { VitalsApiClient } from "../api/client.js";
import { buildDateFilter } from "../api/client.js";
import { allSpecs, specFor } from "../datatypes/index.js";
import type { Store } from "../store/api.js";
import type {
  ApiDataPointsResponse,
  DataTypeId,
  DataTypeSpec,
  SyncOptions,
  SyncProgress,
  SyncResult,
} from "../types.js";
import { VitalsError } from "../types.js";

const GRACE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_WINDOW_DAYS = 30;

function defaultWindowStart(now: Date): Date {
  return new Date(now.getTime() - DEFAULT_WINDOW_DAYS * 86_400_000);
}

function resolveSince(
  store: Store,
  dataType: DataTypeId,
  opts: SyncOptions,
  now: Date
): Date {
  if (opts.since) {
    return opts.since;
  }
  if (!opts.full) {
    const watermark = store.getWatermark(dataType);
    if (watermark?.newestTs) {
      return new Date(watermark.newestTs);
    }
  }
  return defaultWindowStart(now);
}

function newerTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) {
    return b;
  }
  if (b === null) {
    return a;
  }
  return Date.parse(b) > Date.parse(a) ? b : a;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Filter fallback, progress, and watermark updates form one sync state machine.
async function syncOne(
  store: Store,
  client: VitalsApiClient,
  spec: DataTypeSpec,
  opts: SyncOptions
): Promise<SyncResult> {
  const result: SyncResult = {
    dataType: spec.id,
    pagesFetched: 0,
    pointsParsed: 0,
    rowsWritten: 0,
  };
  let newestPersisted: string | null = null;

  const emitProgress = (done: boolean, error?: string): void => {
    if (!opts.onProgress) {
      return;
    }
    const event: SyncProgress = {
      dataType: spec.id,
      done,
      pagesFetched: result.pagesFetched,
      pointsParsed: result.pointsParsed,
      rowsWritten: result.rowsWritten,
      ...(error === undefined ? {} : { error }),
    };
    opts.onProgress(event);
  };

  const consumePage = (page: ApiDataPointsResponse): void => {
    const points = page.dataPoints ?? [];
    result.pagesFetched += 1;
    result.pointsParsed += points.length;
    result.rowsWritten += store.writeBatch(spec.parse(points));
    newestPersisted = newerTimestamp(
      newestPersisted,
      spec.newestTimestamp(points)
    );
    emitProgress(false);
  };

  try {
    const now = new Date();
    const since = resolveSince(store, spec.id, opts, now);

    let usedFilter = false;
    if (spec.supportsDateFilter && spec.filterField) {
      usedFilter = true;
      try {
        const filter = buildDateFilter(spec.filterField, since, now);
        for await (const page of client.pages(spec.id, {
          filter,
          pageSize: spec.pageSize,
        })) {
          consumePage(page);
        }
      } catch (err) {
        if (
          err instanceof VitalsError &&
          err.code === "API_FILTER_UNSUPPORTED"
        ) {
          usedFilter = false;
        } else {
          throw err;
        }
      }
    }

    if (!usedFilter) {
      const thresholdMs = since.getTime() - GRACE_MS;
      for await (const page of client.pages(spec.id, {
        pageSize: spec.pageSize,
      })) {
        const points = page.dataPoints ?? [];
        const newestInPage = spec.newestTimestamp(points);
        if (newestInPage !== null) {
          const newestMs = Date.parse(newestInPage);
          if (Number.isFinite(newestMs) && newestMs < thresholdMs) {
            break;
          }
        }
        consumePage(page);
      }
    }

    if (newestPersisted !== null) {
      store.setWatermark({
        dataType: spec.id,
        lastSyncedAt: now.toISOString(),
        newestTs: newestPersisted,
      });
    }

    emitProgress(true);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.error = message;
    emitProgress(true, message);
    return result;
  }
}

export async function syncAll(
  store: Store,
  client: VitalsApiClient,
  opts: SyncOptions = {}
): Promise<SyncResult[]> {
  const specs = opts.dataTypes
    ? opts.dataTypes.map((id) => specFor(id))
    : allSpecs();
  const results: SyncResult[] = [];
  for (const spec of specs) {
    // biome-ignore lint/performance/noAwaitInLoops: Sync order is intentional so progress and store writes remain deterministic.
    results.push(await syncOne(store, client, spec, opts));
  }
  return results;
}
