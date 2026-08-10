// Records live Google Health API v4 responses into test/fixtures/private/.
//
// The output is REAL personal health data and is gitignored. It is never
// committed. Run `node scripts/make-fixtures.mjs` afterwards to derive the
// synthetic, publishable fixtures the test suite actually uses.
//
// Usage: node scripts/record-fixtures.mjs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TOKEN_FILE =
  process.env.VITALS_GOOGLE_TOKEN ??
  join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "vitals",
    "credentials.json"
  );
const OUT_DIR = join(import.meta.dirname, "..", "test", "fixtures", "private");

const DATA_TYPES = [
  "steps",
  "distance",
  "heart-rate",
  "heart-rate-variability",
  "daily-heart-rate-variability",
  "daily-resting-heart-rate",
  "daily-oxygen-saturation",
  "sleep",
  "daily-respiratory-rate",
  "respiratory-rate-sleep-summary",
  "daily-sleep-temperature-derivations",
  "weight",
  "body-fat",
  "exercise",
  "active-zone-minutes",
  "active-energy-burned",
  "nutrition-log",
  "hydration-log",
];

// Per-type page sizes. sleep/exercise are capped at 25 by the API.
const PAGE_SIZE = {
  exercise: 25,
  "heart-rate": 20,
  "heart-rate-variability": 20,
  sleep: 25,
};

async function accessToken() {
  const t = JSON.parse(readFileSync(TOKEN_FILE, "utf8"));
  const res = await fetch("https://oauth2.googleapis.com/token", {
    body: new URLSearchParams({
      client_id: t.client_id,
      client_secret: t.client_secret,
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
    }),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  if (!res.ok) {
    throw new Error(`token refresh failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()).access_token;
}

// The user id appears in every `name` field: users/<id>/dataTypes/...
function scrub(obj, userIdentifier) {
  const s = JSON.stringify(obj).replaceAll(userIdentifier, "FIXTURE_USER");
  return JSON.parse(s);
}

const token = await accessToken();
mkdirSync(OUT_DIR, { recursive: true });

let userId = null;
const summary = [];

for (const dt of DATA_TYPES) {
  const ps = PAGE_SIZE[dt] ?? 30;
  const url = `https://health.googleapis.com/v4/users/me/dataTypes/${dt}/dataPoints?pageSize=${ps}`;
  // biome-ignore lint/performance/noAwaitInLoops: Fixture recording intentionally fetches each data type sequentially.
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    summary.push(`${dt.padEnd(38)} HTTP ${res.status}`);
    continue;
  }
  const body = await res.json();
  const points = body.dataPoints ?? [];
  if (!userId && points[0]?.name) {
    const [firstPoint] = points;
    const { name } = firstPoint;
    const [, detectedUserId] = name.split("/");
    userId = detectedUserId;
  }
  const scrubbed = userId ? scrub(body, userId) : body;
  writeFileSync(
    join(OUT_DIR, `${dt}.json`),
    `${JSON.stringify(scrubbed, null, 2)}\n`
  );
  summary.push(
    `${dt.padEnd(38)} ${String(points.length).padStart(4)} points${body.nextPageToken ? "  +nextPageToken" : ""}`
  );
}

console.log(summary.join("\n"));
console.log(`\nscrubbed user id: ${userId ?? "(none seen)"}`);
console.log(`written to: ${OUT_DIR}`);
