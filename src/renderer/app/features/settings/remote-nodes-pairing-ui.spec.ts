import { describe, expect, it } from 'vitest';
import {
  formatExpiry,
  formatPairingCredentialLabel,
  formatNodeCapacity,
  formatNodePlatformLabel,
  formatRelativeTime,
} from './remote-nodes-pairing-ui';

describe('remote-nodes-pairing-ui', () => {
  it('formats roster platform values for visible operator rows', () => {
    expect(formatNodePlatformLabel('win32')).toBe('Windows');
    expect(formatNodePlatformLabel('darwin')).toBe('macOS');
    expect(formatNodePlatformLabel('linux')).toBe('Linux');
    expect(formatNodePlatformLabel(undefined)).toBe('Platform unknown');
  });

  it('formats roster capacity as active over maximum instances', () => {
    expect(formatNodeCapacity({ activeInstances: 2, maxConcurrentInstances: 10 }))
      .toBe('2/10 capacity');
    expect(formatNodeCapacity({ activeInstances: 1, maxConcurrentInstances: 0 }))
      .toBe('1/0 capacity');
  });

  it('formats pending pairing labels without exposing token fragments', () => {
    expect(formatPairingCredentialLabel({ label: 'Studio PC' })).toBe('Studio PC');
    expect(formatPairingCredentialLabel({ label: '  ' })).toBe('Unlabeled credential');
    expect(formatPairingCredentialLabel({})).toBe('Unlabeled credential');
  });

  it('formats a future expiry relative to now', () => {
    const now = Date.now();
    expect(formatExpiry(now - 1)).toBe('now');
    expect(formatExpiry(now + 5 * 60_000)).toBe('in 5m');
    expect(formatExpiry(now + 3 * 3_600_000)).toBe('in 3h');
    expect(formatExpiry(now + 3 * 86_400_000)).toBe('in 3d');
  });

  it('formats a past timestamp relative to now, or "never" when absent', () => {
    const now = Date.now();
    expect(formatRelativeTime(undefined)).toBe('never');
    expect(formatRelativeTime(now - 1_000)).toBe('just now');
    expect(formatRelativeTime(now - 5 * 60_000)).toBe('5m ago');
    expect(formatRelativeTime(now - 3 * 3_600_000)).toBe('3h ago');
    expect(formatRelativeTime(now - 3 * 86_400_000)).toBe('3d ago');
  });
});
