import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkerHostHealthSample } from '../shared/types/worker-node.types';
import {
  _resetHostHealthSamplerForTesting,
  getLatestHostHealthSample,
  isHostHealthAbnormal,
  parseHostHealthOutput,
  startHostHealthSampling,
} from './host-health-sampler';

const T = 1_791_400_000_000;

// Shape produced by the PowerShell script on windows-pc (values from 2026-10-08).
const HEALTHY_OUTPUT = JSON.stringify({
  udp: 85,
  tcp: 283,
  topUdp: [{ name: 'svchost', pid: 12184, count: 20 }, { name: 'mDNSResponder', pid: 6488, count: 7 }],
  topHandles: [{ name: 'mtkbtsvc', pid: 6712, count: 127519 }, { name: 'UA Connect', pid: 31656, count: 11844 }],
});

afterEach(() => {
  _resetHostHealthSamplerForTesting();
  vi.useRealTimers();
});

describe('parseHostHealthOutput', () => {
  it('reads the sampling script output', () => {
    expect(parseHostHealthOutput(`${HEALTHY_OUTPUT}\r\n`, T)).toEqual({
      sampledAt: T,
      udpEndpoints: 85,
      tcpConnections: 283,
      topUdpOwners: [{ name: 'svchost', pid: 12184, count: 20 }, { name: 'mDNSResponder', pid: 6488, count: 7 }],
      topHandleHolders: [{ name: 'mtkbtsvc', pid: 6712, count: 127519 }, { name: 'UA Connect', pid: 31656, count: 11844 }],
    });
  });

  it('accepts the lone object ConvertTo-Json emits for a single entry, and names unnamed processes', () => {
    const sample = parseHostHealthOutput(JSON.stringify({
      udp: 3, tcp: 4, topUdp: { name: '', pid: 4, count: 3 }, topHandles: [],
    }), T);

    expect(sample?.topUdpOwners).toEqual([{ name: 'pid 4', pid: 4, count: 3 }]);
    expect(sample?.topHandleHolders).toEqual([]);
  });

  it('rejects output that is not a usable sample', () => {
    expect(parseHostHealthOutput('', T)).toBeUndefined();
    expect(parseHostHealthOutput('Get-NetUDPEndpoint : Access denied', T)).toBeUndefined();
    expect(parseHostHealthOutput(JSON.stringify({ udp: -1, tcp: 2 }), T)).toBeUndefined();
    expect(parseHostHealthOutput('[1,2]', T)).toBeUndefined();
  });
});

describe('isHostHealthAbnormal', () => {
  it('flags port exhaustion and a handle leak, not a normal host', () => {
    const normal = sample({});
    expect(isHostHealthAbnormal(normal)).toBe(false);
    expect(isHostHealthAbnormal(sample({ udpEndpoints: 16_000 }))).toBe(true);
    expect(isHostHealthAbnormal(sample({
      topHandleHolders: [{ name: 'mtkbtsvc', pid: 6712, count: 127_519 }],
    }))).toBe(true);
  });
});

describe('startHostHealthSampling', () => {
  it('does nothing off Windows', () => {
    const runCommand = vi.fn(async () => HEALTHY_OUTPUT);
    const setTimeoutFn = vi.fn();

    startHostHealthSampling({ platform: 'darwin', runCommand, setTimeout: setTimeoutFn as never });

    expect(setTimeoutFn).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('samples after the first delay, then on the interval, without overlapping runs', async () => {
    vi.useFakeTimers();
    let release: (value: string) => void = () => undefined;
    const runCommand = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const emit = vi.fn();

    const stop = startHostHealthSampling({
      platform: 'win32', runCommand, emit, firstDelayMs: 1_000, intervalMs: 10_000, now: () => T,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runCommand).toHaveBeenCalledTimes(1);
    // The first run is still in flight: no second run however long it takes.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runCommand).toHaveBeenCalledTimes(1);

    release(HEALTHY_OUTPUT);
    await vi.advanceTimersByTimeAsync(0);
    expect(emit).toHaveBeenCalledWith('warn', expect.objectContaining({ udpEndpoints: 85 }));
    expect(getLatestHostHealthSample()?.sampledAt).toBe(T);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(runCommand).toHaveBeenCalledTimes(2);
    stop();
  });

  it('keeps the previous sample when a run fails and keeps sampling', async () => {
    vi.useFakeTimers();
    const runCommand = vi.fn()
      .mockResolvedValueOnce(HEALTHY_OUTPUT)
      .mockRejectedValueOnce(new Error('powershell timed out'))
      .mockResolvedValue(HEALTHY_OUTPUT);

    const stop = startHostHealthSampling({
      platform: 'win32', runCommand, emit: vi.fn(), firstDelayMs: 0, intervalMs: 1_000, now: () => T,
    });

    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runCommand).toHaveBeenCalledTimes(2);
    expect(getLatestHostHealthSample()?.udpEndpoints).toBe(85);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runCommand).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(runCommand).toHaveBeenCalledTimes(3);
  });
});

function sample(overrides: Partial<WorkerHostHealthSample>): WorkerHostHealthSample {
  return {
    sampledAt: T,
    udpEndpoints: 85,
    tcpConnections: 283,
    topUdpOwners: [],
    topHandleHolders: [{ name: 'UA Connect', pid: 31656, count: 11_844 }],
    ...overrides,
  };
}
