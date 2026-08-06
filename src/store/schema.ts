/**
 * SQL schema and forward-only migration runner for the vitals SQLite store.
 *
 * Migrations are numbered and tracked in `schema_version` (one row per
 * applied migration, the current version being MAX(version)). `migrate()`
 * is idempotent: calling it again against an already-migrated database is a
 * no-op because every statement uses `IF NOT EXISTS` and applied versions
 * are skipped.
 */
import type Database from 'better-sqlite3';

export interface Migration {
  version: number;
  statements: string[];
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS observations (
        metric TEXT NOT NULL,
        natural_key TEXT NOT NULL,
        date TEXT NOT NULL,
        ts TEXT,
        value REAL NOT NULL,
        unit TEXT NOT NULL,
        platform TEXT,
        recording_method TEXT,
        PRIMARY KEY (metric, natural_key)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_observations_date ON observations(date)`,
      `CREATE INDEX IF NOT EXISTS idx_observations_metric_date ON observations(metric, date)`,

      `CREATE TABLE IF NOT EXISTS sleep_sessions (
        natural_key TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        start_ts TEXT NOT NULL,
        end_ts TEXT NOT NULL,
        type TEXT,
        total_minutes REAL NOT NULL,
        asleep_minutes REAL NOT NULL,
        awake_minutes REAL NOT NULL,
        deep_minutes REAL NOT NULL,
        rem_minutes REAL NOT NULL,
        light_minutes REAL NOT NULL,
        efficiency REAL,
        platform TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_sleep_sessions_date ON sleep_sessions(date)`,

      `CREATE TABLE IF NOT EXISTS sleep_stages (
        session_key TEXT NOT NULL,
        idx INTEGER NOT NULL,
        type TEXT NOT NULL,
        start_ts TEXT NOT NULL,
        end_ts TEXT NOT NULL,
        minutes REAL NOT NULL,
        PRIMARY KEY (session_key, idx)
      )`,

      `CREATE TABLE IF NOT EXISTS exercises (
        natural_key TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        start_ts TEXT NOT NULL,
        end_ts TEXT,
        display_name TEXT,
        exercise_type TEXT,
        intensity TEXT,
        avg_heart_rate REAL,
        calories_burned REAL,
        platform TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_exercises_date ON exercises(date)`,

      `CREATE TABLE IF NOT EXISTS nutrition_entries (
        natural_key TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        ts TEXT NOT NULL,
        food_display_name TEXT,
        meal_type TEXT,
        energy_kcal REAL,
        protein_g REAL,
        carbs_g REAL,
        fat_g REAL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_nutrition_entries_date ON nutrition_entries(date)`,

      `CREATE TABLE IF NOT EXISTS hydration_entries (
        natural_key TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        ts TEXT NOT NULL,
        milliliters REAL NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_hydration_entries_date ON hydration_entries(date)`,

      `CREATE TABLE IF NOT EXISTS hr_hourly (
        natural_key TEXT PRIMARY KEY,
        date TEXT NOT NULL,
        hour_ts TEXT NOT NULL,
        min_bpm REAL NOT NULL,
        max_bpm REAL NOT NULL,
        avg_bpm REAL NOT NULL,
        sample_count INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_hr_hourly_date ON hr_hourly(date)`,

      `CREATE TABLE IF NOT EXISTS checkins (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        ts TEXT NOT NULL,
        mood INTEGER NOT NULL,
        note TEXT,
        tags TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_checkins_date ON checkins(date)`,

      `CREATE TABLE IF NOT EXISTS sync_state (
        data_type TEXT PRIMARY KEY,
        newest_ts TEXT,
        last_synced_at TEXT NOT NULL
      )`,
    ],
  },
];

/** Apply any migrations newer than the database's current schema_version. */
export function migrate(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`);
  const row = db.prepare(`SELECT MAX(version) as v FROM schema_version`).get() as
    | { v: number | null }
    | undefined;
  const current = row?.v ?? 0;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const applyMigration = db.transaction(() => {
      for (const statement of m.statements) {
        db.exec(statement);
      }
      db.prepare(`INSERT INTO schema_version (version) VALUES (?)`).run(m.version);
    });
    applyMigration();
  }
}
