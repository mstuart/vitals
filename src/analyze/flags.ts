/**
 * Threshold evaluation over MetricSnapshots, producing evidence-based Flags.
 *
 * Every threshold here traces to a published source (see the `basis` strings
 * below) so a flag never reads as an arbitrary number. Pure function of the
 * snapshots passed in — no Store access, no network.
 */
import type { Flag, FlagLevel, MetricSnapshot } from '../types.js';
import { METRICS } from '../types.js';
import { addDays } from '../util/time.js';

const RHR_BASIS =
  'Li et al. 2020 (Stanford): RHR +3bpm precedes symptom onset 24-48h, 80% sensitivity';
const HRV_BASIS = 'HRV4Training red-day protocol; WHOOP recovery model: >20% below baseline';
const SKIN_TEMP_BASIS = 'Oura illness prediction: >1.0C deviation, ~80% sensitivity 24-48h ahead';
const RESP_RATE_BASIS =
  'Visible Health: +2 breaths/min for 2 consecutive nights predicts flare 1-2 days out';

/** Skin temp baseline is meaningless before this many days of local history. */
const SKIN_TEMP_MIN_HISTORY_DAYS = 30;

function makeFlag(
  s: MetricSnapshot,
  level: FlagLevel,
  baselineMean: number,
  basis: string,
  message: string,
): Flag {
  return {
    metric: s.metric,
    level,
    message,
    // Guaranteed non-null by every call site (checked before invoking makeFlag).
    value: s.value as number,
    baselineMean,
    basis,
  };
}

function evaluateRhr(s: MetricSnapshot): Flag | null {
  const { value, baseline } = s;
  if (value === null || baseline === null) return null;
  const mean = baseline.mean;
  if (value > mean + 3) {
    return makeFlag(
      s,
      'red',
      mean,
      RHR_BASIS,
      `Resting heart rate ${value.toFixed(1)} bpm is ${(value - mean).toFixed(1)} bpm above the ${mean.toFixed(1)} bpm baseline (>3 bpm).`,
    );
  }
  if (value > mean + 2) {
    return makeFlag(
      s,
      'yellow',
      mean,
      RHR_BASIS,
      `Resting heart rate ${value.toFixed(1)} bpm is ${(value - mean).toFixed(1)} bpm above the ${mean.toFixed(1)} bpm baseline (>2 bpm).`,
    );
  }
  return null;
}

function evaluateHrv(s: MetricSnapshot): Flag | null {
  const { value, baseline } = s;
  if (value === null || baseline === null) return null;
  const mean = baseline.mean;
  if (value < mean * 0.8) {
    return makeFlag(
      s,
      'red',
      mean,
      HRV_BASIS,
      `HRV ${value.toFixed(1)} ms is more than 20% below the ${mean.toFixed(1)} ms baseline.`,
    );
  }
  if (value < mean * 0.9) {
    return makeFlag(
      s,
      'yellow',
      mean,
      HRV_BASIS,
      `HRV ${value.toFixed(1)} ms is more than 10% below the ${mean.toFixed(1)} ms baseline.`,
    );
  }
  return null;
}

function evaluateSkinTemp(s: MetricSnapshot): Flag | null {
  const { value, baseline } = s;
  if (value === null || baseline === null) return null;
  // Suppressed entirely until enough local history exists for the baseline
  // to be meaningful; the API returns NaN for it before then.
  if (baseline.n < SKIN_TEMP_MIN_HISTORY_DAYS) return null;
  const mean = baseline.mean;
  if (value > mean + 1.0) {
    return makeFlag(
      s,
      'red',
      mean,
      SKIN_TEMP_BASIS,
      `Nightly skin temperature ${value.toFixed(2)}C is ${(value - mean).toFixed(2)}C above the ${mean.toFixed(2)}C baseline (>1.0C).`,
    );
  }
  if (value > mean + 0.5) {
    return makeFlag(
      s,
      'yellow',
      mean,
      SKIN_TEMP_BASIS,
      `Nightly skin temperature ${value.toFixed(2)}C is ${(value - mean).toFixed(2)}C above the ${mean.toFixed(2)}C baseline (>0.5C).`,
    );
  }
  return null;
}

function isElevatedRespRate(s: MetricSnapshot): boolean {
  return s.value !== null && s.baseline !== null && s.value > s.baseline.mean + 2;
}

/**
 * Resp rate needs two consecutive elevated nights to go red; a single
 * elevated night is only yellow. `snaps` may contain the resp-rate snapshot
 * for the day being evaluated plus (optionally) the prior day's, in any
 * order. The "current" night is whichever has the latest date.
 */
function evaluateRespRate(snaps: MetricSnapshot[]): Flag | null {
  if (snaps.length === 0) return null;

  const sorted = [...snaps].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const current = sorted[0];
  if (!current || !isElevatedRespRate(current)) return null;

  const prevDate = addDays(current.date, -1);
  const prev = sorted.find((s) => s.date === prevDate);
  const prevElevated = prev !== undefined && isElevatedRespRate(prev);

  const mean = current.baseline?.mean as number; // isElevatedRespRate already checked non-null
  if (prevElevated) {
    return makeFlag(
      current,
      'red',
      mean,
      RESP_RATE_BASIS,
      `Respiratory rate elevated >2 breaths/min above baseline for 2 consecutive nights.`,
    );
  }
  return makeFlag(
    current,
    'yellow',
    mean,
    RESP_RATE_BASIS,
    `Respiratory rate elevated >2 breaths/min above baseline for 1 night.`,
  );
}

/**
 * Evaluates every snapshot against its published threshold. `snapshots` is a
 * flat bag: one snapshot per non-resp-rate metric for the day being judged,
 * plus (for resp rate specifically) that day's snapshot and optionally the
 * prior day's, so the consecutive-night rule can be applied.
 */
export function evaluateFlags(snapshots: MetricSnapshot[]): Flag[] {
  const flags: Flag[] = [];

  for (const s of snapshots) {
    if (s.metric === METRICS.respiratoryRate) continue;
    let flag: Flag | null = null;
    switch (s.metric) {
      case METRICS.restingHeartRate:
        flag = evaluateRhr(s);
        break;
      case METRICS.hrvDailyAvg:
        flag = evaluateHrv(s);
        break;
      case METRICS.skinTempNightly:
        flag = evaluateSkinTemp(s);
        break;
      default:
        flag = null;
    }
    if (flag) flags.push(flag);
  }

  const respFlag = evaluateRespRate(snapshots.filter((s) => s.metric === METRICS.respiratoryRate));
  if (respFlag) flags.push(respFlag);

  return flags;
}
