import { describe, expect, it, vi } from 'vitest';
import type { Browser, Service, ServiceConfig } from 'bonjour-service';
import {
  PAIR_BOTH_DISCOVERY_SERVICE_TYPE,
  PairBothDiscoveryBrowser,
  PairBothDiscoveryPublisher,
} from './pair-both-discovery';
import type { PairBothCandidate } from '../../shared/types/pair-both.types';

class FakeBonjour {
  readonly browser = { stop: vi.fn() } as unknown as Browser;
  readonly destroy = vi.fn();
  readonly unpublishAll = vi.fn();
  published: ServiceConfig | null = null;
  findOptions: unknown = null;
  onUp: ((service: Service) => void) | null = null;

  publish(options: ServiceConfig): Service {
    this.published = options;
    return { name: options.name, port: options.port } as Service;
  }

  find(options: unknown, onUp?: (service: Service) => void): Browser {
    this.findOptions = options;
    this.onUp = onUp ?? null;
    return this.browser;
  }

  emitUp(service: Partial<Service>): void {
    this.onUp?.(service as Service);
  }
}

function makeCandidate(patch: Partial<PairBothCandidate> = {}): PairBothCandidate {
  return {
    id: 'pair-both:session-1:192.168.1.20:49152',
    product: 'Harness',
    protocol: 'aio-worker-pair-v1',
    protocolVersion: '1',
    pairingSessionId: 'session-1',
    friendlyName: 'James MacBook',
    namespace: 'default',
    port: 49152,
    coordinatorPublicKey: 'public-key-material',
    expiresAt: 10_000,
    host: '192.168.1.20',
    addresses: ['192.168.1.20'],
    ...patch,
  };
}

describe('pair-both discovery', () => {
  it('publishes only public pair-both metadata', () => {
    const fake = new FakeBonjour();
    const publisher = new PairBothDiscoveryPublisher({
      createBonjour: () => fake,
    });

    publisher.publish(makeCandidate());

    expect(fake.published).toMatchObject({
      type: PAIR_BOTH_DISCOVERY_SERVICE_TYPE,
      port: 49152,
    });
    const txt = JSON.stringify(fake.published?.txt);
    expect(txt).toContain('aio-worker-pair-v1');
    expect(txt).not.toMatch(/token|secret|credential|payload/i);

    publisher.unpublish();
    expect(fake.unpublishAll).toHaveBeenCalled();
    expect(fake.destroy).toHaveBeenCalled();
  });

  it('discovers valid pair-both candidates and rejects expired or credential-like records', async () => {
    vi.useFakeTimers();
    const fake = new FakeBonjour();
    const browser = new PairBothDiscoveryBrowser({
      createBonjour: () => fake,
      now: () => 1_000,
    });

    const discovery = browser.discover({ timeoutMs: 500 });
    fake.emitUp({
      name: 'Harness Pair',
      host: 'james-macbook.local',
      port: 49152,
      addresses: ['192.168.1.20'],
      txt: {
        product: 'Harness',
        protocol: 'aio-worker-pair-v1',
        protocolVersion: '1',
        pairingSessionId: 'session-1',
        friendlyName: 'James MacBook',
        namespace: 'default',
        coordinatorPublicKey: 'public-key-material',
        expiresAt: '10000',
      },
    });
    fake.emitUp({
      name: 'Expired Pair',
      host: 'old.local',
      port: 49153,
      addresses: ['192.168.1.21'],
      txt: {
        product: 'Harness',
        protocol: 'aio-worker-pair-v1',
        protocolVersion: '1',
        pairingSessionId: 'expired',
        friendlyName: 'Old MacBook',
        namespace: 'default',
        coordinatorPublicKey: 'public-key-material',
        expiresAt: '999',
      },
    });
    fake.emitUp({
      name: 'Leaky Pair',
      host: 'leaky.local',
      port: 49154,
      addresses: ['192.168.1.22'],
      txt: {
        product: 'Harness',
        protocol: 'aio-worker-pair-v1',
        protocolVersion: '1',
        pairingSessionId: 'leaky',
        friendlyName: 'Leaky MacBook',
        namespace: 'default',
        coordinatorPublicKey: 'public-key-material',
        expiresAt: '10000',
        authToken: 'must-not-be-accepted',
      },
    });

    await vi.advanceTimersByTimeAsync(500);
    const candidates = await discovery;

    expect(fake.findOptions).toEqual({ type: PAIR_BOTH_DISCOVERY_SERVICE_TYPE });
    expect(candidates).toEqual([makeCandidate({
      id: 'pair-both:session-1:192.168.1.20:49152',
      host: '192.168.1.20',
      addresses: ['192.168.1.20'],
    })]);
    expect(fake.browser.stop).toHaveBeenCalled();
    expect(fake.destroy).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('cleans up the browser when no candidates are found before timeout', async () => {
    vi.useFakeTimers();
    const fake = new FakeBonjour();
    const browser = new PairBothDiscoveryBrowser({
      createBonjour: () => fake,
      now: () => 1_000,
    });

    const discovery = browser.discover({ timeoutMs: 250 });
    await vi.advanceTimersByTimeAsync(250);

    await expect(discovery).resolves.toEqual([]);
    expect(fake.browser.stop).toHaveBeenCalled();
    expect(fake.destroy).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
