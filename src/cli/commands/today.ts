/**
 * `vitals` / `vitals --quiet` — today vs baseline, the daily driver.
 */

import { dailySummary } from "../../analyze/summary.js";
import type { Store } from "../../store/api.js";
import { today as todayDate } from "../../util/time.js";
import type { RenderResult } from "../format.js";
import { renderToday } from "../format.js";

export interface TodayArgs {
  json?: boolean;
  quiet?: boolean;
}

export function runToday(
  store: Store,
  args: TodayArgs,
  date: string = todayDate()
): RenderResult {
  const summary = dailySummary(store, date);
  return renderToday(summary, args);
}
