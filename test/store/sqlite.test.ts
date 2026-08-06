import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { openStore } from '../../src/store/sqlite.js';
import { emptyBatch } from '../../src/types.js';
import type { Checkin, HeartRateHourly, Observation, ParsedBatch, SyncWatermark } from '../../src/types.js';

function obs(overrides: Partial<Observation> = {}): Observation {
  return {
    metric: 'rhr',
    date: '2026-06-01',
    ts: '2026-06-01T08:00:00.000Z',
    value: 55,
    unit: 'bpm',
    naturalKey: `rhr-${overrides.date ?? '2026-06-01'}-${overrides.ts ?? '2026-06-01T08:00:00.000Z'}`,
    platform: 'fitbit',
    recordingMethod: 'automatic',
    ...overrides,
  };
}

function hr(overrides: Partial<HeartRateHourly> = {}): HeartRateHourly {
  return {
    naturalKey: 'hr-2026-06-01T08',
    date: '2026-06-01',
    hourTs: '2026-06-01T08:00:00.000Z',
    minBpm: 55,
    maxBpm: 65,
    avgBpm: 60,
    sampleCount: 10,
    ...overrides,
  };
}

function batchWith(partial: Partial<ParsedBatch>): ParsedBatch {
  return { ...emptyBatch(), ...partial };
}

describe('openStore / writeBatch idempotency', () => {
  it('re-applying the same batch leaves row counts and values identical', () => {
    const store = openStore(':memory:');
    const batch = batchWith({
      observations: [
        obs({ naturalKey: 'a', ts: '2026-06-01T08:00:00.000Z', value: 55 }),
        obs({ naturalKey: 'b', ts: '2026-06-01T20:00:00.000Z', value: 57 }),
      ],
      heartRateHourly: [hr()],
    });

    store.writeBatch(batch);
    const firstSeries = store.dailySeries('rhr', { from: '2026-06-01', to: '2026-06-01' });
    const firstHr = store.heartRateHourly({ from: '2026-06-01', to: '2026-06-01' });

    store.writeBatch(batch);
    const secondSeries = store.dailySeries('rhr', { from: '2026-06-01', to: '2026-06-01' });
    const secondHr = store.heartRateHourly({ from: '2026-06-01', to: '2026-06-01' });

    expect(secondSeries).toEqual(firstSeries);
    expect(secondHr).toEqual(firstHr);
    expect(store.observations('rhr', { from: '2026-06-01', to: '2026-06-01' })).toHaveLength(2);

    store.close();
  });
});

describe('dailySeries', () => {
  it('averages multiple same-day observations and omits empty days', () => {
    const store = openStore(':memory:');
    store.writeBatch(
      batchWith({
        observations: [
          obs({ naturalKey: 'a', date: '2026-06-01', ts: '2026-06-01T08:00:00.000Z', value: 50 }),
          obs({ naturalKey: 'b', date: '2026-06-01', ts: '2026-06-01T20:00:00.000Z', value: 60 }),
          // 2026-06-02 has no observations - must be absent, not zero.
          obs({ naturalKey: 'c', date: '2026-06-03', ts: '2026-06-03T08:00:00.000Z', value: 70 }),
        ],
      }),
    );

    const series = store.dailySeries('rhr', { from: '2026-06-01', to: '2026-06-03' });

    expect(series).toEqual([
      { date: '2026-06-01', value: 55 },
      { date: '2026-06-03', value: 70 },
    ]);
    store.close();
  });

  it('respects range bounds inclusively', () => {
    const store = openStore(':memory:');
    store.writeBatch(
      batchWith({
        observations: [
          obs({ naturalKey: 'a', date: '2026-06-01', ts: '2026-06-01T08:00:00.000Z', value: 10 }),
          obs({ naturalKey: 'b', date: '2026-06-02', ts: '2026-06-02T08:00:00.000Z', value: 20 }),
          obs({ naturalKey: 'c', date: '2026-06-03', ts: '2026-06-03T08:00:00.000Z', value: 30 }),
        ],
      }),
    );

    // Bounds are inclusive on both ends.
    expect(store.dailySeries('rhr', { from: '2026-06-01', to: '2026-06-03' })).toHaveLength(3);
    expect(store.dailySeries('rhr', { from: '2026-06-02', to: '2026-06-02' })).toEqual([
      { date: '2026-06-02', value: 20 },
    ]);
    expect(store.dailySeries('rhr', { from: '2026-06-01', to: '2026-06-01' })).toEqual([
      { date: '2026-06-01', value: 10 },
    ]);
    // Range that excludes all data.
    expect(store.dailySeries('rhr', { from: '2026-05-01', to: '2026-05-31' })).toEqual([]);
    store.close();
  });
});

describe('hr_hourly merge semantics', () => {
  it('replaces (not double-counts) when re-applying an identical bucket', () => {
    const store = openStore(':memory:');
    const bucket = hr({ naturalKey: 'h1', minBpm: 55, maxBpm: 65, avgBpm: 60, sampleCount: 10 });

    store.writeBatch(batchWith({ heartRateHourly: [bucket] }));
    store.writeBatch(batchWith({ heartRateHourly: [bucket] }));

    const rows = store.heartRateHourly({ from: '2026-06-01', to: '2026-06-01' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ minBpm: 55, maxBpm: 65, avgBpm: 60, sampleCount: 10 });
    store.close();
  });

  it('merges two disjoint partial buckets into weighted avg/min/max/count', () => {
    const store = openStore(':memory:');

    // First write: the larger partial (establishes the stored row).
    store.writeBatch(
      batchWith({
        heartRateHourly: [
          hr({ naturalKey: 'h1', minBpm: 55, maxBpm: 65, avgBpm: 60, sampleCount: 10 }),
        ],
      }),
    );
    // Second write: a smaller, disjoint partial for the same hour -> merge.
    store.writeBatch(
      batchWith({
        heartRateHourly: [
          hr({ naturalKey: 'h1', minBpm: 68, maxBpm: 75, avgBpm: 70, sampleCount: 6 }),
        ],
      }),
    );

    const rows = store.heartRateHourly({ from: '2026-06-01', to: '2026-06-01' });
    expect(rows).toHaveLength(1);
    const merged = rows[0];
    expect(merged).toBeDefined();
    expect(merged?.sampleCount).toBe(16);
    expect(merged?.minBpm).toBe(55);
    expect(merged?.maxBpm).toBe(75);
    // (60*10 + 70*6) / 16 = 63.75
    expect(merged?.avgBpm).toBeCloseTo(63.75, 6);
    store.close();
  });
});

describe('checkins', () => {
  it('round-trips including tags JSON and an empty tag array', () => {
    const store = openStore(':memory:');

    const withTags = store.addCheckin({
      date: '2026-06-01',
      ts: '2026-06-01T09:00:00.000Z',
      mood: 7,
      note: 'felt good',
      tags: ['energetic', 'focused'],
    });
    const noTags = store.addCheckin({
      date: '2026-06-02',
      ts: '2026-06-02T09:00:00.000Z',
      mood: 4,
      note: null,
      tags: [],
    });

    expect(withTags.id).toBeTypeOf('number');
    expect(withTags.tags).toEqual(['energetic', 'focused']);
    expect(noTags.tags).toEqual([]);

    const fetched = store.checkin('2026-06-01');
    expect(fetched).toMatchObject({
      date: '2026-06-01',
      mood: 7,
      note: 'felt good',
      tags: ['energetic', 'focused'],
    });

    const fetchedEmpty = store.checkin('2026-06-02');
    expect(fetchedEmpty?.tags).toEqual([]);

    const range = store.checkins({ from: '2026-06-01', to: '2026-06-02' });
    expect(range).toHaveLength(2);

    store.close();
  });
});

describe('watermarks', () => {
  it('set/get/allWatermarks round-trip, including a null newest_ts', () => {
    const store = openStore(':memory:');

    expect(store.getWatermark('steps')).toBeNull();

    const w1: SyncWatermark = {
      dataType: 'steps',
      newestTs: '2026-06-01T00:00:00.000Z',
      lastSyncedAt: '2026-06-02T00:00:00.000Z',
    };
    const w2: SyncWatermark = {
      dataType: 'sleep',
      newestTs: null,
      lastSyncedAt: '2026-06-02T00:00:00.000Z',
    };

    store.setWatermark(w1);
    store.setWatermark(w2);

    expect(store.getWatermark('steps')).toEqual(w1);
    expect(store.getWatermark('sleep')).toEqual(w2);
    expect(store.getWatermark('weight')).toBeNull();

    const all = store.allWatermarks();
    expect(all).toHaveLength(2);
    expect(all).toEqual(expect.arrayContaining([w1, w2]));

    // Updating an existing watermark overwrites rather than duplicating.
    const w1Updated: SyncWatermark = {
      dataType: 'steps',
      newestTs: '2026-06-05T00:00:00.000Z',
      lastSyncedAt: '2026-06-06T00:00:00.000Z',
    };
    store.setWatermark(w1Updated);
    expect(store.getWatermark('steps')).toEqual(w1Updated);
    expect(store.allWatermarks()).toHaveLength(2);

    store.close();
  });
});

describe('coverage', () => {
  it('returns null on an empty store', () => {
    const store = openStore(':memory:');
    expect(store.coverage()).toBeNull();
    store.close();
  });

  it('returns the min/max date across observations and sleep sessions', () => {
    const store = openStore(':memory:');
    store.writeBatch(
      batchWith({
        observations: [obs({ naturalKey: 'a', date: '2026-06-10', ts: '2026-06-10T08:00:00.000Z' })],
        sleepSessions: [
          {
            naturalKey: 's1',
            date: '2026-06-15',
            startTs: '2026-06-14T23:00:00.000Z',
            endTs: '2026-06-15T07:00:00.000Z',
            type: 'main',
            totalMinutes: 480,
            asleepMinutes: 450,
            awakeMinutes: 30,
            deepMinutes: 100,
            remMinutes: 100,
            lightMinutes: 250,
            efficiency: 0.94,
            stages: [
              { type: 'DEEP', startTs: '2026-06-14T23:00:00.000Z', endTs: '2026-06-15T00:40:00.000Z', minutes: 100 },
            ],
            platform: 'fitbit',
          },
        ],
      }),
    );

    expect(store.coverage()).toEqual({ from: '2026-06-10', to: '2026-06-15' });
    store.close();
  });
});

describe('migrations', () => {
  it('are idempotent: opening the same db file twice does not throw', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vitals-store-test-'));
    const dbFile = join(dir, 'vitals.db');

    const store1 = openStore(dbFile);
    store1.writeBatch(batchWith({ observations: [obs({ naturalKey: 'a' })] }));
    store1.close();

    expect(() => {
      const store2 = openStore(dbFile);
      const series = store2.dailySeries('rhr', { from: '2026-01-01', to: '2026-12-31' });
      expect(series).toHaveLength(1);
      store2.close();
    }).not.toThrow();

    rmSync(dir, { recursive: true, force: true });
  });
});
