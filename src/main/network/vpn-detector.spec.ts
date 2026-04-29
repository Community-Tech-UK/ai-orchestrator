import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:os', () => ({
  networkInterfaces: vi.fn(),
}));

import { networkInterfaces } from 'node:os';
import { VpnDetector, type VpnDetectorConfig } from './vpn-detector';

const mockedNetworkInterfaces = vi.mocked(networkInterfaces);

class TestVpnDetector extends VpnDetector {
  override startProbeIfConfigured(): void {
    // Probe tests drive protected onProbeResult directly.
  }

  protected override async tcpProbe(): Promise<boolean> {
    return false;
  }

  pushProbeResult(affirmative: boolean): void {
    this.onProbeResult(affirmative);
  }
}

function detectorConfig(overrides: Partial<VpnDetectorConfig> = {}): VpnDetectorConfig {
  return {
    pattern: /^utun[0-9]+$/,
    treatExistingAsVpn: false,
    probeMode: 'disabled',
    ...overrides,
  };
}

function setInterfaces(names: string[]): void {
  mockedNetworkInterfaces.mockReturnValue(Object.fromEntries(names.map((name) => [name, []])));
}

describe('VpnDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setInterfaces(['lo0', 'en0', 'utun0']);
  });

  afterEach(() => {
    VpnDetector._resetForTesting();
    vi.useRealTimers();
  });

  it('emits vpn-up when a matching interface appears mid-session', () => {
    const detector = new VpnDetector(detectorConfig());
    const onUp = vi.fn();
    detector.on('vpn-up', onUp);

    detector.start();
    expect(onUp).not.toHaveBeenCalled();

    setInterfaces(['lo0', 'en0', 'utun0', 'utun5']);
    vi.advanceTimersByTime(2000);

    expect(onUp).toHaveBeenCalledOnce();
  });

  it('treats existing matching interfaces as active when configured', () => {
    const detector = new VpnDetector(detectorConfig({ treatExistingAsVpn: true }));
    const onUp = vi.fn();
    detector.on('vpn-up', onUp);

    detector.start();

    expect(onUp).toHaveBeenCalledOnce();
    expect(detector.isVpnActive()).toBe(true);
  });

  it('does not treat existing matching interfaces as active by default', () => {
    const detector = new VpnDetector(detectorConfig({ treatExistingAsVpn: false }));
    const onUp = vi.fn();
    detector.on('vpn-up', onUp);

    detector.start();

    expect(onUp).not.toHaveBeenCalled();
    expect(detector.isVpnActive()).toBe(false);
  });

  it('emits vpn-up again after a startup interface disconnects and reconnects', () => {
    const detector = new VpnDetector(detectorConfig());
    const onUp = vi.fn();
    detector.on('vpn-up', onUp);
    detector.start();

    setInterfaces(['lo0', 'en0']);
    vi.advanceTimersByTime(2000);
    setInterfaces(['lo0', 'en0', 'utun5']);
    vi.advanceTimersByTime(2000);

    expect(onUp).toHaveBeenCalledOnce();
  });

  it('suppresses a one-tick disconnect flap before emitting vpn-down', () => {
    const detector = new VpnDetector(detectorConfig({ treatExistingAsVpn: true }));
    const onDown = vi.fn();
    detector.on('vpn-down', onDown);
    detector.start();

    setInterfaces(['lo0', 'en0']);
    vi.advanceTimersByTime(2000);
    expect(onDown).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2000);
    expect(onDown).toHaveBeenCalledOnce();
  });

  it('honours forceFirstScanVpnTreatment for the first scan', () => {
    const detector = new VpnDetector(
      detectorConfig({ treatExistingAsVpn: false, forceFirstScanVpnTreatment: true })
    );
    const onUp = vi.fn();
    detector.on('vpn-up', onUp);

    detector.start();

    expect(onUp).toHaveBeenCalledOnce();
    expect(detector.isVpnActive()).toBe(true);
  });

  it('does not duplicate vpn-up while state remains up', () => {
    const detector = new VpnDetector(detectorConfig({ treatExistingAsVpn: true }));
    const onUp = vi.fn();
    detector.on('vpn-up', onUp);

    detector.start();
    vi.advanceTimersByTime(6000);

    expect(onUp).toHaveBeenCalledOnce();
  });

  it('debounces probe non-affirmative results before clearing probe VPN signal', () => {
    const detector = new TestVpnDetector(
      detectorConfig({ probeMode: 'reachable-means-vpn', probeHost: 'example.com:443' })
    );
    const onUp = vi.fn();
    const onDown = vi.fn();
    detector.on('vpn-up', onUp);
    detector.on('vpn-down', onDown);
    detector.start();

    detector.pushProbeResult(true);
    detector.pushProbeResult(false);
    detector.pushProbeResult(false);

    expect(onUp).toHaveBeenCalledOnce();
    expect(onDown).toHaveBeenCalledOnce();
    expect(detector.probeKnownNow()).toBe(true);
  });

  it('emits first-evaluation-complete after first probe result in probe mode', () => {
    const detector = new TestVpnDetector(
      detectorConfig({ probeMode: 'unreachable-means-vpn', probeHost: 'example.com:443' })
    );
    const onFirst = vi.fn();
    detector.on('first-evaluation-complete', onFirst);

    detector.start();
    expect(onFirst).not.toHaveBeenCalled();

    detector.pushProbeResult(false);
    detector.pushProbeResult(false);

    expect(onFirst).toHaveBeenCalledOnce();
  });
});
