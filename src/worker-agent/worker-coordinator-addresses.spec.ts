import { describe, expect, it } from 'vitest';
import {
  applyAdvertisedCoordinatorUrls,
  parseCoordinatorAddressesNotification,
} from './worker-coordinator-addresses';
import type { WorkerConfig } from './worker-config';

function makeConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    nodeId: 'node-1',
    name: 'windows-pc',
    coordinatorUrl: 'ws://macbook-pro.tail4fc107.ts.net:4878',
    authToken: 'token',
    namespace: 'default',
    maxConcurrentInstances: 4,
    workingDirectories: [],
    reconnectIntervalMs: 1000,
    heartbeatIntervalMs: 5000,
    ...overrides,
  };
}

describe('parseCoordinatorAddressesNotification', () => {
  const valid = {
    jsonrpc: '2.0' as const,
    method: 'node.coordinatorAddresses',
    scope: 'service' as const,
    params: { urls: ['ws://192.168.0.156:4878'] },
  };

  it('returns the URLs of a valid service-scoped notification', () => {
    expect(parseCoordinatorAddressesNotification(valid)).toEqual(['ws://192.168.0.156:4878']);
  });

  it('rejects other methods, requests, missing scope, and bad params', () => {
    expect(parseCoordinatorAddressesNotification({ ...valid, method: 'node.streamAck' })).toBeNull();
    expect(parseCoordinatorAddressesNotification({ ...valid, id: 7 })).toBeNull();
    expect(parseCoordinatorAddressesNotification({ ...valid, scope: undefined })).toBeNull();
    expect(parseCoordinatorAddressesNotification({ ...valid, scope: 'instance' })).toBeNull();
    expect(parseCoordinatorAddressesNotification({ ...valid, params: { urls: ['http://x:1'] } })).toBeNull();
    expect(parseCoordinatorAddressesNotification({ ...valid, params: { urls: [] } })).toBeNull();
  });
});

describe('applyAdvertisedCoordinatorUrls', () => {
  it('replaces the previous set so stale addresses drop out', () => {
    const config = makeConfig({ advertisedCoordinatorUrls: ['ws://192.168.0.95:4878'] });
    expect(applyAdvertisedCoordinatorUrls(config, ['ws://192.168.0.156:4878', 'ws://192.168.0.156:4878'])).toBe(true);
    expect(config.advertisedCoordinatorUrls).toEqual(['ws://192.168.0.156:4878']);
  });

  it('reports no change when the list is identical', () => {
    const config = makeConfig({ advertisedCoordinatorUrls: ['ws://192.168.0.156:4878'] });
    expect(applyAdvertisedCoordinatorUrls(config, ['ws://192.168.0.156:4878'])).toBe(false);
  });

  it('keeps the existing list when nothing usable was advertised', () => {
    const config = makeConfig({ advertisedCoordinatorUrls: ['ws://192.168.0.156:4878'] });
    expect(applyAdvertisedCoordinatorUrls(config, ['not a url'])).toBe(false);
    expect(config.advertisedCoordinatorUrls).toEqual(['ws://192.168.0.156:4878']);
  });

  it('never downgrades a TLS-pinned worker to a cleartext route', () => {
    const config = makeConfig({ coordinatorUrl: 'wss://mac.ts.net:4878' });
    expect(applyAdvertisedCoordinatorUrls(config, ['ws://192.168.0.156:4878', 'wss://192.168.0.156:4878'])).toBe(true);
    expect(config.advertisedCoordinatorUrls).toEqual(['wss://192.168.0.156:4878']);
  });
});
