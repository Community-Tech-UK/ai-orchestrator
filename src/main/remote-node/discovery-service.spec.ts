import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscoveryService } from './discovery-service';

// Records every Bonjour instance the service constructs, so a test can assert
// how many were ever live at once — the thing a leak actually looks like.
const bonjour = vi.hoisted(() => {
  const instances: {
    publish: ReturnType<typeof vi.fn>;
    unpublishAll: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    order: string[];
  }[] = [];
  const order: string[] = [];
  return { instances, order };
});

vi.mock('bonjour-service', () => ({
  Bonjour: class {
    publish = vi.fn((opts: unknown) => {
      bonjour.order.push('publish');
      return opts;
    });
    unpublishAll = vi.fn(() => bonjour.order.push('unpublishAll'));
    destroy = vi.fn(() => bonjour.order.push('destroy'));
    constructor() {
      bonjour.order.push('construct');
      bonjour.instances.push(this as never);
    }
  },
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

describe('DiscoveryService', () => {
  beforeEach(() => {
    DiscoveryService._resetForTesting();
    bonjour.instances.length = 0;
    bonjour.order.length = 0;
  });

  it('publishes the coordinator service with the given port and namespace', () => {
    DiscoveryService.getInstance().publish(4878, 'default', 'default');

    expect(bonjour.instances).toHaveLength(1);
    expect(bonjour.instances[0].publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'ai-orchestrator', port: 4878 }),
    );
    expect(DiscoveryService.getInstance().isPublished).toBe(true);
  });

  // The startup path publishes, and toggling the server in Settings publishes
  // again. Before publish() became idempotent the second call overwrote the
  // `bonjour` field, leaking the first instance and leaving a stale
  // advertisement alive for workers to discover.
  it('tears the previous advertisement down before publishing a second time', () => {
    const service = DiscoveryService.getInstance();
    service.publish(4878, 'default', 'default');
    service.publish(4999, 'default', 'default');

    expect(bonjour.instances).toHaveLength(2);
    expect(bonjour.instances[0].unpublishAll).toHaveBeenCalled();
    expect(bonjour.instances[0].destroy).toHaveBeenCalled();
    // The teardown must happen BEFORE the replacement is constructed, or the
    // two advertisements overlap.
    expect(bonjour.order).toEqual([
      'construct',
      'publish',
      'unpublishAll',
      'destroy',
      'construct',
      'publish',
    ]);
  });

  it('leaves only the newest advertisement live after a re-publish', () => {
    const service = DiscoveryService.getInstance();
    service.publish(4878, 'default', 'default');
    service.publish(4999, 'default', 'default');

    expect(bonjour.instances[1].destroy).not.toHaveBeenCalled();
    expect(bonjour.instances[1].publish).toHaveBeenCalledWith(
      expect.objectContaining({ port: 4999 }),
    );
    expect(service.isPublished).toBe(true);
  });

  it('unpublish is a safe no-op when nothing was ever published', () => {
    expect(() => DiscoveryService.getInstance().unpublish()).not.toThrow();
    expect(bonjour.instances).toHaveLength(0);
    expect(DiscoveryService.getInstance().isPublished).toBe(false);
  });

  it('unpublish twice does not touch a destroyed instance again', () => {
    const service = DiscoveryService.getInstance();
    service.publish(4878, 'default', 'default');

    service.unpublish();
    service.unpublish();

    expect(bonjour.instances[0].destroy).toHaveBeenCalledTimes(1);
    expect(service.isPublished).toBe(false);
  });
});
