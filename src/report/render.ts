/**
 * Pure text-rendering primitives shared by report builders.
 *
 * No Store access, no I/O — every function here is a total function of its
 * arguments so it can be unit tested in isolation from `weekly.ts`.
 */
import type { TrendDirection } from '../types.js';

/** Column width the original Python report was designed for. */
export const REPORT_WIDTH = 72;

/** A horizontal rule of `ch` repeated `width` times, e.g. `rule(72, '=')`. */
export function rule(width: number, ch = '─'): string {
  if (width <= 0) return '';
  return ch.repeat(width);
}

/**
 * Center `text` within `width`, padding with spaces on both sides.
 * Mirrors Python's `str.center()`: text at or past `width` is returned as-is
 * rather than truncated.
 */
export function center(text: string, width: number): string {
  if (text.length >= width) return text;
  const totalPad = width - text.length;
  const left = Math.floor(totalPad / 2);
  const right = totalPad - left;
  return ' '.repeat(left) + text + ' '.repeat(right);
}

/**
 * A block-character bar proportional to `value` out of `max`, scaled to
 * `width` characters. Clamped to `width` when `value` exceeds `max`. Any
 * positive value renders at least one block so small-but-real values stay
 * visible. Non-finite or non-positive input renders as an empty string —
 * callers use that to distinguish "no data" from "zero" (see weekly.ts).
 */
export function bar(value: number, max: number, width: number): string {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0 || width <= 0) return '';
  if (value <= 0) return '';
  const ratio = Math.min(value / max, 1);
  const filled = Math.max(1, Math.round(ratio * width));
  return '█'.repeat(filled);
}

/** Trend arrow glyph. Null (no trend computable) renders as an empty string. */
export function arrow(direction: TrendDirection | null): string {
  switch (direction) {
    case 'rising':
      return '↑';
    case 'falling':
      return '↓';
    case 'flat':
      return '→';
    default:
      return '';
  }
}

/**
 * Fixed-point formatting for report values. Null and non-finite numbers
 * (including NaN, which must never reach the database — see toNumber())
 * render as an empty string rather than "NaN" or "null".
 */
export function fmt(n: number | null, digits = 0): string {
  if (n === null || !Number.isFinite(n)) return '';
  return n.toFixed(digits);
}
