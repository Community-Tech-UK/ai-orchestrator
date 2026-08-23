import { availableParallelism, loadavg } from 'os';

/**
 * Worker fan-out for the Vitest fork pool.
 *
 * Both projects ran `singleFork: true` from 2026-01-20 to 2026-08-20. The
 * original reason was "avoid re-initializing TestBed for each file", which only
 * ever applied to the renderer project; the `main` project inherited it in the
 * multi-project split with a note to revisit. Running ~1.5k spec files back to
 * back in one process is what let heap grow until the run died at V8's ceiling
 * (see vitest.heap.ts), so the accumulation and the serial wall clock had the
 * same cause.
 *
 * Measured on this 18-core host, 2026-08-20:
 *   main      1467 files   serial ~550s   8 forks 153s
 *   renderer   288 files   serial   35s   8 forks  25s
 *
 * The cap is deliberate rather than "use every core". Vitest's own default is
 * `availableParallelism() - 1`, which on a dev box starves the app, the other
 * agent sessions, and any concurrent suite — and CPU starvation is not a
 * neutral slowdown for this suite: specs that shell out under a timeout (the
 * rtk probe specs were the first casualties) fail rather than merely run late.
 */

/** Upper bound on concurrent forks, regardless of how many cores the host has. */
const MAX_FORKS = 8;
/** Hard ceiling on an explicit AIO_TEST_MAX_FORKS override. */
const OVERRIDE_CEILING = 64;

/**
 * Concurrent fork count for the test pool.
 *
 * Scaled by what the host actually has spare, not by its core count. This
 * machine routinely runs several agent sessions, each free to start its own
 * full suite, plus the app itself: a fixed fan-out multiplies across them, and
 * a run started at load average 467 on 18 cores took 1907s and failed four
 * timing-sensitive specs that pass on a calm box. One core is left for the
 * orchestrator process, so an idle 4-core CI runner gets 2 and a saturated host
 * degrades to 1 — no worse than the `singleFork` behaviour this replaced.
 *
 * The load average is a one-minute mean read once, when the config loads, so it
 * lags a burst by design; it errs toward politeness rather than speed. Windows
 * has no load average — Node reports [0, 0, 0] there — which lands on the
 * plain `cores - 1` behaviour, capped, and is the right answer for a host this
 * process cannot measure.
 *
 * `AIO_TEST_MAX_FORKS` overrides the sizing for benchmarking or CI pinning. It
 * is clamped: a typo'd 800 in an env file should not fork-bomb the host.
 */
export function testMaxForks(
  parallelism: number = availableParallelism(),
  loadAverage: number = loadavg()[0],
): number {
  const override = Number(process.env['AIO_TEST_MAX_FORKS']);
  if (Number.isInteger(override) && override > 0) {
    return Math.min(override, OVERRIDE_CEILING);
  }
  const spareCores = Math.floor(parallelism - loadAverage) - 1;
  return Math.max(1, Math.min(MAX_FORKS, spareCores));
}
