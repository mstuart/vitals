import { homedir } from "node:os";
import { join } from "node:path";
import type { Paths } from "../types.js";

/**
 * Filesystem locations, honouring XDG and per-path environment overrides.
 *
 * Credentials normally live in vitals' own data directory, written by
 * `vitals auth`. `VITALS_GOOGLE_TOKEN` optionally points at a credential file
 * belonging to another tool so an existing refresh token can be reused; vitals
 * reads that file but never writes to it, because the owning tool may refresh
 * the same credential concurrently and a competing write could corrupt it.
 */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const dataDir =
    env.VITALS_DATA_DIR ??
    join(env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "vitals");

  return {
    credentialsFile: join(dataDir, "credentials.json"),
    dataDir,
    dbFile: env.VITALS_DB ?? join(dataDir, "vitals.db"),
    externalCredentialsFile: env.VITALS_GOOGLE_TOKEN ?? null,
    tokenCacheFile: join(dataDir, "token.json"),
  };
}

export const API_BASE = "https://health.googleapis.com/v4/users/me";
export const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";

/** Read-only scopes vitals requests. Every one maps to a command's data. */
export const SCOPES = [
  "https://www.googleapis.com/auth/googlehealth.activity_and_fitness.readonly",
  "https://www.googleapis.com/auth/googlehealth.health_metrics_and_measurements.readonly",
  "https://www.googleapis.com/auth/googlehealth.sleep.readonly",
  "https://www.googleapis.com/auth/googlehealth.profile.readonly",
  "https://www.googleapis.com/auth/googlehealth.settings.readonly",
  "https://www.googleapis.com/auth/googlehealth.location.readonly",
  "https://www.googleapis.com/auth/googlehealth.nutrition.readonly",
];
