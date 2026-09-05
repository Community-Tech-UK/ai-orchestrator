import * as v8 from 'node:v8';

/**
 * Periodic resource telemetry for the worker agent.
 *
 * Context (2026-09-04 investigation): the Windows worker went silent at
 * 2026-09-03T11:45:04Z mid-`ProjectDiscovery` line and stayed dead for 23
 * hours. No shutdown log, no `uncaughtException` log, no Windows crash record —
 * so no JavaScript ran after the last line. That rules out a JS-level crash but
 * leaves "hard-killed" and "V8 fatal OOM" indistinguishable, because nothing
 * recorded the worker's resource trend on the way down.
 *
 * This module writes a compact vitals line on a slow cadence so the LAST line
 * before any future silent death answers the question directly: a heap sitting
 * at 95%+ of its limit means OOM, a flat heap means something killed us from
 * outside.
 *
 * Deliberately dependency-light (no `electron`, no logger import) so it is safe
 * in the worker process — see the "Worker electron import isolation" note. The
 * clock, sampler and sink are injectable so the interval logic is unit-testable
 * without real timers or a real process.
 */

const MB = 1024 * 1024;

/** Default cadence. Slow enough to stay readable across a log rotation. */
export const DEFAULT_VITALS_INTERVAL_MS = 60_000;

/**
 * Heap pressure (fraction of the V8 heap limit in use) at or above which the
 * line is emitted at warn instead of info, so it survives a casual scan of the
 * log and stands out next to a silent death.
 */
export const HEAP_PRESSURE_WARN_RATIO = 0.85;

export interface RuntimeVitals {
  /** Seconds since process start. */
  uptimeSec: number;
  rssMb: number;
  heapUsedMb: number;
  heapTotalMb: number;
  /** V8's hard ceiling; exceeding it aborts the process with a fatal OOM. */
  heapLimitMb: number;
  /** heapUsed / heapLimit, 0..1, rounded to 3dp. */
  heapPressure: number;
  externalMb: number;
  arrayBuffersMb: number;
}

export interface RuntimeVitalsSampler {
  memoryUsage: () => NodeJS.MemoryUsage;
  uptime: () => number;
  heapSizeLimit: () => number;
}

export interface RuntimeVitalsOptions {
  intervalMs?: number;
  sampler?: RuntimeVitalsSampler;
  /** Receives each sample. Defaults to `console.info`/`console.warn`. */
  emit?: (level: 'info' | 'warn', vitals: RuntimeVitals) => void;
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
  warnRatio?: number;
}

function defaultSampler(): RuntimeVitalsSampler {
  return {
    memoryUsage: () => process.memoryUsage(),
    uptime: () => process.uptime(),
    heapSizeLimit: () => v8.getHeapStatistics().heap_size_limit,
  };
}

const round = (value: number, dp = 1): number => {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
};

/** Take a single vitals reading. Pure apart from the injected sampler. */
export function captureRuntimeVitals(sampler: RuntimeVitalsSampler = defaultSampler()): RuntimeVitals {
  const mem = sampler.memoryUsage();
  const heapLimit = sampler.heapSizeLimit();
  return {
    uptimeSec: Math.round(sampler.uptime()),
    rssMb: round(mem.rss / MB),
    heapUsedMb: round(mem.heapUsed / MB),
    heapTotalMb: round(mem.heapTotal / MB),
    heapLimitMb: round(heapLimit / MB),
    // A zero/absent limit must not produce NaN or Infinity in the log line.
    heapPressure: heapLimit > 0 ? round(mem.heapUsed / heapLimit, 3) : 0,
    externalMb: round(mem.external / MB),
    arrayBuffersMb: round(mem.arrayBuffers / MB),
  };
}

/** Render a vitals sample as one grep-friendly log line. */
export function formatRuntimeVitals(vitals: RuntimeVitals): string {
  return `[WorkerVitals] ${JSON.stringify(vitals)}`;
}

/**
 * Start emitting vitals on an interval. Returns a stop function. The timer is
 * `unref`ed where supported so it never holds the process open on shutdown.
 */
export function startRuntimeVitalsLogging(options: RuntimeVitalsOptions = {}): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_VITALS_INTERVAL_MS;
  const sampler = options.sampler ?? defaultSampler();
  const warnRatio = options.warnRatio ?? HEAP_PRESSURE_WARN_RATIO;
  const setIntervalFn = options.setInterval ?? setInterval;
  const clearIntervalFn = options.clearInterval ?? clearInterval;
  const emit =
    options.emit ??
    ((level: 'info' | 'warn', vitals: RuntimeVitals): void => {
      const line = formatRuntimeVitals(vitals);
      if (level === 'warn') {
        console.warn(line);
      } else {
        console.info(line);
      }
    });

  const tick = (): void => {
    try {
      const vitals = captureRuntimeVitals(sampler);
      emit(vitals.heapPressure >= warnRatio ? 'warn' : 'info', vitals);
    } catch {
      // Telemetry must never take the worker down.
    }
  };

  // Emit immediately so a worker that dies inside its first interval still
  // leaves one baseline reading behind.
  tick();

  const handle = setIntervalFn(tick, intervalMs);
  (handle as { unref?: () => void }).unref?.();

  let stopped = false;
  return (): void => {
    if (stopped) return;
    stopped = true;
    clearIntervalFn(handle);
  };
}
