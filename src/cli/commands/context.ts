/**
 * Wiring shared by every command: opening the default Store and validating
 * the small set of flags more than one command accepts.
 */
import { resolvePaths } from '../../config/paths.js';
import { openStore } from '../../store/sqlite.js';
import type { Store } from '../../store/api.js';
import { VitalsError } from '../../types.js';

/** Opens the Store at the resolved default location (honouring VITALS_DB / XDG). */
export function openDefaultStore(): Store {
  const paths = resolvePaths();
  return openStore(paths.dbFile);
}

/** Parses a `--days` flag as a positive integer. Throws VitalsError('USAGE') otherwise. */
export function parseDays(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new VitalsError('USAGE', `Invalid --days value "${raw}".`, {
      hint: 'Provide a positive integer number of days.',
    });
  }
  return n;
}
