import { beforeEach, describe, expect, it, vi } from 'vitest';

const routes = vi.hoisted(() => ({
  copilot: [] as unknown[][],
  account: [] as unknown[][],
}));

vi.mock('../copilot-route-preflight', () => ({
  attachCopilotRoute: vi.fn(async (...args: unknown[]) => { routes.copilot.push(args); return args[1]; }),
}));
vi.mock('../account-route-preflight', () => ({
  attachAccountRoute: vi.fn(async (...args: unknown[]) => { routes.account.push(args); return args[1]; }),
}));

import type { InstanceCreateConfig } from '../../../../shared/types/instance.types';
import { InstanceSpawnPreflightChain } from '../instance-spawn-preflight-chain';

function prepare(config: Partial<InstanceCreateConfig>, instanceFields: { accountPreferences?: { avoid: string[]; last: string[] } } = {}) {
  const chain = new InstanceSpawnPreflightChain({
    consumeWarmAdapter: vi.fn(),
    assertLocalModelRuntimeAvailable: vi.fn().mockResolvedValue(undefined),
    warmCodememWorkspace: vi.fn().mockResolvedValue(undefined),
  });
  return chain.prepare({
    config: { workingDirectory: '/tmp/project', provider: 'claude', ...config },
    instance: { workingDirectory: '/tmp/project', bareMode: false, ...instanceFields },
    provider: 'claude',
    spawnOptions: { sessionId: 's', workingDirectory: '/tmp/project', resume: true },
  });
}

beforeEach(() => {
  routes.copilot.length = 0;
  routes.account.length = 0;
});

describe('InstanceSpawnPreflightChain — account routing origin and fence', () => {
  it('routes a session James opens as interactive, with no fence', async () => {
    await prepare({});
    expect(routes.copilot[0]?.[2]).toBe('interactive');
    expect(routes.account[0]?.[2]).toBe('interactive');
    expect(routes.account[0]?.[3]).toMatchObject({ restrictTo: undefined });
  });

  it('routes an automation run as automatic work', async () => {
    await prepare({ metadata: { automationId: 'a-1' } });
    expect(routes.account[0]?.[2]).toBe('automation');
  });

  it('uses the create config\'s origin and account fence (Plan Queue sessions)', async () => {
    await prepare({ accountRouteOrigin: 'verification', allowedAccountProfileIds: ['max-b'] });
    expect(routes.copilot[0]?.[2]).toBe('verification');
    expect(routes.account[0]?.[2]).toBe('verification');
    expect(routes.account[0]?.[3]).toMatchObject({ restrictTo: ['max-b'] });
  });

  it('passes the account preferences to the pool and Copilot routes (Plan Queue never-use and use-last)', async () => {
    await prepare({ accountRouteOrigin: 'automation' }, { accountPreferences: { avoid: ['max-a'], last: ['max-b'] } });
    expect(routes.account[0]?.[3]).toMatchObject({ preferences: { avoid: ['max-a'], last: ['max-b'] } });
    expect(routes.copilot[0]?.[3]).toMatchObject({ avoidProfileIds: ['max-a'] });
  });

  it('reads the live instance\'s preferences, not the create config snapshot, so a rule saved during init still applies', async () => {
    await prepare({ accountRouteOrigin: 'automation', accountPreferences: { avoid: ['max-a'], last: [] } });
    expect(routes.account[0]?.[3]).toMatchObject({ preferences: undefined });
    expect(routes.copilot[0]?.[3]).toMatchObject({ avoidProfileIds: undefined });
  });
});
