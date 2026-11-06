/**
 * The startup check's "Other computers" line, against the real other-computers
 * listener instead of a stand-in.
 *
 * Launch starts the listener in an earlier step and waits for it, so by the time
 * the check runs the answer is final: the listener is up, or its start failed.
 * These pin the two facts that make that true of the real server: `start()` does
 * not return until the port is open, and a start that fails leaves it reporting
 * "not running" rather than something hopeful.
 */

import * as net from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  remoteConfig: vi.fn(),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../remote-node/remote-node-config', () => ({
  getRemoteNodeConfig: () => mocks.remoteConfig(),
}));

// The listener's own collaborators: nothing here connects, so they only need to exist.
vi.mock('../auth/remote-auth', () => ({ getRemoteAuthService: () => ({}) }));
vi.mock('../remote-node/worker-node-registry', () => ({
  getWorkerNodeRegistry: () => ({
    getNode: () => undefined,
    getAllNodes: () => [],
    on: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
  }),
}));
vi.mock('../remote-node/remote-worker-repair-tracker', () => ({
  getRemoteWorkerRepairTracker: () => ({ clear: vi.fn(), recordRejectedRegistration: vi.fn() }),
}));

// Everything else the check looks at, held at "fine" so only the listener matters.
vi.mock('../cli/cli-detection', () => ({
  getCliDetectionService: () => ({
    detectAll: async () => ({ available: [{ name: 'claude' }], detected: [], unavailable: [], timestamp: new Date() }),
  }),
}));
vi.mock('../providers/provider-doctor', () => ({
  getProviderDoctor: () => ({
    diagnose: async (provider: string) => ({
      overall: 'healthy', probes: [], recommendations: [], provider, timestamp: Date.now(),
    }),
  }),
}));
vi.mock('../persistence/rlm-database', () => ({
  getRLMDatabase: () => ({ getRawDb: () => ({ prepare: () => ({ get: () => ({ ok: 1 }) }) }) }),
}));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      defaultCli: 'auto', automationDefaultCli: 'auto', providerAccountProfiles: [], copilotAccountProfiles: [],
    }),
  }),
}));
vi.mock('../browser-automation/browser-automation-health', () => ({
  getBrowserAutomationHealthService: () => ({
    diagnose: async () => ({
      status: 'missing', runtimeAvailable: true, nodeAvailable: true, inAppConfigured: false, inAppConnected: false,
      inAppToolCount: 0, configDetected: false, configSources: [], browserToolNames: [], warnings: [], suggestions: [],
    }),
  }),
}));
vi.mock('../mcp/mcp-manager', () => ({
  getMcpManager: () => ({ getServers: () => [], on: vi.fn(), off: vi.fn() }),
}));
vi.mock('../sandbox/seatbelt', () => ({ probeSeatbelt: async () => ({ supported: true }) }));

import { CapabilityProbe } from './capability-probe';
import { getWorkerNodeConnectionServer, WorkerNodeConnectionServer } from '../remote-node/worker-node-connection';

/** A loopback port nothing is using right now. */
async function freePort(): Promise<number> {
  const holder = net.createServer();
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
  const { port } = holder.address() as net.AddressInfo;
  await new Promise<void>((resolve) => holder.close(() => resolve()));
  return port;
}

async function otherComputersCheck() {
  const report = await new CapabilityProbe().run();
  return report.checks.find((check) => check.id === 'subsystem.remote-nodes');
}

describe('startup check against the real other-computers listener', () => {
  let port: number;

  beforeEach(async () => {
    port = await freePort();
    mocks.remoteConfig.mockReturnValue({
      enabled: true,
      serverHost: '127.0.0.1',
      serverPort: port,
      namespace: 'default',
      tlsCertPath: undefined,
      tlsKeyPath: undefined,
    });
  });

  afterEach(() => {
    WorkerNodeConnectionServer._resetForTesting();
  });

  it('says it is not running until the listener is up, and running as soon as start() returns', async () => {
    expect(await otherComputersCheck()).toMatchObject({
      status: 'degraded',
      summary: `On, but not running yet: Harness isn't listening on 127.0.0.1:${port}.`,
    });

    // This is the await the launch step makes before the next step begins.
    await getWorkerNodeConnectionServer().start(port, '127.0.0.1');

    expect(await otherComputersCheck()).toMatchObject({
      status: 'ready',
      summary: `Running: other computers can connect on 127.0.0.1:${port}.`,
    });
  });

  it('keeps saying it is not running when the port is taken, so a real failure is never hidden', async () => {
    const squatter = net.createServer();
    await new Promise<void>((resolve) => squatter.listen(port, '127.0.0.1', resolve));
    try {
      await expect(getWorkerNodeConnectionServer().start(port, '127.0.0.1')).rejects.toThrow(/EADDRINUSE/);

      expect(await otherComputersCheck()).toMatchObject({
        status: 'degraded',
        summary: `On, but not running yet: Harness isn't listening on 127.0.0.1:${port}.`,
        details: { fix: 'remote-computers', running: false },
      });
    } finally {
      await new Promise<void>((resolve) => squatter.close(() => resolve()));
    }
  });
});
