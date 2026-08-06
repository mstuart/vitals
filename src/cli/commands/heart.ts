/**
 * `vitals heart [--days 14]` — resting heart rate and HRV over time.
 */
import type { Store } from '../../store/api.js';
import { METRICS } from '../../types.js';
import { addDays, today as todayDate } from '../../util/time.js';
import { formatHeartTable, formatJson, mergeDailySeries } from '../format.js';
import { parseDays } from './context.js';

export interface HeartArgs {
  days?: string;
  json?: boolean;
}

export function runHeart(store: Store, args: HeartArgs, now: string = todayDate()): string {
  const days = parseDays(args.days, 14);
  const range = { from: addDays(now, -(days - 1)), to: now };
  const rows = mergeDailySeries(
    store.dailySeries(METRICS.restingHeartRate, range),
    store.dailySeries(METRICS.hrvDailyAvg, range),
  );
  if (args.json) return formatJson(rows);
  return formatHeartTable(rows);
}
