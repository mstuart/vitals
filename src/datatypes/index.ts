/**
 * Registry of all 18 ingested data types.
 *
 * Each family module exports one `DataTypeSpec` per data type it owns. This
 * file is the only place that knows the full set; sync iterates it.
 */
import type { DataTypeId, DataTypeSpec } from "../types.js";
import { DATA_TYPE_IDS } from "../types.js";

import {
  dailyHeartRateVariabilitySpec,
  dailyOxygenSaturationSpec,
  dailyRespiratoryRateSpec,
  dailyRestingHeartRateSpec,
  dailySleepTemperatureDerivationsSpec,
  respiratoryRateSleepSummarySpec,
} from "./daily.js";
import {
  activeEnergyBurnedSpec,
  activeZoneMinutesSpec,
  distanceSpec,
  stepsSpec,
} from "./intervals.js";
import { hydrationLogSpec, nutritionLogSpec } from "./logs.js";
import {
  bodyFatSpec,
  heartRateSpec,
  heartRateVariabilitySpec,
  weightSpec,
} from "./samples.js";
import { exerciseSpec, sleepSpec } from "./sleep.js";

export const REGISTRY: Record<DataTypeId, DataTypeSpec> = {
  "active-energy-burned": activeEnergyBurnedSpec,
  "active-zone-minutes": activeZoneMinutesSpec,
  "body-fat": bodyFatSpec,
  "daily-heart-rate-variability": dailyHeartRateVariabilitySpec,
  "daily-oxygen-saturation": dailyOxygenSaturationSpec,
  "daily-respiratory-rate": dailyRespiratoryRateSpec,
  "daily-resting-heart-rate": dailyRestingHeartRateSpec,
  "daily-sleep-temperature-derivations": dailySleepTemperatureDerivationsSpec,
  distance: distanceSpec,
  exercise: exerciseSpec,
  "heart-rate": heartRateSpec,
  "heart-rate-variability": heartRateVariabilitySpec,
  "hydration-log": hydrationLogSpec,
  "nutrition-log": nutritionLogSpec,
  "respiratory-rate-sleep-summary": respiratoryRateSleepSummarySpec,
  sleep: sleepSpec,
  steps: stepsSpec,
  weight: weightSpec,
};

export function specFor(id: DataTypeId): DataTypeSpec {
  return REGISTRY[id];
}

export function allSpecs(): DataTypeSpec[] {
  return DATA_TYPE_IDS.map((id) => REGISTRY[id]);
}
