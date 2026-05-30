import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { WebSocket } from 'ws';
import {
  MobileGatewayServer,
  serializeInstance,
  buildProjects,
  type GatewayInstanceSource,
} from './mobile-gateway-server';
import { MobileDeviceRegistry, type MobileDevicePersistence } from './mobile-device-registry';
import type { Instance } from '../../shared/types/instance.types';

function inst(partial: Partial<Instance>): Instance {
  return {
    id: 'i1',
    displayName: 'Agent',
    status: 'idle',
    provider: 'claude',
    workingDirectory: '/repo/alpha',
    createdAt: 1,
    lastActivity: 1,
    parentId: null,
    contextUsage: { used: 0, total: 0, percentage: 0 },
    ...partial,
  } as unknown as Instance;
}

class FakeInstanceSource extends EventEmitter implements GatewayInstanceSource {
  instances: Instance[] = [];
  getAllInstances(): Instance[] {
    return this.instances;
  }
}

function memPersistence(): MobileDevicePersistence {
  let store: string | undefined;
  return { load: () => store, save: (j: string) => { store = j; } };
}

interface MessageCollector {
  next(timeoutMs?: number): Promise<Record<string, unknown>>;
}

/** Buffer messages from creation so we never miss the server's eager snapshot. */
function collectMessages(ws: WebSocket): MessageCollector {
  const queue: Record<string, unknown>[] = [];
  const waiters: ((msg: Record<string, unknown>) => void)[] = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as Record<string, unknown>;
    const waiter = waiters.shift();
    if (waiter) waiter(msg);
    else queue.push(msg);
  });
  return {
    next(timeoutMs = 2000) {
      const queued = queue.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout waiting for WS message')), timeoutMs);
        waiters.push((msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
      });
    },
  };
}

describe('serializeInstance / buildProjects', () => {
  it('derives approval from status and groups by working directory', () => {
    const instances = [
      inst({ id: 'a', workingDirectory: '/repo/alpha', status: 'busy' }),
      inst({ id: 'b', workingDirectory: '/repo/alpha', status: 'waiting_for_permission' }),
      inst({ id: 'c', workingDirectory: '/repo/beta', status: 'idle', lastActivity: 99 }),
    ].map(serializeInstance);

    expect(instances[0].projectName).toBe('alpha');
    expect(instances[1].pendingApprovalCount).toBe(1);

    const projects = buildProjects(instances);
    const alpha = projects.find((p) => p.path === '/repo/alpha');
    expect(alpha?.sessionCount).toBe(2);
    expect(alpha?.busyCount).toBe(1);
    expect(alpha?.pendingApprovalCount).toBe(1);
    // beta has the most recent activity, so it sorts first
    expect(projects[0].path).toBe('/repo/beta');
  });
});

describe('MobileGatewayServer', () => {
  let server: MobileGatewayServer;
  let source: FakeInstanceSource;
  let registry: MobileDeviceRegistry;
  let port: number;

  beforeEach(async () => {
    source = new FakeInstanceSource();
    source.instances = [inst({ id: 'a', status: 'busy' })];
    registry = new MobileDeviceRegistry(memPersistence());
    server = new MobileGatewayServer();
    server.initialize({ instanceManager: source, registry });
    const status = await server.start({ port: 0, bindInterface: 'all' });
    port = status.port!;
    expect(status.running).toBe(true);
    expect(port).toBeGreaterThan(0);
  });

  afterEach(async () => {
    await server.stop();
  });

  async function pair(): Promise<string> {
    const pairing = registry.issuePairing();
    const res = await fetch(`http://127.0.0.1:${port}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingToken: pairing.pairingToken, label: 'Test iPhone' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    return body.token;
  }

  it('serves /health without auth', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it('rejects an invalid pairing token', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pairingToken: 'bogus' }),
    });
    expect(res.status).toBe(403);
  });

  it('requires a bearer token for /api/instances', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/instances`);
    expect(res.status).toBe(401);
  });

  it('pairs then lists instances with the device token', async () => {
    const token = await pair();
    const res = await fetch(`http://127.0.0.1:${port}/api/instances`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const instances = (await res.json()) as { id: string }[];
    expect(instances.map((i) => i.id)).toEqual(['a']);
  });

  it('pushes a snapshot on WS connect and again on instance change', async () => {
    const token = await pair();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    const messages = collectMessages(ws);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    try {
      const first = await messages.next();
      expect(first.type).toBe('snapshot');
      expect((first.data as { instances: unknown[] }).instances).toHaveLength(1);

      // Mutate + emit → expect a coalesced snapshot with the new instance.
      source.instances = [...source.instances, inst({ id: 'b', status: 'idle' })];
      source.emit('instance:created');
      const second = await messages.next();
      expect(second.type).toBe('snapshot');
      expect((second.data as { instances: unknown[] }).instances).toHaveLength(2);
    } finally {
      ws.close();
    }
  });

  it('refuses a WS upgrade without a valid token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=nope`);
    const outcome = await new Promise<'open' | 'error'>((resolve) => {
      ws.once('open', () => resolve('open'));
      ws.once('error', () => resolve('error'));
    });
    expect(outcome).toBe('error');
    ws.close();
  });
});
