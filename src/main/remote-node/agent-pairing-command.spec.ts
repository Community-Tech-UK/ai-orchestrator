import { describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { parsePairingConfigInput } from '../../worker-agent/cli/pairing-config';
import { issueAgentPairingCommand, type AgentPairingDeps } from './agent-pairing-command';

const issuedBy = { instanceId: 'instance-1', name: 'Set up test Mac' };

function makeDeps(overrides: Partial<AgentPairingDeps> = {}): AgentPairingDeps & {
  issuePairingCredential: ReturnType<typeof vi.fn>;
} {
  const issuePairingCredential = vi.fn((options: { label?: string; ttlMs?: number }) => ({
    token: 'EXAMPLE_PAIRING',
    createdAt: 1_000,
    expiresAt: 1_000 + (options.ttlMs ?? 60 * 60_000),
    ...(options.label ? { label: options.label } : {}),
  }));
  return {
    issuePairingCredential,
    auth: { issuePairingCredential },
    isServerRunning: () => true,
    readConfig: () => ({ serverHost: '0.0.0.0', serverPort: 4878, namespace: 'default' }),
    readAddresses: async () => ({
      localIps: ['192.168.1.50', '100.101.102.103'],
      tailscaleIp: '100.101.102.103',
      tailscaleDnsName: 'studio-mac.tailnet-abcd.ts.net',
    }),
    ...overrides,
  };
}

describe('issueAgentPairingCommand', () => {
  it('issues a credential for the session and builds the same command Settings would', async () => {
    const deps = makeDeps();

    const result = await issueAgentPairingCommand({ label: 'ct-test-mac', ttlMinutes: 15, issuedBy }, deps);

    expect(deps.issuePairingCredential).toHaveBeenCalledWith({ label: 'ct-test-mac', ttlMs: 15 * 60_000, issuedBy });
    expect(result.link).toBe(
      'ai-orchestrator://remote-node/pair?host=studio-mac.tailnet-abcd.ts.net&port=4878&namespace=default'
      + '&token=EXAMPLE_PAIRING&requireTls=false&name=ct-test-mac&fallbackHost=100.101.102.103&fallbackHost=192.168.1.50',
    );
    expect(result.command).toBe(`aio-worker pair "${result.link}"`);
    expect(result.connectionConfig).toEqual({
      name: 'ct-test-mac',
      authToken: 'EXAMPLE_PAIRING',
      coordinatorUrl: 'ws://studio-mac.tailnet-abcd.ts.net:4878',
      coordinatorUrls: ['ws://100.101.102.103:4878', 'ws://192.168.1.50:4878'],
      namespace: 'default',
      maxConcurrentInstances: 10,
      workingDirectories: [],
    });
    expect(result).toMatchObject({ label: 'ct-test-mac', createdAt: 1_000, expiresAt: 1_000 + 15 * 60_000 });
  });

  it('gives the worker the label as its name and lists the Tailscale IPv6 address in brackets', async () => {
    const deps = makeDeps({
      readAddresses: async () => ({
        localIps: ['192.168.1.50'],
        tailscaleIp: '100.101.102.103',
        tailscaleIpv6: 'fd7a:115c:a1e0::1234',
        tailscaleDnsName: null,
      }),
    });

    const result = await issueAgentPairingCommand({ label: 'Studio Mac', issuedBy }, deps);

    expect(parsePairingConfigInput(result.link)).toMatchObject({
      name: 'Studio Mac',
      coordinatorUrl: 'ws://100.101.102.103:4878',
      coordinatorUrls: ['ws://[fd7a:115c:a1e0::1234]:4878', 'ws://192.168.1.50:4878'],
    });
    expect(result.connectionConfig['coordinatorUrls']).toEqual([
      'ws://[fd7a:115c:a1e0::1234]:4878',
      'ws://192.168.1.50:4878',
    ]);
  });

  it('leaves the lifetime to the auth service default when none is asked for', async () => {
    const deps = makeDeps();
    await issueAgentPairingCommand({ issuedBy }, deps);
    expect(deps.issuePairingCredential).toHaveBeenCalledWith({ issuedBy });
  });

  it('uses wss and the bound host alone when TLS is on and the server is bound to one address', async () => {
    const deps = makeDeps({
      readConfig: () => ({
        serverHost: '192.168.1.60',
        serverPort: 4999,
        namespace: 'lab',
        tlsCertPath: '/certs/cert.pem',
        tlsKeyPath: '/certs/key.pem',
      }),
    });

    const result = await issueAgentPairingCommand({ issuedBy }, deps);

    expect(result.connectionConfig['coordinatorUrl']).toBe('wss://192.168.1.60:4999');
    expect(result.connectionConfig).not.toHaveProperty('coordinatorUrls');
    expect(new URL(result.link).searchParams.get('namespace')).toBe('lab');
  });

  it('issues nothing while Harness is not accepting worker connections', async () => {
    const deps = makeDeps({ isServerRunning: () => false });

    await expect(issueAgentPairingCommand({ issuedBy }, deps)).rejects.toThrow('not accepting worker connections');
    expect(deps.issuePairingCredential).not.toHaveBeenCalled();
  });
});
