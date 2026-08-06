/**
 * `vitals body [--days 30]` — weight and body fat over time.
 */
import type { Store } from '../../store/api.js';
import { METRICS } from '../../types.js';
import { addDays, today as todayDate } from '../../util/time.js';
import { formatBodyTable, formatJson, mergeBodySeries } from '../format.js';
import { parseDays } from './context.js';

export interface BodyArgs {
  days?: string;
  json?: boolean;
}

export function runBody(store: Store, args: BodyArgs, now: string = todayDate()): string {
  const days = parseDays(args.days, 30);
  const range = { from: addDays(now, -(days - 1)), to: now };
  const rows = mergeBodySeries(
    store.dailySeries(METRICS.weightKg, range),
    store.dailySeries(METRICS.bodyFatPct, range),
  );
  if (args.json) return formatJson(rows);
  return formatBodyTable(rows);
}
