import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:os', () => ({
  networkInterfaces: vi.fn(),
}));

import { networkInterfaces } from 'node:os';
import type * as os from 'node:os';
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

function fakeAddress(address: string, internal = false): os.NetworkInterfaceInfo {
  const family = address.includes(':') ? 'IPv6' : 'IPv4';
  return {
    address,
    netmask: family === 'IPv6' ? 'ffff:ffff:ffff:ffff::' : '255.255.255.0',
    family,
    mac: '00:00:00:00:00:00',
    internal,
    cidr: family === 'IPv6' ? `${address}/64` : `${address}/24`,
  } as os.NetworkInterfaceInfo;
}

function setInterfaces(names: string[]): void {
  // Default fixture address: a routable, non-Tailscale IPv4 (as a real corporate VPN would have),
  // so existing name-only tests keep matching under the new address-aware filter.
  mockedNetworkInterfaces.mockReturnValue(
    Object.fromEntries(names.map((name) => [name, [fakeAddress('10.10.0.5')]])),
  );
}

function setInterfacesWithAddresses(entries: Record<string, string[]>): void {
  mockedNetworkInterfaces.mockReturnValue(
    Object.fromEntries(
      Object.entries(entries).map(([name, addrs]) => [name, addrs.map((a) => fakeAddress(a))]),
    ),
  );
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

// Regression coverage for a real reported bug: "Pause on VPN" was always on for a machine that
// was never on a real VPN, only Tailscale. Root cause: the detector matched any utunN-named
// interface with no regard for whether it actually carried a real address, and macOS assigns
// utunN indistinguishably to Tailscale, WireGuard, and inert/no-traffic stub tunnels it creates
// on its own. utun0 was later found to always be present on the reporter's machine (auto-created
// tunnel adapter) with no address at all — the pre-fix name-only match treated that as "VPN up"
// permanently, regardless of whether Tailscale (or anything else) was actually connected.
describe('VpnDetector — address-aware matching (Tailscale false-positive regression)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    VpnDetector._resetForTesting();
    vi.useRealTimers();
  });

  // treatExistingAsVpn: true so each test can assert isVpnActive() immediately after start(),
  // directly against the interface snapshot rather than needing a mid-session timer advance.
  const utunPattern = () =>
    detectorConfig({
      pattern: /^(utun[0-9]+|ipsec[0-9]+|ppp[0-9]+|tap[0-9]+)$/,
      treatExistingAsVpn: true,
    });

  it('does not treat an inert utun interface with only a link-local address as a VPN', () => {
    setInterfacesWithAddresses({ lo0: ['127.0.0.1'], en0: ['192.168.1.5'], utun0: ['fe80::1'] });
    const detector = new VpnDetector(utunPattern());
    detector.start();

    expect(detector.isVpnActive()).toBe(false);
  });

  it('does not treat a Tailscale interface (100.64.0.0/10) as a VPN', () => {
    setInterfacesWithAddresses({
      lo0: ['127.0.0.1'],
      en0: ['192.168.1.5'],
      utun11: ['100.68.10.5', 'fd7a:115c:a1e0::bd01:a1d'],
    });
    const detector = new VpnDetector(utunPattern());
    detector.start();

    expect(detector.isVpnActive()).toBe(false);
  });

  it('reproduces the exact reported machine shape: several inert utun stubs plus one Tailscale interface — never treated as VPN active', () => {
    setInterfacesWithAddresses({
      lo0: ['127.0.0.1'],
      en0: ['192.168.1.5'],
      utun0: ['fe80::3416:29b2:d4c4:2804'],
      utun1: ['fe80::455d:e1b3:d927:5db2'],
      utun2: ['fe80::1b80:f78:38f5:9f1b'],
      utun3: ['fe80::ce81:b1c:bd2c:69e'],
      utun11: ['100.68.10.5', 'fd7a:115c:a1e0::bd01:a1d'],
    });
    const detector = new VpnDetector(utunPattern());
    detector.start();

    expect(detector.isVpnActive()).toBe(false);
  });

  it('still treats a real corporate VPN (routable non-Tailscale address) as active', () => {
    setInterfacesWithAddresses({ lo0: ['127.0.0.1'], en0: ['192.168.1.5'], utun4: ['10.10.0.7'] });
    const detector = new VpnDetector(utunPattern());
    detector.start();

    expect(detector.isVpnActive()).toBe(true);
  });

  it('treats a utun interface with a mix of Tailscale and non-Tailscale addresses as active (genuinely ambiguous — fail toward pausing, not silence)', () => {
    setInterfacesWithAddresses({
      lo0: ['127.0.0.1'],
      utun5: ['100.70.1.1', '10.10.0.9'],
    });
    const detector = new VpnDetector(utunPattern());
    detector.start();

    expect(detector.isVpnActive()).toBe(true);
  });

  it('resumes (via the flap-suppression debounce) when a previously-active interface keeps its name but loses its qualifying address', () => {
    setInterfacesWithAddresses({ utun4: ['10.10.0.7'] });
    const detector = new VpnDetector(utunPattern());
    const onDown = vi.fn();
    detector.on('vpn-down', onDown);
    detector.start();
    expect(detector.isVpnActive()).toBe(true);

    // Interface name persists, but now only carries a link-local address (Tailscale/VPN torn
    // down while the OS hasn't removed the utun device yet) — must resume, not stay stuck "up".
    setInterfacesWithAddresses({ utun4: ['fe80::1'] });
    vi.advanceTimersByTime(2000);
    expect(onDown).not.toHaveBeenCalled(); // first tick: flap-suppressed
    vi.advanceTimersByTime(2000);
    expect(onDown).toHaveBeenCalledOnce();
    expect(detector.isVpnActive()).toBe(false);
  });
});
