import { describe, expect, it } from 'vitest';
import {
  formatPairingCredentialLabel,
  formatNodeCapacity,
  formatNodePlatformLabel,
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
});
