/**
 * `vitals pull [--since 30d] [--full]` — sync from the Health API into the Store.
 */

import { createClient } from "../../api/client.js";
import { getAccessToken } from "../../auth/token.js";
import { resolvePaths } from "../../config/paths.js";
import type { Store } from "../../store/api.js";
import { syncAll } from "../../sync/index.js";
import { parseSince } from "../../util/time.js";
import { formatPullResults } from "../format.js";

export interface PullArgs {
  full?: boolean;
  since?: string;
}

export interface PullOutcome {
  /**
   * 0 when at least one data type synced. 2 when every one failed — a total
   * failure (bad credentials, no network) must not look like success to cron,
   * even though sync deliberately tolerates individual types failing.
   */
  exitCode: number;
  output: string;
}

export async function runPull(
  store: Store,
  args: PullArgs,
  now: Date = new Date()
): Promise<PullOutcome> {
  const paths = resolvePaths();
  const client = createClient({ getToken: () => getAccessToken(paths) });
  const since = args.since ? parseSince(args.since, now) : undefined;
  const results = await syncAll(store, client, {
    full: args.full ?? false,
    since,
  });

  const failed = results.filter((r) => r.error).length;
  const total = results.length;
  const allFailed = total > 0 && failed === total;

  const output = allFailed
    ? `${formatPullResults(results)}\n\nAll ${total} data types failed. Run \`vitals auth\` if your credentials have expired.`
    : formatPullResults(results);

  return { exitCode: allFailed ? 2 : 0, output };
}
