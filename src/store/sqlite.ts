/**
 * better-sqlite3 implementation of the `Store` interface.
 *
 * Idempotency: every upsert keys off the natural key derived by the parser
 * (see src/datatypes). Re-applying an identical `ParsedBatch` must leave row
 * counts and values unchanged, so every insert uses
 * `INSERT ... ON CONFLICT DO UPDATE`.
 *
 * hr_hourly is the one table where a blind overwrite would lose data: the
 * same UTC hour can be assembled from two separate API pages, each carrying
 * a different partial set of raw samples. See the ON CONFLICT clause on
 * `hrHourlyUpsert` below for the merge-vs-replace rule and rationale.
 */
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  Checkin,
  DataTypeId,
  ExerciseSession,
  HeartRateHourly,
  HydrationEntry,
  MetricId,
  NutritionEntry,
  Observation,
  ParsedBatch,
  SleepSession,
  SleepStage,
  SleepStageType,
  SyncWatermark,
} from '../types.js';
import type { DailyValue, DateRange, Store } from './api.js';
import { migrate } from './schema.js';

// ---------------------------------------------------------------------------
// Row shapes (snake_case, as returned by better-sqlite3)
// ---------------------------------------------------------------------------

interface ObservationRow {
  metric: string;
  natural_key: string;
  date: string;
  ts: string | null;
  value: number;
  unit: string;
  platform: string | null;
  recording_method: string | null;
}

interface DailyRow {
  date: string;
  value: number;
}

interface SleepSessionRow {
  natural_key: string;
  date: string;
  start_ts: string;
  end_ts: string;
  type: string | null;
  total_minutes: number;
  asleep_minutes: number;
  awake_minutes: number;
  deep_minutes: number;
  rem_minutes: number;
  light_minutes: number;
  efficiency: number | null;
  platform: string | null;
}

interface SleepStageRow {
  session_key: string;
  idx: number;
  type: string;
  start_ts: string;
  end_ts: string;
  minutes: number;
}

interface ExerciseRow {
  natural_key: string;
  date: string;
  start_ts: string;
  end_ts: string | null;
  display_name: string | null;
  exercise_type: string | null;
  intensity: string | null;
  avg_heart_rate: number | null;
  calories_burned: number | null;
  platform: string | null;
}

interface NutritionRow {
  natural_key: string;
  date: string;
  ts: string;
  food_display_name: string | null;
  meal_type: string | null;
  energy_kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
}

interface HydrationRow {
  natural_key: string;
  date: string;
  ts: string;
  milliliters: number;
}

interface HrHourlyRow {
  natural_key: string;
  date: string;
  hour_ts: string;
  min_bpm: number;
  max_bpm: number;
  avg_bpm: number;
  sample_count: number;
}

interface CheckinRow {
  id: number;
  date: string;
  ts: string;
  mood: number;
  note: string | null;
  tags: string;
}

interface SyncStateRow {
  data_type: string;
  newest_ts: string | null;
  last_synced_at: string;
}

// ---------------------------------------------------------------------------
// Row -> domain mapping
// ---------------------------------------------------------------------------

function observationFromRow(r: ObservationRow): Observation {
  return {
    metric: r.metric as MetricId,
    date: r.date,
    ts: r.ts,
    value: r.value,
    unit: r.unit,
    naturalKey: r.natural_key,
    platform: r.platform,
    recordingMethod: r.recording_method,
  };
}

function stageFromRow(r: SleepStageRow): SleepStage {
  return {
    type: r.type as SleepStageType,
    startTs: r.start_ts,
    endTs: r.end_ts,
    minutes: r.minutes,
  };
}

function sleepSessionFromRow(r: SleepSessionRow, stages: SleepStage[]): SleepSession {
  return {
    naturalKey: r.natural_key,
    date: r.date,
    startTs: r.start_ts,
    endTs: r.end_ts,
    type: r.type,
    totalMinutes: r.total_minutes,
    asleepMinutes: r.asleep_minutes,
    awakeMinutes: r.awake_minutes,
    deepMinutes: r.deep_minutes,
    remMinutes: r.rem_minutes,
    lightMinutes: r.light_minutes,
    efficiency: r.efficiency,
    stages,
    platform: r.platform,
  };
}

function exerciseFromRow(r: ExerciseRow): ExerciseSession {
  return {
    naturalKey: r.natural_key,
    date: r.date,
    startTs: r.start_ts,
    endTs: r.end_ts,
    displayName: r.display_name,
    exerciseType: r.exercise_type,
    intensity: r.intensity,
    avgHeartRate: r.avg_heart_rate,
    caloriesBurned: r.calories_burned,
    platform: r.platform,
  };
}

function nutritionFromRow(r: NutritionRow): NutritionEntry {
  return {
    naturalKey: r.natural_key,
    date: r.date,
    ts: r.ts,
    foodDisplayName: r.food_display_name,
    mealType: r.meal_type,
    energyKcal: r.energy_kcal,
    proteinG: r.protein_g,
    carbsG: r.carbs_g,
    fatG: r.fat_g,
  };
}

function hydrationFromRow(r: HydrationRow): HydrationEntry {
  return {
    naturalKey: r.natural_key,
    date: r.date,
    ts: r.ts,
    milliliters: r.milliliters,
  };
}

function hrHourlyFromRow(r: HrHourlyRow): HeartRateHourly {
  return {
    naturalKey: r.natural_key,
    date: r.date,
    hourTs: r.hour_ts,
    minBpm: r.min_bpm,
    maxBpm: r.max_bpm,
    avgBpm: r.avg_bpm,
    sampleCount: r.sample_count,
  };
}

function checkinFromRow(r: CheckinRow): Checkin {
  return {
    id: r.id,
    date: r.date,
    ts: r.ts,
    mood: r.mood,
    note: r.note,
    tags: JSON.parse(r.tags) as string[],
  };
}

function watermarkFromRow(r: SyncStateRow): SyncWatermark {
  return {
    dataType: r.data_type as DataTypeId,
    newestTs: r.newest_ts,
    lastSyncedAt: r.last_synced_at,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function openStore(dbFile: string): Store {
  if (dbFile !== ':memory:') {
    mkdirSync(dirname(dbFile), { recursive: true });
  }

  const db = new Database(dbFile);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);

  // -- upserts --------------------------------------------------------------

  const upsertObservation = db.prepare<{
    metric: string;
    naturalKey: string;
    date: string;
    ts: string | null;
    value: number;
    unit: string;
    platform: string | null;
    recordingMethod: string | null;
  }>(`
    INSERT INTO observations (metric, natural_key, date, ts, value, unit, platform, recording_method)
    VALUES (@metric, @naturalKey, @date, @ts, @value, @unit, @platform, @recordingMethod)
    ON CONFLICT(metric, natural_key) DO UPDATE SET
      date = excluded.date,
      ts = excluded.ts,
      value = excluded.value,
      unit = excluded.unit,
      platform = excluded.platform,
      recording_method = excluded.recording_method
  `);

  const upsertSleepSession = db.prepare<{
    naturalKey: string;
    date: string;
    startTs: string;
    endTs: string;
    type: string | null;
    totalMinutes: number;
    asleepMinutes: number;
    awakeMinutes: number;
    deepMinutes: number;
    remMinutes: number;
    lightMinutes: number;
    efficiency: number | null;
    platform: string | null;
  }>(`
    INSERT INTO sleep_sessions (
      natural_key, date, start_ts, end_ts, type, total_minutes, asleep_minutes,
      awake_minutes, deep_minutes, rem_minutes, light_minutes, efficiency, platform
    ) VALUES (
      @naturalKey, @date, @startTs, @endTs, @type, @totalMinutes, @asleepMinutes,
      @awakeMinutes, @deepMinutes, @remMinutes, @lightMinutes, @efficiency, @platform
    )
    ON CONFLICT(natural_key) DO UPDATE SET
      date = excluded.date,
      start_ts = excluded.start_ts,
      end_ts = excluded.end_ts,
      type = excluded.type,
      total_minutes = excluded.total_minutes,
      asleep_minutes = excluded.asleep_minutes,
      awake_minutes = excluded.awake_minutes,
      deep_minutes = excluded.deep_minutes,
      rem_minutes = excluded.rem_minutes,
      light_minutes = excluded.light_minutes,
      efficiency = excluded.efficiency,
      platform = excluded.platform
  `);

  const deleteStages = db.prepare<[string]>(`DELETE FROM sleep_stages WHERE session_key = ?`);
  const insertStage = db.prepare<{
    sessionKey: string;
    idx: number;
    type: string;
    startTs: string;
    endTs: string;
    minutes: number;
  }>(`
    INSERT INTO sleep_stages (session_key, idx, type, start_ts, end_ts, minutes)
    VALUES (@sessionKey, @idx, @type, @startTs, @endTs, @minutes)
  `);

  const upsertExercise = db.prepare<{
    naturalKey: string;
    date: string;
    startTs: string;
    endTs: string | null;
    displayName: string | null;
    exerciseType: string | null;
    intensity: string | null;
    avgHeartRate: number | null;
    caloriesBurned: number | null;
    platform: string | null;
  }>(`
    INSERT INTO exercises (
      natural_key, date, start_ts, end_ts, display_name, exercise_type, intensity,
      avg_heart_rate, calories_burned, platform
    ) VALUES (
      @naturalKey, @date, @startTs, @endTs, @displayName, @exerciseType, @intensity,
      @avgHeartRate, @caloriesBurned, @platform
    )
    ON CONFLICT(natural_key) DO UPDATE SET
      date = excluded.date,
      start_ts = excluded.start_ts,
      end_ts = excluded.end_ts,
      display_name = excluded.display_name,
      exercise_type = excluded.exercise_type,
      intensity = excluded.intensity,
      avg_heart_rate = excluded.avg_heart_rate,
      calories_burned = excluded.calories_burned,
      platform = excluded.platform
  `);

  const upsertNutrition = db.prepare<{
    naturalKey: string;
    date: string;
    ts: string;
    foodDisplayName: string | null;
    mealType: string | null;
    energyKcal: number | null;
    proteinG: number | null;
    carbsG: number | null;
    fatG: number | null;
  }>(`
    INSERT INTO nutrition_entries (
      natural_key, date, ts, food_display_name, meal_type, energy_kcal, protein_g, carbs_g, fat_g
    ) VALUES (
      @naturalKey, @date, @ts, @foodDisplayName, @mealType, @energyKcal, @proteinG, @carbsG, @fatG
    )
    ON CONFLICT(natural_key) DO UPDATE SET
      date = excluded.date,
      ts = excluded.ts,
      food_display_name = excluded.food_display_name,
      meal_type = excluded.meal_type,
      energy_kcal = excluded.energy_kcal,
      protein_g = excluded.protein_g,
      carbs_g = excluded.carbs_g,
      fat_g = excluded.fat_g
  `);

  const upsertHydration = db.prepare<{
    naturalKey: string;
    date: string;
    ts: string;
    milliliters: number;
  }>(`
    INSERT INTO hydration_entries (natural_key, date, ts, milliliters)
    VALUES (@naturalKey, @date, @ts, @milliliters)
    ON CONFLICT(natural_key) DO UPDATE SET
      date = excluded.date,
      ts = excluded.ts,
      milliliters = excluded.milliliters
  `);

  /**
   * hr_hourly merge rule.
   *
   * The same UTC hour bucket can arrive twice: split across two API pages
   * (two disjoint partial sample sets that must be summed), or re-delivered
   * whole on a later sync (a full resync of a bucket already stored, which
   * must NOT be double-counted).
   *
   * We can't tell these apart from the data alone, so we use sample_count as
   * the signal: if the incoming write's sample_count is >= what's already
   * stored, we treat it as the more complete/authoritative view of the
   * bucket and REPLACE. This makes exact re-application idempotent (equal
   * counts -> replace with identical values, no double count) and makes a
   * later fuller resync correct (a bigger incoming count wins outright
   * rather than being summed on top of the smaller one it already
   * contains). Only when the incoming count is strictly smaller than what's
   * stored do we MERGE (sum counts, weighted-average the bpm average,
   * min/max across both) — the working assumption there is that the
   * smaller incoming write is a genuinely disjoint partial that hasn't been
   * folded in yet.
   *
   * This is a heuristic, not a proof: a disjoint partial that happens to be
   * >= the stored count would incorrectly replace instead of merge. The API
   * gives us no page-identity to tell the two cases apart, so between
   * "risk under-counting a rare larger disjoint partial" and "risk
   * double-counting on every routine resync", we chose the one that keeps
   * idempotency (the harder requirement) intact by construction.
   */
  const upsertHrHourly = db.prepare<{
    naturalKey: string;
    date: string;
    hourTs: string;
    minBpm: number;
    maxBpm: number;
    avgBpm: number;
    sampleCount: number;
  }>(`
    INSERT INTO hr_hourly (natural_key, date, hour_ts, min_bpm, max_bpm, avg_bpm, sample_count)
    VALUES (@naturalKey, @date, @hourTs, @minBpm, @maxBpm, @avgBpm, @sampleCount)
    ON CONFLICT(natural_key) DO UPDATE SET
      date = excluded.date,
      hour_ts = excluded.hour_ts,
      min_bpm = CASE
        WHEN excluded.sample_count >= hr_hourly.sample_count THEN excluded.min_bpm
        ELSE MIN(hr_hourly.min_bpm, excluded.min_bpm)
      END,
      max_bpm = CASE
        WHEN excluded.sample_count >= hr_hourly.sample_count THEN excluded.max_bpm
        ELSE MAX(hr_hourly.max_bpm, excluded.max_bpm)
      END,
      avg_bpm = CASE
        WHEN excluded.sample_count >= hr_hourly.sample_count THEN excluded.avg_bpm
        ELSE (hr_hourly.avg_bpm * hr_hourly.sample_count + excluded.avg_bpm * excluded.sample_count)
             / (hr_hourly.sample_count + excluded.sample_count)
      END,
      sample_count = CASE
        WHEN excluded.sample_count >= hr_hourly.sample_count THEN excluded.sample_count
        ELSE hr_hourly.sample_count + excluded.sample_count
      END
  `);

  const insertCheckinStmt = db.prepare<{
    date: string;
    ts: string;
    mood: number;
    note: string | null;
    tags: string;
  }>(`
    INSERT INTO checkins (date, ts, mood, note, tags)
    VALUES (@date, @ts, @mood, @note, @tags)
  `);

  const upsertWatermarkStmt = db.prepare<{
    dataType: string;
    newestTs: string | null;
    lastSyncedAt: string;
  }>(`
    INSERT INTO sync_state (data_type, newest_ts, last_synced_at)
    VALUES (@dataType, @newestTs, @lastSyncedAt)
    ON CONFLICT(data_type) DO UPDATE SET
      newest_ts = excluded.newest_ts,
      last_synced_at = excluded.last_synced_at
  `);

  // -- reads ------------------------------------------------------------

  const dailySeriesStmt = db.prepare<[string, string, string], DailyRow>(`
    SELECT date, AVG(value) as value
    FROM observations
    WHERE metric = ? AND date >= ? AND date <= ?
    GROUP BY date
    ORDER BY date ASC
  `);

  const latestBoundedStmt = db.prepare<[string, string], DailyRow>(`
    SELECT date, AVG(value) as value
    FROM observations
    WHERE metric = ? AND date <= ?
    GROUP BY date
    ORDER BY date DESC
    LIMIT 1
  `);

  const latestUnboundedStmt = db.prepare<[string], DailyRow>(`
    SELECT date, AVG(value) as value
    FROM observations
    WHERE metric = ?
    GROUP BY date
    ORDER BY date DESC
    LIMIT 1
  `);

  const observationsStmt = db.prepare<[string, string, string], ObservationRow>(`
    SELECT * FROM observations
    WHERE metric = ? AND date >= ? AND date <= ?
    ORDER BY date ASC, ts ASC
  `);

  const sleepSessionsStmt = db.prepare<[string, string], SleepSessionRow>(`
    SELECT * FROM sleep_sessions
    WHERE date >= ? AND date <= ?
    ORDER BY date ASC, start_ts ASC
  `);

  const sleepSessionByDateStmt = db.prepare<[string], SleepSessionRow>(`
    SELECT * FROM sleep_sessions WHERE date = ? ORDER BY start_ts DESC LIMIT 1
  `);

  const stagesForSessionStmt = db.prepare<[string], SleepStageRow>(`
    SELECT * FROM sleep_stages WHERE session_key = ? ORDER BY idx ASC
  `);

  const exercisesStmt = db.prepare<[string, string], ExerciseRow>(`
    SELECT * FROM exercises
    WHERE date >= ? AND date <= ?
    ORDER BY date ASC, start_ts ASC
  `);

  const nutritionStmt = db.prepare<[string, string], NutritionRow>(`
    SELECT * FROM nutrition_entries
    WHERE date >= ? AND date <= ?
    ORDER BY date ASC, ts ASC
  `);

  const hydrationStmt = db.prepare<[string, string], HydrationRow>(`
    SELECT * FROM hydration_entries
    WHERE date >= ? AND date <= ?
    ORDER BY date ASC, ts ASC
  `);

  const hrHourlyStmt = db.prepare<[string, string], HrHourlyRow>(`
    SELECT * FROM hr_hourly
    WHERE date >= ? AND date <= ?
    ORDER BY date ASC, hour_ts ASC
  `);

  const checkinsStmt = db.prepare<[string, string], CheckinRow>(`
    SELECT * FROM checkins
    WHERE date >= ? AND date <= ?
    ORDER BY date ASC, ts ASC
  `);

  const checkinByDateStmt = db.prepare<[string], CheckinRow>(`
    SELECT * FROM checkins WHERE date = ? ORDER BY ts DESC LIMIT 1
  `);

  const getWatermarkStmt = db.prepare<[string], SyncStateRow>(`
    SELECT * FROM sync_state WHERE data_type = ?
  `);

  const allWatermarksStmt = db.prepare<[], SyncStateRow>(`SELECT * FROM sync_state`);

  const coverageStmt = db.prepare<[], { min_date: string | null; max_date: string | null }>(`
    SELECT MIN(d) as min_date, MAX(d) as max_date FROM (
      SELECT date as d FROM observations
      UNION ALL
      SELECT date as d FROM sleep_sessions
    )
  `);

  // -- writeBatch ---------------------------------------------------------

  const writeBatchTx = db.transaction((batch: ParsedBatch): number => {
    let rows = 0;

    for (const o of batch.observations) {
      if (!Number.isFinite(o.value)) continue;
      upsertObservation.run({
        metric: o.metric,
        naturalKey: o.naturalKey,
        date: o.date,
        ts: o.ts,
        value: o.value,
        unit: o.unit,
        platform: o.platform,
        recordingMethod: o.recordingMethod,
      });
      rows++;
    }

    for (const s of batch.sleepSessions) {
      upsertSleepSession.run({
        naturalKey: s.naturalKey,
        date: s.date,
        startTs: s.startTs,
        endTs: s.endTs,
        type: s.type,
        totalMinutes: s.totalMinutes,
        asleepMinutes: s.asleepMinutes,
        awakeMinutes: s.awakeMinutes,
        deepMinutes: s.deepMinutes,
        remMinutes: s.remMinutes,
        lightMinutes: s.lightMinutes,
        efficiency: s.efficiency,
        platform: s.platform,
      });
      deleteStages.run(s.naturalKey);
      s.stages.forEach((stage, idx) => {
        insertStage.run({
          sessionKey: s.naturalKey,
          idx,
          type: stage.type,
          startTs: stage.startTs,
          endTs: stage.endTs,
          minutes: stage.minutes,
        });
      });
      rows++;
    }

    for (const e of batch.exercises) {
      upsertExercise.run({
        naturalKey: e.naturalKey,
        date: e.date,
        startTs: e.startTs,
        endTs: e.endTs,
        displayName: e.displayName,
        exerciseType: e.exerciseType,
        intensity: e.intensity,
        avgHeartRate: e.avgHeartRate,
        caloriesBurned: e.caloriesBurned,
        platform: e.platform,
      });
      rows++;
    }

    for (const n of batch.nutrition) {
      upsertNutrition.run({
        naturalKey: n.naturalKey,
        date: n.date,
        ts: n.ts,
        foodDisplayName: n.foodDisplayName,
        mealType: n.mealType,
        energyKcal: n.energyKcal,
        proteinG: n.proteinG,
        carbsG: n.carbsG,
        fatG: n.fatG,
      });
      rows++;
    }

    for (const h of batch.hydration) {
      if (!Number.isFinite(h.milliliters)) continue;
      upsertHydration.run({
        naturalKey: h.naturalKey,
        date: h.date,
        ts: h.ts,
        milliliters: h.milliliters,
      });
      rows++;
    }

    for (const hr of batch.heartRateHourly) {
      if (
        !Number.isFinite(hr.minBpm) ||
        !Number.isFinite(hr.maxBpm) ||
        !Number.isFinite(hr.avgBpm) ||
        !Number.isFinite(hr.sampleCount)
      ) {
        continue;
      }
      upsertHrHourly.run({
        naturalKey: hr.naturalKey,
        date: hr.date,
        hourTs: hr.hourTs,
        minBpm: hr.minBpm,
        maxBpm: hr.maxBpm,
        avgBpm: hr.avgBpm,
        sampleCount: hr.sampleCount,
      });
      rows++;
    }

    return rows;
  });

  // -- Store implementation -----------------------------------------------

  return {
    writeBatch(batch: ParsedBatch): number {
      return writeBatchTx(batch);
    },

    dailySeries(metric: MetricId, range: DateRange): DailyValue[] {
      return dailySeriesStmt.all(metric, range.from, range.to);
    },

    latest(metric: MetricId, onOrBefore?: string): DailyValue | null {
      const row =
        onOrBefore === undefined
          ? latestUnboundedStmt.get(metric)
          : latestBoundedStmt.get(metric, onOrBefore);
      return row ?? null;
    },

    observations(metric: MetricId, range: DateRange): Observation[] {
      return observationsStmt.all(metric, range.from, range.to).map(observationFromRow);
    },

    sleepSessions(range: DateRange): SleepSession[] {
      const rows = sleepSessionsStmt.all(range.from, range.to);
      return rows.map((r) => sleepSessionFromRow(r, stagesForSessionStmt.all(r.natural_key).map(stageFromRow)));
    },

    sleepSession(date: string): SleepSession | null {
      const r = sleepSessionByDateStmt.get(date);
      if (!r) return null;
      return sleepSessionFromRow(r, stagesForSessionStmt.all(r.natural_key).map(stageFromRow));
    },

    exercises(range: DateRange): ExerciseSession[] {
      return exercisesStmt.all(range.from, range.to).map(exerciseFromRow);
    },

    nutrition(range: DateRange): NutritionEntry[] {
      return nutritionStmt.all(range.from, range.to).map(nutritionFromRow);
    },

    hydration(range: DateRange): HydrationEntry[] {
      return hydrationStmt.all(range.from, range.to).map(hydrationFromRow);
    },

    heartRateHourly(range: DateRange): HeartRateHourly[] {
      return hrHourlyStmt.all(range.from, range.to).map(hrHourlyFromRow);
    },

    addCheckin(c: Omit<Checkin, 'id'>): Checkin {
      const info = insertCheckinStmt.run({
        date: c.date,
        ts: c.ts,
        mood: c.mood,
        note: c.note,
        tags: JSON.stringify(c.tags),
      });
      return { ...c, id: Number(info.lastInsertRowid) };
    },

    checkins(range: DateRange): Checkin[] {
      return checkinsStmt.all(range.from, range.to).map(checkinFromRow);
    },

    checkin(date: string): Checkin | null {
      const r = checkinByDateStmt.get(date);
      return r ? checkinFromRow(r) : null;
    },

    getWatermark(dataType: DataTypeId): SyncWatermark | null {
      const r = getWatermarkStmt.get(dataType);
      return r ? watermarkFromRow(r) : null;
    },

    setWatermark(w: SyncWatermark): void {
      upsertWatermarkStmt.run({
        dataType: w.dataType,
        newestTs: w.newestTs,
        lastSyncedAt: w.lastSyncedAt,
      });
    },

    allWatermarks(): SyncWatermark[] {
      return allWatermarksStmt.all().map(watermarkFromRow);
    },

    coverage(): DateRange | null {
      const r = coverageStmt.get();
      if (!r || r.min_date === null || r.max_date === null) return null;
      return { from: r.min_date, to: r.max_date };
    },

    close(): void {
      db.close();
    },
  };
}
