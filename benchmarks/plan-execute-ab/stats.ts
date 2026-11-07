/**
 * Uncertainty ranges for the benchmark report (plan step 13: "per-arm results
 * with uncertainty ranges"). Rates are sampled over TASKS: the pilot runs one
 * run per task, the full run several, and repeat runs of one task are not
 * independent evidence. With one run per task every function below is the
 * textbook binomial form.
 */

import type { RateInterval } from './types';

/** Two-sided 95% normal quantile. */
const Z95 = 1.959963984540054;

/**
 * Wilson score interval for a proportion. `successes` may be fractional (a
 * task contributes its within-task solve fraction), which keeps the interval
 * centred on the reported rate and conservative under within-task correlation
 * (a 0..1 variable with mean p has variance at most p(1-p)). Unlike a normal
 * approximation it stays inside 0..1 and does not collapse to zero width at 0%
 * or 100%.
 */
export function wilsonInterval(successes: number, trials: number): RateInterval {
  if (trials <= 0) return { low: 0, high: 1 };
  const x = Math.min(Math.max(successes, 0), trials);
  const z2 = Z95 * Z95;
  const denominator = trials + z2;
  const centre = (x + z2 / 2) / denominator;
  const half = (Z95 / denominator) * Math.sqrt((x * (trials - x)) / trials + z2 / 4);
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
}

/**
 * Newcombe's interval for the difference of two independent proportions
 * (p1 − p2), built from each arm's Wilson interval. The benchmark's arms share
 * tasks, so a paired interval would be tighter when outcomes move together;
 * this independent form is the conservative side of that (a gap whose range
 * includes 0 is reported as noise).
 */
export function newcombeDifferenceInterval(
  p1: number,
  ci1: RateInterval,
  p2: number,
  ci2: RateInterval,
): RateInterval {
  const lower = (p1 - p2) - Math.sqrt((p1 - ci1.low) ** 2 + (ci2.high - p2) ** 2);
  const upper = (p1 - p2) + Math.sqrt((ci1.high - p1) ** 2 + (p2 - ci2.low) ** 2);
  return { low: lower, high: upper };
}
