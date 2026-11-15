import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerAgent } from './worker-agent';

const discovery = vi.hoisted(() => ({ discover: vi.fn(async () => null), start: vi.fn() }));
const network = vi.hoisted(() => ({ ready: vi.fn(async () => null as string | null) }));
vi.mock('./discovery-client', () => ({ DiscoveryClient: class {
  discover = discovery.discover;
  startContinuous = discovery.start;
} }));
vi.mock('./capability-reporter', () => ({ reportCapabilities: async () => ({}), resolveChromeExecutablePath: () => null }));
vi.mock('./coordinator-network-readiness', async (original) => ({
  ...await original<typeof import('./coordinator-network-readiness')>(),
  firstReachableCoordinatorCandidate: network.ready,
}));
vi.mock('ws', () => ({ WebSocket: class extends EventEmitter {
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = 1;
  constructor() { super(); queueMicrotask(() => this.emit('open')); }
} }));

function worker(coordinatorUrl?: string): WorkerAgent {
  const agent = Object.create(WorkerAgent.prototype) as WorkerAgent;
  const fields = {
    config: { discoveryEnabled: false, namespace: 'home-base', coordinatorUrl },
    extensionRelay: { start: async () => undefined, getSummary: () => undefined },
    browserManager: { getSummary: () => undefined },
    androidManager: { getSummary: async () => undefined },
    localNetwork: { settle: async () => undefined, notice: () => undefined },
    fileTransferSummary: () => undefined,
    capabilityExtras: () => ({}),
    rebuildFilesystemHandler: () => undefined,
    checkExtensionRelayRegistration: () => undefined,
    scheduleReconnect: vi.fn(),
    sendRegistration: () => undefined,
    armRegistrationWatchdog: () => undefined,
    discoveryClient: null,
  };
  for (const [key, value] of Object.entries(fields)) Reflect.set(agent, key, value);
  return agent;
}

afterEach(() => { vi.clearAllMocks(); network.ready.mockResolvedValue(null); });
describe('Tailscale-only discovery policy', () => {
  it('does not start continuous or first-start discovery without a saved address', async () => {
    await worker().connect();
    expect(discovery.start).not.toHaveBeenCalled();
    expect(discovery.discover).not.toHaveBeenCalled();
  });
  it('does not rediscover on the home network after every saved address fails', async () => {
    await worker('ws://100.64.0.1:4888').connect();
    expect(discovery.discover).not.toHaveBeenCalled();
    expect(discovery.start).not.toHaveBeenCalled();
  });
  it('does not start continuous discovery after opening a paired connection', async () => {
    network.ready.mockResolvedValue('ws://100.64.0.1:4888');
    await worker('ws://100.64.0.1:4888').connect();
    expect(discovery.start).not.toHaveBeenCalled();
    expect(discovery.discover).not.toHaveBeenCalled();
  });
});
