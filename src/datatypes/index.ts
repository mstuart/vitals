/**
 * Registry of all 18 ingested data types.
 *
 * Each family module exports one `DataTypeSpec` per data type it owns. This
 * file is the only place that knows the full set; sync iterates it.
 */
import type { DataTypeId, DataTypeSpec } from '../types.js';
import { DATA_TYPE_IDS } from '../types.js';

import {
  dailyHeartRateVariabilitySpec,
  dailyRestingHeartRateSpec,
  dailyOxygenSaturationSpec,
  dailyRespiratoryRateSpec,
  dailySleepTemperatureDerivationsSpec,
  respiratoryRateSleepSummarySpec,
} from './daily.js';
import { sleepSpec, exerciseSpec } from './sleep.js';
import {
  heartRateSpec,
  heartRateVariabilitySpec,
  weightSpec,
  bodyFatSpec,
} from './samples.js';
import {
  stepsSpec,
  distanceSpec,
  activeZoneMinutesSpec,
  activeEnergyBurnedSpec,
} from './intervals.js';
import { nutritionLogSpec, hydrationLogSpec } from './logs.js';

export const REGISTRY: Record<DataTypeId, DataTypeSpec> = {
  'steps': stepsSpec,
  'distance': distanceSpec,
  'heart-rate': heartRateSpec,
  'heart-rate-variability': heartRateVariabilitySpec,
  'daily-heart-rate-variability': dailyHeartRateVariabilitySpec,
  'daily-resting-heart-rate': dailyRestingHeartRateSpec,
  'daily-oxygen-saturation': dailyOxygenSaturationSpec,
  'sleep': sleepSpec,
  'daily-respiratory-rate': dailyRespiratoryRateSpec,
  'respiratory-rate-sleep-summary': respiratoryRateSleepSummarySpec,
  'daily-sleep-temperature-derivations': dailySleepTemperatureDerivationsSpec,
  'weight': weightSpec,
  'body-fat': bodyFatSpec,
  'exercise': exerciseSpec,
  'active-zone-minutes': activeZoneMinutesSpec,
  'active-energy-burned': activeEnergyBurnedSpec,
  'nutrition-log': nutritionLogSpec,
  'hydration-log': hydrationLogSpec,
};

export function specFor(id: DataTypeId): DataTypeSpec {
  return REGISTRY[id];
}

export function allSpecs(): DataTypeSpec[] {
  return DATA_TYPE_IDS.map((id) => REGISTRY[id]);
}
