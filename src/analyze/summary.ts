/**
 * Assembles the full daily picture: metric snapshots, sleep, checkin, flags.
 *
 * Pure orchestration over the Store interface — no direct SQLite, no network.
 */
import type { Store } from '../store/api.js';
import type { DailySummary } from '../types.js';
import { METRICS } from '../types.js';
import { addDays } from '../util/time.js';
import { snapshot } from './baseline.js';
import { evaluateFlags } from './flags.js';

/**
 * Rolling window used for every baseline in the summary. Also the number of
 * days of local history skin-temp flags require before they can fire (see
 * flags.ts) — keep these in sync.
 */
export const WINDOW_DAYS = 30;

/** A day is "multi-marker" when 2+ red flags agree — 80-90% sensitivity vs 60-70% for one. */
const MULTI_MARKER_MIN_RED_FLAGS = 2;

export function dailySummary(store: Store, date: string): DailySummary {
  const rhr = snapshot(store, METRICS.restingHeartRate, date, WINDOW_DAYS);
  const hrv = snapshot(store, METRICS.hrvDailyAvg, date, WINDOW_DAYS);
  const spo2 = snapshot(store, METRICS.spo2Avg, date, WINDOW_DAYS);
  const respRate = snapshot(store, METRICS.respiratoryRate, date, WINDOW_DAYS);
  const skinTemp = snapshot(store, METRICS.skinTempNightly, date, WINDOW_DAYS);

  // Resp-rate's consecutive-night rule needs the prior night alongside today's.
  const respRatePrev = snapshot(store, METRICS.respiratoryRate, addDays(date, -1), WINDOW_DAYS);

  const flags = evaluateFlags([rhr, hrv, skinTemp, respRate, respRatePrev]);
  const redCount = flags.filter((f) => f.level === 'red').length;
  const multiMarker = redCount >= MULTI_MARKER_MIN_RED_FLAGS;

  const sleep = store.sleepSession(date);
  const checkin = store.checkin(date);

  return { date, rhr, hrv, spo2, respRate, skinTemp, sleep, checkin, flags, multiMarker };
}
