import { describe, expect, it } from 'vitest';
import { PAUSE_SETTING_VALIDATORS } from './settings-validators';

describe('PAUSE_SETTING_VALIDATORS', () => {
  it('validates VPN interface regex safety and syntax', () => {
    expect(PAUSE_SETTING_VALIDATORS.pauseVpnInterfacePattern?.('^utun[0-9]+$').ok).toBe(true);
    expect(PAUSE_SETTING_VALIDATORS.pauseVpnInterfacePattern?.('').ok).toBe(false);
  });

  it('rejects invalid and unsafe VPN interface regexes', () => {
    const invalid = PAUSE_SETTING_VALIDATORS.pauseVpnInterfacePattern?.('(');
    expect(invalid?.ok).toBe(false);

    const unsafe = PAUSE_SETTING_VALIDATORS.pauseVpnInterfacePattern?.('(a+)+b');
    expect(unsafe?.ok).toBe(false);
    if (unsafe && !unsafe.ok) expect(unsafe.error).toMatch(/unsafe|catastrophic/i);

    expect(PAUSE_SETTING_VALIDATORS.pauseVpnInterfacePattern?.('a'.repeat(201)).ok).toBe(false);
  });

  it('validates reachability probe host:port values', () => {
    expect(PAUSE_SETTING_VALIDATORS.pauseReachabilityProbeHost?.('').ok).toBe(true);
    expect(PAUSE_SETTING_VALIDATORS.pauseReachabilityProbeHost?.('host.internal:443').ok).toBe(true);
    expect(PAUSE_SETTING_VALIDATORS.pauseReachabilityProbeHost?.('[::1]:443').ok).toBe(true);
    expect(PAUSE_SETTING_VALIDATORS.pauseReachabilityProbeHost?.('host.internal').ok).toBe(false);
    expect(PAUSE_SETTING_VALIDATORS.pauseReachabilityProbeHost?.('host.internal:99999').ok).toBe(false);
    expect(
      PAUSE_SETTING_VALIDATORS.pauseReachabilityProbeHost?.(`${'a'.repeat(254)}:443`).ok
    ).toBe(false);
  });

  it('validates probe mode enum values', () => {
    expect(PAUSE_SETTING_VALIDATORS.pauseReachabilityProbeMode?.('disabled').ok).toBe(true);
    expect(PAUSE_SETTING_VALIDATORS.pauseReachabilityProbeMode?.('reachable-means-vpn').ok).toBe(
      true
    );
    expect(
      PAUSE_SETTING_VALIDATORS.pauseReachabilityProbeMode?.('unreachable-means-vpn').ok
    ).toBe(true);
    expect(PAUSE_SETTING_VALIDATORS.pauseReachabilityProbeMode?.('other').ok).toBe(false);
  });

  it('validates probe interval bounds', () => {
    expect(PAUSE_SETTING_VALIDATORS.pauseReachabilityProbeIntervalSec?.(10).ok).toBe(true);
    expect(PAUSE_SETTING_VALIDATORS.pauseReachabilityProbeIntervalSec?.(600).ok).toBe(true);
    expect(PAUSE_SETTING_VALIDATORS.pauseReachabilityProbeIntervalSec?.(9).ok).toBe(false);
    expect(PAUSE_SETTING_VALIDATORS.pauseReachabilityProbeIntervalSec?.(601).ok).toBe(false);
    expect(PAUSE_SETTING_VALIDATORS.pauseReachabilityProbeIntervalSec?.(30.5).ok).toBe(false);
  });

  it('validates boolean pause settings', () => {
    for (const key of [
      'pauseFeatureEnabled',
      'pauseOnVpnEnabled',
      'pauseTreatExistingVpnAsActive',
      'pauseDetectorDiagnostics',
      'pauseAllowPrivateRanges',
    ] as const) {
      expect(PAUSE_SETTING_VALIDATORS[key]?.(true).ok).toBe(true);
      expect(PAUSE_SETTING_VALIDATORS[key]?.(false).ok).toBe(true);
      expect(PAUSE_SETTING_VALIDATORS[key]?.('true').ok).toBe(false);
    }
  });
});
