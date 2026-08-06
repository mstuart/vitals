import type { ApiDate, ApiInterval, ApiSampleTime } from '../types.js';
import { VitalsError } from '../types.js';

/**
 * Coerce an API numeric field to a number.
 *
 * The Health API returns numbers as strings in many places
 * (`beatsPerMinute: "71"`, `kcal: "0.695"`, `activeZoneMinutes: "1"`) and as
 * bare numbers in others (`averageHeartRateVariabilityMilliseconds: 20.45`).
 * Every parser must go through this rather than trusting the declared shape.
 *
 * Returns null for null/undefined/empty/NaN so callers can skip the record
 * instead of persisting NaN. `baselineTemperatureCelsius` is genuinely NaN for
 * the first 7-30 days of history, and that must not reach the database.
 */
export function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Parse a protobuf-style duration offset like `"-25200s"` into seconds. */
export function parseUtcOffsetSeconds(offset: string | undefined | null): number {
  if (!offset) return 0;
  const m = /^(-?\d+(?:\.\d+)?)s$/.exec(offset.trim());
  if (!m || m[1] === undefined) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `{year:2026,month:8,day:5}` -> `"2026-08-05"`. */
export function apiDateToIso(d: ApiDate | undefined | null): string | null {
  if (!d || !Number.isFinite(d.year) || !Number.isFinite(d.month) || !Number.isFinite(d.day)) {
    return null;
  }
  return `${d.year}-${pad2(d.month)}-${pad2(d.day)}`;
}

/**
 * The local calendar day an instant belongs to, given its own UTC offset.
 *
 * Uses the offset carried by the data point rather than the machine's timezone,
 * so a sync run from a different timezone bucket days identically.
 */
export function localDate(isoInstant: string, utcOffsetSeconds: number): string | null {
  const ms = Date.parse(isoInstant);
  if (!Number.isFinite(ms)) return null;
  const shifted = new Date(ms + utcOffsetSeconds * 1000);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}

/** Local day for a sample time, preferring its civilTime when present. */
export function localDateOfSample(s: ApiSampleTime | undefined | null): string | null {
  if (!s) return null;
  const civil = apiDateToIso(s.civilTime?.date);
  if (civil) return civil;
  if (!s.physicalTime) return null;
  return localDate(s.physicalTime, parseUtcOffsetSeconds(s.utcOffset));
}

/** Local day an interval STARTS on. */
export function localDateOfIntervalStart(i: ApiInterval | undefined | null): string | null {
  if (!i) return null;
  const civil = apiDateToIso(i.civilStartTime?.date);
  if (civil) return civil;
  if (!i.startTime) return null;
  return localDate(i.startTime, parseUtcOffsetSeconds(i.startUtcOffset));
}

/**
 * Local day an interval ENDS on.
 *
 * Sleep is attributed to the day you wake, not the day you lay down, so a
 * session running 23:40 Monday to 07:10 Tuesday belongs to Tuesday.
 */
export function localDateOfIntervalEnd(i: ApiInterval | undefined | null): string | null {
  if (!i) return null;
  const civil = apiDateToIso(i.civilEndTime?.date);
  if (civil) return civil;
  const end = i.endTime ?? i.startTime;
  if (!end) return null;
  return localDate(end, parseUtcOffsetSeconds(i.endUtcOffset ?? i.startUtcOffset));
}

/** Whole minutes between two ISO instants. Returns 0 when unparseable. */
export function minutesBetween(startIso: string, endIso: string): number {
  const a = Date.parse(startIso);
  const b = Date.parse(endIso);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return 0;
  return (b - a) / 60000;
}

/** Truncate an ISO instant to the top of its hour, e.g. `2026-08-05T13:00:00.000Z`. */
export function truncateToHour(isoInstant: string): string | null {
  const ms = Date.parse(isoInstant);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  d.setUTCMinutes(0, 0, 0);
  return d.toISOString();
}

/** Normalize an instant to canonical ISO 8601 UTC. */
export function toIsoUtc(instant: string): string | null {
  const ms = Date.parse(instant);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Add days to a `YYYY-MM-DD` string. */
export function addDays(isoDate: string, days: number): string {
  const ms = Date.parse(`${isoDate}T00:00:00Z`);
  const d = new Date(ms + days * 86400000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Today's local calendar day, from the machine's timezone. */
export function today(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/**
 * Parse a duration flag into an absolute start Date.
 *
 * Accepts `<int><d|w|m>` or an ISO date (`2026-06-01`).
 * Throws VitalsError('USAGE') on anything else.
 */
export function parseSince(input: string, now: Date = new Date()): Date {
  const s = input.trim();

  const rel = /^(\d+)([dwm])$/.exec(s);
  if (rel && rel[1] !== undefined && rel[2] !== undefined) {
    const n = Number(rel[1]);
    const days = rel[2] === 'd' ? n : rel[2] === 'w' ? n * 7 : n * 30;
    return new Date(now.getTime() - days * 86400000);
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const ms = Date.parse(`${s}T00:00:00Z`);
    if (Number.isFinite(ms)) return new Date(ms);
  }

  throw new VitalsError('USAGE', `Cannot parse duration "${input}".`, {
    hint: 'Use <number><d|w|m> (e.g. 30d, 4w, 6m) or an ISO date (2026-06-01).',
  });
}
