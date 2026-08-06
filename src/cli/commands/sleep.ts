/**
 * `vitals sleep [--days 14]` — recent sleep sessions.
 */
import type { Store } from '../../store/api.js';
import { addDays, today as todayDate } from '../../util/time.js';
import { formatJson, formatSleepTable } from '../format.js';
import { parseDays } from './context.js';

export interface SleepArgs {
  days?: string;
  json?: boolean;
}

export function runSleep(store: Store, args: SleepArgs, now: string = todayDate()): string {
  const days = parseDays(args.days, 14);
  const from = addDays(now, -(days - 1));
  const sessions = store.sleepSessions({ from, to: now });
  if (args.json) return formatJson(sessions);
  return formatSleepTable(sessions);
}
