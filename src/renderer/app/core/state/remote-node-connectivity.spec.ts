import { describe, expect, it } from 'vitest';
import { isRemoteNodeOnline } from './remote-node-connectivity';

describe('isRemoteNodeOnline', () => {
  it('prefers the live socket flag when present', () => {
    expect(isRemoteNodeOnline({ status: 'connected', connected: false })).toBe(false);
    expect(isRemoteNodeOnline({ status: 'connecting', connected: true })).toBe(true);
    expect(isRemoteNodeOnline({ status: 'degraded', connected: true })).toBe(true);
  });

  it('falls back to roster status for legacy payloads without a socket flag', () => {
    expect(isRemoteNodeOnline({ status: 'connected' })).toBe(true);
    expect(isRemoteNodeOnline({ status: 'connecting' })).toBe(false);
    expect(isRemoteNodeOnline({ status: 'degraded' })).toBe(false);
  });
});
