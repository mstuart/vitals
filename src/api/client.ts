import type { ApiDataPointsResponse, DataTypeId } from '../types.js';
import { VitalsError } from '../types.js';
import { API_BASE } from '../config/paths.js';

const MAX_PAGES = 500;
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

const FILTER_UNSUPPORTED_MARKER = 'INVALID_DATA_POINT_FILTER_DATA_TYPE_RESTRICTION';

export interface ListDataPointsOptions {
  pageSize?: number;
  pageToken?: string;
  filter?: string;
}

export interface CreateClientOptions {
  getToken(): Promise<string>;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Injectable sleep for retry backoff, so tests do not actually wait. */
  delayImpl?: (ms: number) => Promise<void>;
}

export interface VitalsApiClient {
  listDataPoints(id: DataTypeId, o?: ListDataPointsOptions): Promise<ApiDataPointsResponse>;
  pages(id: DataTypeId, o?: ListDataPointsOptions): AsyncGenerator<ApiDataPointsResponse>;
}

/**
 * Build an AIP-160 filter for a half-open date range on `field`.
 * `URLSearchParams` handles the percent-encoding when this is used as a
 * query param value.
 */
export function buildDateFilter(field: string, from: Date, to: Date): string {
  return `${field} >= "${from.toISOString()}" AND ${field} < "${to.toISOString()}"`;
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createClient(opts: CreateClientOptions): VitalsApiClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.baseUrl ?? API_BASE;
  const delayImpl = opts.delayImpl ?? defaultDelay;

  async function listDataPoints(
    id: DataTypeId,
    o: ListDataPointsOptions = {},
  ): Promise<ApiDataPointsResponse> {
    const params = new URLSearchParams();
    if (o.pageSize !== undefined) params.set('pageSize', String(o.pageSize));
    if (o.pageToken !== undefined) params.set('pageToken', o.pageToken);
    if (o.filter !== undefined) params.set('filter', o.filter);

    const qs = params.toString();
    const url = `${baseUrl}/dataTypes/${id}/dataPoints${qs ? `?${qs}` : ''}`;

    const token = await opts.getToken();

    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'GET',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (err) {
        lastError = err;
        if (attempt < MAX_ATTEMPTS) {
          await delayImpl(BASE_DELAY_MS * 2 ** (attempt - 1));
          continue;
        }
        throw new VitalsError('API_HTTP', `Network error calling ${id} data point list.`, {
          cause: err,
        });
      }

      if (response.ok) {
        return (await response.json()) as ApiDataPointsResponse;
      }

      const status = response.status;
      const body = await response.text();

      if (status === 400 && body.includes(FILTER_UNSUPPORTED_MARKER)) {
        throw new VitalsError(
          'API_FILTER_UNSUPPORTED',
          `Data type "${id}" does not support date filters.`,
          { hint: 'Retry the request without a date filter for this data type.' },
        );
      }

      if ((status === 429 || status >= 500) && attempt < MAX_ATTEMPTS) {
        lastError = new VitalsError(
          'API_HTTP',
          `Request to ${id} data points failed with HTTP ${status}.`,
          { hint: body },
        );
        await delayImpl(BASE_DELAY_MS * 2 ** (attempt - 1));
        continue;
      }

      const hint =
        status === 401
          ? 'Access token was rejected (401). Run `vitals auth` to reconnect.'
          : undefined;
      throw new VitalsError(
        'API_HTTP',
        `Request to ${id} data points failed with HTTP ${status}.`,
        { hint: hint ?? body, cause: body },
      );
    }

    // Unreachable in practice: the loop above always returns or throws.
    if (lastError instanceof VitalsError) throw lastError;
    throw new VitalsError('API_HTTP', `Request to ${id} data points failed.`, {
      cause: lastError,
    });
  }

  async function* pages(
    id: DataTypeId,
    o: ListDataPointsOptions = {},
  ): AsyncGenerator<ApiDataPointsResponse> {
    let pageToken = o.pageToken;
    let pageCount = 0;

    while (pageCount < MAX_PAGES) {
      const response: ApiDataPointsResponse = await listDataPoints(id, {
        ...o,
        pageToken,
      });
      pageCount++;
      yield response;

      if (!response.nextPageToken) return;
      pageToken = response.nextPageToken;
    }
  }

  return { listDataPoints, pages };
}
