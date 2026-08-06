import { describe, expect, it, vi } from 'vitest';

import { buildDateFilter, createClient } from '../../src/api/client.js';
import { VitalsError } from '../../src/types.js';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(status: number, body: string): Response {
  return new Response(body, { status });
}

describe('createClient', () => {
  it('lists a single page and sends the bearer token', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toContain('/dataTypes/steps/dataPoints');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer test-token');
      return jsonResponse(200, { dataPoints: [{ name: 'a' }] });
    });

    const client = createClient({
      getToken: async () => 'test-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await client.listDataPoints('steps', { pageSize: 100 });
    expect(result.dataPoints).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('pages() follows nextPageToken and sends it on the following call', async () => {
    const calls: Array<string | URL | Request> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      calls.push(url);
      if (String(url).includes('pageToken=tok-2')) {
        return jsonResponse(200, { dataPoints: [{ name: 'page2' }] });
      }
      return jsonResponse(200, { dataPoints: [{ name: 'page1' }], nextPageToken: 'tok-2' });
    });

    const client = createClient({
      getToken: async () => 'test-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const collected: unknown[] = [];
    for await (const page of client.pages('steps')) {
      collected.push(page);
    }

    expect(collected).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(calls[0])).not.toContain('pageToken=');
    expect(String(calls[1])).toContain('pageToken=tok-2');
  });

  it('caps pages() at 500 iterations when nextPageToken never clears', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      return jsonResponse(200, { dataPoints: [{ name: `p${call}` }], nextPageToken: 'always' });
    });

    const client = createClient({
      getToken: async () => 'test-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    let count = 0;
    for await (const _page of client.pages('steps')) {
      count++;
    }

    expect(count).toBe(500);
    expect(fetchImpl).toHaveBeenCalledTimes(500);
  });

  it('retries after a 429 and succeeds on the next attempt', async () => {
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call === 1) return textResponse(429, 'rate limited');
      return jsonResponse(200, { dataPoints: [{ name: 'ok' }] });
    });
    const delays: number[] = [];

    const client = createClient({
      getToken: async () => 'test-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      delayImpl: async (ms: number) => {
        delays.push(ms);
      },
    });

    const result = await client.listDataPoints('steps');
    expect(result.dataPoints).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(delays).toEqual([500]);
  });

  it('raises API_HTTP after 3 attempts on persistent 500s', async () => {
    const fetchImpl = vi.fn(async () => textResponse(500, 'server error'));

    const client = createClient({
      getToken: async () => 'test-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      delayImpl: async () => {},
    });

    await expect(client.listDataPoints('steps')).rejects.toMatchObject({
      code: 'API_HTTP',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('raises API_FILTER_UNSUPPORTED for the filter-restriction 400', async () => {
    const fetchImpl = vi.fn(async () =>
      textResponse(
        400,
        JSON.stringify({
          error: { message: 'INVALID_DATA_POINT_FILTER_DATA_TYPE_RESTRICTION' },
        }),
      ),
    );

    const client = createClient({
      getToken: async () => 'test-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    let caught: unknown;
    try {
      await client.listDataPoints('heart-rate', { filter: 'startTime >= "x"' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(VitalsError);
    expect((caught as VitalsError).code).toBe('API_FILTER_UNSUPPORTED');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces a 401 as API_HTTP with a credentials hint', async () => {
    const fetchImpl = vi.fn(async () => textResponse(401, 'unauthorized'));

    const client = createClient({
      getToken: async () => 'test-token',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    let caught: unknown;
    try {
      await client.listDataPoints('steps');
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(VitalsError);
    expect((caught as VitalsError).code).toBe('API_HTTP');
    expect((caught as VitalsError).hint).toMatch(/credentials|token/i);
  });
});

describe('buildDateFilter', () => {
  it('produces a half-open AIP-160 range filter', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-02-01T00:00:00.000Z');
    const filter = buildDateFilter('startTime', from, to);
    expect(filter).toBe(
      'startTime >= "2026-01-01T00:00:00.000Z" AND startTime < "2026-02-01T00:00:00.000Z"',
    );
  });

  it('is safely embeddable as a URLSearchParams value', () => {
    const from = new Date('2026-01-01T00:00:00.000Z');
    const to = new Date('2026-02-01T00:00:00.000Z');
    const filter = buildDateFilter('startTime', from, to);
    const params = new URLSearchParams({ filter });
    expect(params.get('filter')).toBe(filter);
    expect(params.toString()).toContain('filter=');
  });
});
