import { availableParallelism, cpus, loadavg } from 'os';

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
/** Sampling window for {@link sampleBusyCores}. */
const BUSY_SAMPLE_WINDOW_MS = 300;

/**
 * Cores currently busy, measured from `os.cpus()` tick deltas over a short
 * window, or `null` when the host cannot be measured.
 *
 * This replaces the one-minute load average as the primary signal. The load
 * average lags a burst by design, and the burst that matters here is the
 * previous full suite: a loop agent runs `npm run verify` inside its
 * iteration, the coordinator starts its own verify seconds later, and load1 is
 * still at 25–57 on 18 cores from the run that just finished. `floor(18 - 25) - 1`
 * sized that verify to a single fork, it completed 822 of 1977 files in its
 * 600s budget, and the loop derailed on a timeout that had nothing to do with
 * the tests (2026-09-05, `loop-1788631546543-593083f8`). A 300ms sample sees
 * the host as it is, and a suite that is genuinely running in parallel keeps
 * its cores pegged for the whole window, so it is still counted.
 *
 * The sleep is synchronous on purpose: Vitest reads this config once, before
 * any worker exists, and an async config would ripple through every project
 * entry for a value that takes a third of a second to obtain.
 */
export function sampleBusyCores(windowMs: number = BUSY_SAMPLE_WINDOW_MS): number | null {
  let before: ReturnType<typeof cpus>;
  let after: ReturnType<typeof cpus>;
  try {
    before = cpus();
    if (before.length === 0) return null;
    sleepSync(windowMs);
    after = cpus();
  } catch {
    // No SharedArrayBuffer / Atomics.wait (or no CPU info): fall back to the
    // load average rather than failing every test run at config load.
    return null;
  }
  if (after.length !== before.length) return null;
  let busyTicks = 0;
  let totalTicks = 0;
  for (let i = 0; i < before.length; i++) {
    const a = before[i].times;
    const b = after[i].times;
    const idle = b.idle - a.idle;
    const total = (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + (b.irq - a.irq) + idle;
    if (total <= 0) continue;
    totalTicks += total;
    busyTicks += total - idle;
  }
  if (totalTicks <= 0) return null;
  return (busyTicks / totalTicks) * before.length;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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
 * `busyCores` (see {@link sampleBusyCores}) is the primary occupancy signal;
 * `loadAverage` is the fallback when no sample is available. Windows has no
 * load average — Node reports [0, 0, 0] there — which lands on the plain
 * `cores - 1` behaviour, capped, and is the right answer for a host this
 * process cannot measure.
 *
 * `AIO_TEST_MAX_FORKS` overrides the sizing for benchmarking or CI pinning. It
 * is clamped: a typo'd 800 in an env file should not fork-bomb the host.
 */
export function testMaxForks(
  parallelism: number = availableParallelism(),
  loadAverage: number = loadavg()[0],
  busyCores: number | null = null,
): number {
  const override = Number(process.env['AIO_TEST_MAX_FORKS']);
  if (Number.isInteger(override) && override > 0) {
    return Math.min(override, OVERRIDE_CEILING);
  }
  const occupied = busyCores ?? loadAverage;
  const spareCores = Math.floor(parallelism - occupied) - 1;
  return Math.max(1, Math.min(MAX_FORKS, spareCores));
}

/** What `vitest.config.ts` calls: samples the host, then sizes the pool. */
export function resolveTestMaxForks(): number {
  return testMaxForks(availableParallelism(), loadavg()[0], sampleBusyCores());
}
