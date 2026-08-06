import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getAccessToken } from '../../src/auth/token.js';
import type { Paths } from '../../src/types.js';
import { VitalsError } from '../../src/types.js';

let dir: string;
let paths: Paths;

const SOURCE_CREDS = {
  client_id: 'test-client-id',
  client_secret: 'test-client-secret',
  refresh_token: 'test-refresh-token',
  token: 'stale-token',
  expiry: '2020-01-01T00:00:00.000Z',
  scopes: ['fitness.read'],
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vitals-token-test-'));
  paths = {
    dataDir: dir,
    dbFile: join(dir, 'vitals.db'),
    tokenCacheFile: join(dir, 'token.json'),
    credentialsFile: join(dir, 'credentials.json'),
    externalCredentialsFile: null,
  };
  await writeFile(paths.credentialsFile, JSON.stringify(SOURCE_CREDS, null, 2));
});

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeFetch(status: number, body: unknown): typeof fetch {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return vi.fn(async () =>
    new Response(text, {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  ) as unknown as typeof fetch;
}

describe('getAccessToken', () => {
  it('reuses a cached token that is not near expiry', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    await writeFile(
      paths.tokenCacheFile,
      JSON.stringify({ token: 'cached-token', expiresAt: '2026-01-01T01:00:00.000Z' }),
    );
    const fetchImpl = fakeFetch(200, { access_token: 'should-not-be-used', expires_in: 3600 });

    const token = await getAccessToken(paths, { now, fetchImpl });

    expect(token).toBe('cached-token');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('refreshes when the cached token is already expired', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    await writeFile(
      paths.tokenCacheFile,
      JSON.stringify({ token: 'expired-token', expiresAt: '2025-12-31T23:00:00.000Z' }),
    );
    const fetchImpl = fakeFetch(200, { access_token: 'fresh-token', expires_in: 3600 });

    const token = await getAccessToken(paths, { now, fetchImpl });

    expect(token).toBe('fresh-token');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('refreshes when the cached token expires within 60s', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    await writeFile(
      paths.tokenCacheFile,
      JSON.stringify({ token: 'near-expiry-token', expiresAt: '2026-01-01T00:00:30.000Z' }),
    );
    const fetchImpl = fakeFetch(200, { access_token: 'fresh-token', expires_in: 3600 });

    const token = await getAccessToken(paths, { now, fetchImpl });

    expect(token).toBe('fresh-token');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('raises AUTH_MISSING pointing at `vitals auth` when no credentials exist', async () => {
    const missingPaths: Paths = { ...paths, credentialsFile: join(dir, 'does-not-exist.json') };
    const fetchImpl = fakeFetch(200, { access_token: 'x', expires_in: 3600 });

    await expect(getAccessToken(missingPaths, { fetchImpl })).rejects.toMatchObject({
      code: 'AUTH_MISSING',
    });

    try {
      await getAccessToken(missingPaths, { fetchImpl });
      throw new Error('expected getAccessToken to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VitalsError);
      const ve = err as VitalsError;
      expect(ve.hint).toContain('vitals auth');
    }
  });

  it('raises AUTH_REFRESH_FAILED including status and body on HTTP 400', async () => {
    const fetchImpl = fakeFetch(400, { error: 'invalid_grant', error_description: 'Bad refresh token' });

    await expect(getAccessToken(paths, { fetchImpl })).rejects.toMatchObject({
      code: 'AUTH_REFRESH_FAILED',
    });

    try {
      await getAccessToken(paths, { fetchImpl });
      throw new Error('expected getAccessToken to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VitalsError);
      const ve = err as VitalsError;
      expect(ve.message).toContain('400');
      expect(ve.message).toContain('invalid_grant');
    }
  });

  it('never modifies an external credential file', async () => {
    const before = await readFile(paths.credentialsFile, 'utf-8');
    const fetchImpl = fakeFetch(200, { access_token: 'fresh-token', expires_in: 3600 });

    await getAccessToken(paths, { fetchImpl });

    const after = await readFile(paths.credentialsFile, 'utf-8');
    expect(after).toBe(before);
  });

  it('writes the cache file with mode 0600', async () => {
    const fetchImpl = fakeFetch(200, { access_token: 'fresh-token', expires_in: 3600 });

    await getAccessToken(paths, { fetchImpl });

    const st = await stat(paths.tokenCacheFile);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it('creates the data dir if absent', async () => {
    const nestedDir = join(dir, 'nested', 'data');
    const nestedPaths: Paths = {
      dataDir: nestedDir,
      dbFile: join(nestedDir, 'vitals.db'),
      tokenCacheFile: join(nestedDir, 'token.json'),
      // No credentials in the nested dir; fall back to the external file.
      credentialsFile: join(nestedDir, 'credentials.json'),
      externalCredentialsFile: paths.credentialsFile,
    };
    const fetchImpl = fakeFetch(200, { access_token: 'fresh-token', expires_in: 3600 });

    const token = await getAccessToken(nestedPaths, { fetchImpl });

    expect(token).toBe('fresh-token');
    const st = await stat(nestedPaths.tokenCacheFile);
    expect(st.isFile()).toBe(true);
  });
});
