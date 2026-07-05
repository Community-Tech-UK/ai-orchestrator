import { describe, expect, it } from 'vitest';
import { formatRemoteNodePlatformLabel } from './remote-node-display';

describe('remote-node-display', () => {
  it('formats known worker platforms and preserves unknown platform state', () => {
    expect(formatRemoteNodePlatformLabel('win32')).toBe('Windows');
    expect(formatRemoteNodePlatformLabel('darwin')).toBe('macOS');
    expect(formatRemoteNodePlatformLabel('linux')).toBe('Linux');
    expect(formatRemoteNodePlatformLabel(undefined)).toBe('Unknown');
  });
});
