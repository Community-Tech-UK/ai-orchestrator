import { describe, expect, it, vi } from 'vitest';
import {
  captureRuntimeVitals,
  formatRuntimeVitals,
  HEAP_PRESSURE_WARN_RATIO,
  startRuntimeVitalsLogging,
  type RuntimeVitals,
  type RuntimeVitalsSampler,
} from './worker-runtime-vitals';

const MB = 1024 * 1024;

function sampler(overrides: {
  heapUsedMb?: number;
  heapLimitMb?: number;
  rssMb?: number;
  uptimeSec?: number;
} = {}): RuntimeVitalsSampler {
  const heapUsed = (overrides.heapUsedMb ?? 100) * MB;
  const heapLimit = (overrides.heapLimitMb ?? 4096) * MB;
  return {
    memoryUsage: () =>
      ({
        rss: (overrides.rssMb ?? 300) * MB,
        heapUsed,
        heapTotal: heapUsed * 1.2,
        external: 5 * MB,
        arrayBuffers: 2 * MB,
      }) as NodeJS.MemoryUsage,
    uptime: () => overrides.uptimeSec ?? 3600,
    heapSizeLimit: () => heapLimit,
  };
}

describe('captureRuntimeVitals', () => {
  it('reports heap pressure as a fraction of the V8 heap limit', () => {
    const vitals = captureRuntimeVitals(sampler({ heapUsedMb: 2048, heapLimitMb: 4096 }));

    expect(vitals.heapUsedMb).toBe(2048);
    expect(vitals.heapLimitMb).toBe(4096);
    expect(vitals.heapPressure).toBe(0.5);
  });

  it('converts byte counts to megabytes and rounds uptime', () => {
    const vitals = captureRuntimeVitals(sampler({ rssMb: 512, uptimeSec: 90.7 }));

    expect(vitals.rssMb).toBe(512);
    expect(vitals.uptimeSec).toBe(91);
  });

  it('never emits NaN or Infinity when the heap limit is unavailable', () => {
    const broken: RuntimeVitalsSampler = { ...sampler(), heapSizeLimit: () => 0 };

    const vitals = captureRuntimeVitals(broken);

    expect(vitals.heapPressure).toBe(0);
    expect(Number.isFinite(vitals.heapPressure)).toBe(true);
  });
});

describe('formatRuntimeVitals', () => {
  it('produces a single greppable line tagged for post-mortem search', () => {
    const line = formatRuntimeVitals(captureRuntimeVitals(sampler()));

    expect(line.startsWith('[WorkerVitals] ')).toBe(true);
    expect(line).not.toContain('\n');
    expect(() => JSON.parse(line.slice('[WorkerVitals] '.length)) as RuntimeVitals).not.toThrow();
  });
});

describe('startRuntimeVitalsLogging', () => {
  it('emits one baseline sample immediately so a fast death still leaves a reading', () => {
    const emit = vi.fn();

    startRuntimeVitalsLogging({
      sampler: sampler(),
      emit,
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => undefined,
    });

    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('escalates to warn once heap pressure reaches the threshold', () => {
    const emit = vi.fn();

    startRuntimeVitalsLogging({
      sampler: sampler({ heapUsedMb: 3900, heapLimitMb: 4096 }),
      emit,
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => undefined,
    });

    const [level, vitals] = emit.mock.calls[0] as ['info' | 'warn', RuntimeVitals];
    expect(vitals.heapPressure).toBeGreaterThanOrEqual(HEAP_PRESSURE_WARN_RATIO);
    expect(level).toBe('warn');
  });

  it('stays at info while the heap is healthy', () => {
    const emit = vi.fn();

    startRuntimeVitalsLogging({
      sampler: sampler({ heapUsedMb: 100, heapLimitMb: 4096 }),
      emit,
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
      clearInterval: () => undefined,
    });

    expect(emit.mock.calls[0]?.[0]).toBe('info');
  });

  it('re-samples on each interval tick', () => {
    const emit = vi.fn();
    const ticks: Array<() => void> = [];

    startRuntimeVitalsLogging({
      sampler: sampler(),
      emit,
      setInterval: (fn) => {
        ticks.push(fn);
        return 1 as unknown as ReturnType<typeof setInterval>;
      },
      clearInterval: () => undefined,
    });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(ticks).toHaveLength(1);
    ticks[0]();
    ticks[0]();
    expect(emit).toHaveBeenCalledTimes(3);
  });

  it('stops the timer exactly once, however many times stop is called', () => {
    const clear = vi.fn();
    const stop = startRuntimeVitalsLogging({
      sampler: sampler(),
      emit: vi.fn(),
      setInterval: () => 7 as unknown as ReturnType<typeof setInterval>,
      clearInterval: clear,
    });

    stop();
    stop();

    expect(clear).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith(7);
  });

  it('never lets a sampler failure propagate into the worker', () => {
    const exploding: RuntimeVitalsSampler = {
      memoryUsage: () => {
        throw new Error('sampler exploded');
      },
      uptime: () => 0,
      heapSizeLimit: () => 0,
    };

    expect(() =>
      startRuntimeVitalsLogging({
        sampler: exploding,
        emit: vi.fn(),
        setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
        clearInterval: () => undefined,
      }),
    ).not.toThrow();
  });
});
