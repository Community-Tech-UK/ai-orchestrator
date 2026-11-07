import { describe, expect, it } from 'vitest';
import { withConnectionAddress } from './worker-node-connection-helpers';
import type { RpcRequest } from './worker-node-rpc';

const request = (params?: unknown): RpcRequest => ({
  jsonrpc: '2.0',
  id: 1,
  method: 'node.register',
  ...(params === undefined ? {} : { params }),
});

describe('withConnectionAddress', () => {
  it('records the plain IPv4 address for a peer a dual-stack listener reports as IPv4-mapped', () => {
    expect(withConnectionAddress(request({ nodeId: 'n1' }), '::ffff:192.168.0.40').params)
      .toEqual({ nodeId: 'n1', address: '192.168.0.40' });
  });

  it('keeps real IPv6 and IPv4 addresses as they are', () => {
    expect(withConnectionAddress(request(), 'fd7a:115c:a1e0::1234').params)
      .toEqual({ address: 'fd7a:115c:a1e0::1234' });
    expect(withConnectionAddress(request(), '100.68.10.5').params).toEqual({ address: '100.68.10.5' });
  });

  it('adds nothing without an address', () => {
    const original = request({ nodeId: 'n1' });
    expect(withConnectionAddress(original, undefined)).toBe(original);
    expect(withConnectionAddress(original, '  ')).toBe(original);
  });
});
