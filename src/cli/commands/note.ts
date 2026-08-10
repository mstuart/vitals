/**
 * `vitals note --mood <1-10> [--tag <t>...] [text...]` — a subjective check-in.
 */

import type { Store } from "../../store/api.js";
import type { Checkin } from "../../types.js";
import { VitalsError } from "../../types.js";
import { today as todayDate } from "../../util/time.js";

export interface NoteArgs {
  mood: string;
  tag: string[];
  text: string[];
}

/** Validates and parses the `--mood` flag. Throws VitalsError('USAGE') outside 1..10. */
export function parseMood(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 10) {
    throw new VitalsError("USAGE", `Invalid --mood value "${raw}".`, {
      hint: "Mood must be an integer from 1 to 10.",
    });
  }
  return n;
}

export function buildCheckin(
  args: NoteArgs,
  now: Date = new Date()
): Omit<Checkin, "id"> {
  const mood = parseMood(args.mood);
  const text = args.text.join(" ").trim();
  return {
    date: todayDate(now),
    mood,
    note: text.length > 0 ? text : null,
    tags: args.tag,
    ts: now.toISOString(),
  };
}

export function runNote(
  store: Store,
  args: NoteArgs,
  now: Date = new Date()
): Checkin {
  return store.addCheckin(buildCheckin(args, now));
}
