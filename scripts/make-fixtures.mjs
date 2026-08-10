/**
 * Derive publishable test fixtures from a private recording.
 *
 * `record-fixtures.mjs` captures real API responses, which are real medical
 * records and must never be committed. This script keeps their STRUCTURE — key
 * names, nesting, and crucially the string-vs-number types the parsers have to
 * cope with — while replacing every measurement with a synthetic value, shifting
 * every timestamp onto a fixed synthetic timeline, and stripping device and
 * application identifiers.
 *
 * Edge cases the parsers depend on are preserved deliberately: a NaN temperature
 * baseline, a zero REM respiratory rate, empty exercise display names, the empty
 * trailing id on respiratory-rate-sleep-summary, and the absent `name` field on
 * daily aggregates.
 *
 * Deterministic: the same input always produces the same output, so fixtures
 * only change when this script does.
 *
 * Usage:
 *   node scripts/record-fixtures.mjs                 # private, gitignored
 *   node scripts/make-fixtures.mjs                   # publishable, committed
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const IN_DIR = join(import.meta.dirname, "..", "test", "fixtures", "private");
const OUT_DIR = join(import.meta.dirname, "..", "test", "fixtures", "api");

/** All synthetic timestamps land near this instant, not the recording date. */
const ANCHOR = Date.parse("2024-06-15T12:00:00Z");
/** Uniform offset for every fixture; not the recorder's real timezone. */
const UTC_OFFSET_SECONDS = -18_000;
const UTC_OFFSET = `${UTC_OFFSET_SECONDS}s`;

// Deterministic PRNG (mulberry32) — no Math.random, so output is reproducible.
function rng(seed) {
  // biome-ignore lint/suspicious/noBitwiseOperators: Mulberry32 requires 32-bit unsigned coercion.
  let a = seed >>> 0;
  return () => {
    // biome-ignore lint/suspicious/noBitwiseOperators: Mulberry32 requires 32-bit unsigned coercion.
    a = (a + 0x6d_2b_79_f5) >>> 0;
    // biome-ignore lint/suspicious/noBitwiseOperators: Mulberry32 requires bit mixing.
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    // biome-ignore lint/suspicious/noBitwiseOperators: Mulberry32 requires bit mixing.
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    // biome-ignore lint/suspicious/noBitwiseOperators: Mulberry32 requires bit mixing and unsigned coercion.
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Stable per-fixture seed so unrelated files don't shift when one changes. */
function seedFor(name) {
  let h = 2_166_136_261;
  for (const ch of name) {
    // biome-ignore lint/suspicious/noBitwiseOperators: FNV-1a hashing requires XOR mixing.
    h = Math.imul(h ^ ch.charCodeAt(0), 16_777_619);
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: FNV-1a returns an unsigned 32-bit seed.
  return h >>> 0;
}

const round = (n, d) => Number(n.toFixed(d));

/**
 * Synthetic value for a measurement, chosen by field name so each metric stays
 * physiologically plausible and unit tests asserting sane ranges keep passing.
 * Returns a string when the API returns a string for that field — the parsers
 * exist largely to handle exactly that.
 */
function synthesize(key, original, rand) {
  const wasString = typeof original === "string";
  const num = (lo, hi, digits = 0) => {
    const v = round(lo + rand() * (hi - lo), digits);
    return wasString ? String(v) : v;
  };

  switch (key) {
    case "beatsPerMinute":
    case "nonRemHeartRateBeatsPerMinute":
    case "averageHeartRateBeatsPerMinute":
      return num(56, 78);
    case "averageHeartRateVariabilityMilliseconds":
    case "rootMeanSquareOfSuccessiveDifferencesMilliseconds":
      return num(18, 46, 2);
    case "deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds":
      return num(12, 34, 1);
    case "entropy":
      return num(2, 3.2, 3);
    case "averagePercentage":
      return num(94, 99, 1);
    case "lowerBoundPercentage":
      return num(92, 94, 1);
    case "upperBoundPercentage":
      return num(99, 100, 1);
    case "breathsPerMinute":
      // 0 means "stage not detected" — parsers must skip it, so keep it 0.
      return original === 0 ? 0 : num(12, 18, 1);
    case "standardDeviation":
      return num(0.3, 1.4, 1);
    case "signalToNoise":
      return num(1, 8);
    case "nightlyTemperatureCelsius":
      return num(32, 35, 6);
    case "baselineTemperatureCelsius":
      // NaN for the first 7-30 days of history; the parser must drop it.
      return Number.isNaN(Number(original)) ? original : num(32, 35, 6);
    case "relativeNightlyStddev30dCelsius":
      return num(0.2, 1.2, 6);
    case "weightGrams":
      return num(58_000, 96_000);
    case "percentage":
      return num(12, 30, 1);
    case "count":
      return num(0, 180);
    case "millimeters":
      return num(0, 160_000);
    case "kcal":
      // A genuine 0 occurs when no active energy was burned in the interval;
      // the parser has to keep it rather than treat it as missing.
      return original === 0 || original === "0" ? original : num(0.1, 6, 3);
    case "activeZoneMinutes":
      return num(1, 3);
    case "milliliters":
      return num(200, 950);
    case "energy":
      return original === 0 ? 0 : num(40, 820);
    case "grams":
      return num(0, 55, 1);
    case "caloriesBurned":
      return num(40, 600);
    default:
      return typeof original === "number" ? num(1, 100, 2) : original;
  }
}

const FOODS = [
  "Oatmeal",
  "Black Coffee",
  "Turkey Sandwich",
  "Greek Yogurt",
  "Mixed Salad",
  "Grilled Chicken",
  "Brown Rice",
  "Banana",
  "Almonds",
  "Vegetable Soup",
];

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Rebuild a civilTime block from an instant and the synthetic offset. */
function civilFrom(instantMs) {
  const d = new Date(instantMs + UTC_OFFSET_SECONDS * 1000);
  return {
    date: {
      day: d.getUTCDate(),
      month: d.getUTCMonth() + 1,
      year: d.getUTCFullYear(),
    },
    time: { hours: d.getUTCHours(), minutes: d.getUTCMinutes() },
  };
}

/**
 * Walk a value, replacing measurements, timestamps and identifiers.
 * `shiftMs` maps the recording's timeline onto the synthetic one.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Recursive fixture sanitization intentionally handles every supported API shape in one traversal.
function transform(source, timelineShiftMs, rand, fieldKey = "") {
  if (Array.isArray(source)) {
    return source.map((v) => transform(v, timelineShiftMs, rand, fieldKey));
  }

  if (source && typeof source === "object") {
    const out = {};
    for (const [k, v] of Object.entries(source)) {
      if (k === "packageName") {
        out[k] = "com.example.health";
        continue;
      }
      if (k === "foodDisplayName") {
        // Preserve the empty-name case; otherwise use a generic food.
        out[k] = v === "" ? "" : FOODS[Math.floor(rand() * FOODS.length)];
        continue;
      }
      if (k === "name" && typeof v === "string") {
        out[k] = v; // already scrubbed to FIXTURE_USER; empty trailing id kept
        continue;
      }
      if (k.endsWith("UtcOffset") || k === "utcOffset") {
        out[k] = UTC_OFFSET;
        continue;
      }
      if (k === "startTime" || k === "endTime" || k === "physicalTime") {
        const ms = Date.parse(v);
        out[k] = Number.isFinite(ms)
          ? new Date(ms + timelineShiftMs).toISOString()
          : v;
        continue;
      }
      if (k === "date" && v && typeof v === "object" && "year" in v) {
        const ms =
          Date.parse(`${v.year}-${pad2(v.month)}-${pad2(v.day)}T00:00:00Z`) +
          timelineShiftMs;
        const d = new Date(ms);
        out[k] = {
          day: d.getUTCDate(),
          month: d.getUTCMonth() + 1,
          year: d.getUTCFullYear(),
        };
        continue;
      }
      out[k] = transform(v, timelineShiftMs, rand, k);
    }

    // Recompute civil times from the shifted instants so they stay consistent.
    if (out.physicalTime && out.civilTime) {
      out.civilTime = civilFrom(Date.parse(out.physicalTime));
    }
    if (out.startTime && out.civilStartTime) {
      out.civilStartTime = civilFrom(Date.parse(out.startTime));
    }
    if (out.endTime && out.civilEndTime) {
      out.civilEndTime = civilFrom(Date.parse(out.endTime));
    }
    return out;
  }

  if (
    typeof source === "number" ||
    (typeof source === "string" &&
      source !== "" &&
      Number.isFinite(Number(source)))
  ) {
    return synthesize(fieldKey, source, rand);
  }
  return source;
}

/** Newest instant in a document, used to anchor the whole set onto ANCHOR. */
function newestInstant(node, best = Number.NEGATIVE_INFINITY) {
  if (Array.isArray(node)) {
    return node.reduce((b, v) => newestInstant(v, b), best);
  }
  if (node && typeof node === "object") {
    let b = best;
    for (const [k, v] of Object.entries(node)) {
      if (
        (k === "startTime" || k === "endTime" || k === "physicalTime") &&
        typeof v === "string"
      ) {
        const ms = Date.parse(v);
        if (Number.isFinite(ms) && ms > b) {
          b = ms;
        }
      } else {
        b = newestInstant(v, b);
      }
    }
    return b;
  }
  return best;
}

if (!existsSync(IN_DIR)) {
  console.error(`No private recording at ${IN_DIR}.`);
  console.error(
    "Run `node scripts/record-fixtures.mjs` first (its output is gitignored)."
  );
  process.exit(1);
}

mkdirSync(OUT_DIR, { recursive: true });
const files = readdirSync(IN_DIR)
  .filter((f) => f.endsWith(".json"))
  .sort();

// One shift for the whole set so cross-fixture date relationships stay coherent.
let newest = Number.NEGATIVE_INFINITY;
for (const f of files) {
  newest = newestInstant(
    JSON.parse(readFileSync(join(IN_DIR, f), "utf8")),
    newest
  );
}
const shiftMs = ANCHOR - newest;

for (const f of files) {
  const doc = JSON.parse(readFileSync(join(IN_DIR, f), "utf8"));
  const out = transform(doc, shiftMs, rng(seedFor(f)));
  writeFileSync(join(OUT_DIR, f), `${JSON.stringify(out, null, 2)}\n`);
  console.log(
    `${f.replace(".json", "").padEnd(38)} ${(out.dataPoints ?? []).length} points`
  );
}
console.log(`\nSynthetic fixtures written to ${OUT_DIR}`);
console.log(
  `Timeline shifted by ${Math.round(shiftMs / 86_400_000)} days; offset forced to ${UTC_OFFSET}.`
);
