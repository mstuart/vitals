/**
 * `vitals week` — weekly health report.
 */

import { weeklyReport } from "../../report/weekly.js";
import type { Store } from "../../store/api.js";
import { today as todayDate } from "../../util/time.js";
import { formatJson } from "../format.js";

export interface WeekArgs {
  json?: boolean;
}

export function runWeek(
  store: Store,
  args: WeekArgs,
  asOf: string = todayDate()
): string {
  const report = weeklyReport(store, { asOf });
  if (args.json) {
    return formatJson({ asOf, report });
  }
  return report;
}
