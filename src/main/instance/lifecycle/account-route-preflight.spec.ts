import { readdirSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../providers/account-pool/provider-account-routing-service', () => ({
  getProviderAccountRoutingService: () => {
    throw new Error('the injected routing service must be used');
  },
}));

import {
  AccountRoutingError,
  attachAccountRoute,
  stampAccountRouteOnInstance,
} from './account-route-preflight';
import type { ProviderAccountRoutingService } from '../../providers/account-pool/provider-account-routing-service';
import type { AccountRouteOutcome } from '../../../shared/types/provider-account.types';

function serviceReturning(outcome: AccountRouteOutcome) {
  const resolveRouteForSpawn = vi.fn(async () => outcome);
  return { resolveRouteForSpawn, service: { resolveRouteForSpawn } as unknown as ProviderAccountRoutingService };
}

describe('attachAccountRoute', () => {
  it('is a no-op for providers without pools', async () => {
    const { service, resolveRouteForSpawn } = serviceReturning({ ok: false, code: 'no-profiles', detail: 'x' });
    const options = { workingDirectory: '/w' };
    await expect(attachAccountRoute('copilot', options, 'interactive', { routingService: service })).resolves.toBe(options);
    expect(resolveRouteForSpawn).not.toHaveBeenCalled();
  });

  it('keeps an attached route and leaves options untouched without a pool', async () => {
    const route = { provider: 'claude' as const, profileId: 'max-b', source: 'persisted' as const, executionNodeId: 'local' };
    const { service, resolveRouteForSpawn } = serviceReturning({
      ok: true,
      route: { provider: 'claude', profileId: 'legacy', source: 'legacy', executionNodeId: 'local' },
    });
    const attached = { accountRoute: route };
    await expect(attachAccountRoute('claude', attached, 'interactive', { routingService: service })).resolves.toBe(attached);
    const plain = { workingDirectory: '/w' };
    await expect(attachAccountRoute('claude', plain, 'interactive', { routingService: service })).resolves.toBe(plain);
    expect(resolveRouteForSpawn).toHaveBeenCalledTimes(1);
  });

  it('attaches a pool route and forwards the request shape', async () => {
    const route = { provider: 'codex' as const, profileId: 'pro-b', source: 'explicit' as const, executionNodeId: 'node-1' };
    const { service, resolveRouteForSpawn } = serviceReturning({ ok: true, route });
    const result = await attachAccountRoute('codex', { model: 'gpt-x', resume: true }, 'loop', {
      routingService: service,
      persistedProfileId: 'pro-b',
      executionNodeId: 'node-1',
      instanceId: 'inst-1',
    });
    expect(result.accountRoute).toEqual(route);
    expect(resolveRouteForSpawn).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'codex', model: 'gpt-x', persistedProfileId: 'pro-b', origin: 'loop', executionNodeId: 'node-1', newSession: false, instanceId: 'inst-1',
    }));
  });

  it('throws a typed error on failure', async () => {
    const { service } = serviceReturning({ ok: false, code: 'profile-unauthenticated', detail: 'sign in', profileId: 'max-b' });
    const error = await attachAccountRoute('claude', {}, 'interactive', { routingService: service }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AccountRoutingError);
    expect(error).toMatchObject({ code: 'profile-unauthenticated', profileId: 'max-b', message: 'sign in' });
  });

  it('stamps first-class instance fields', () => {
    const instance: { accountProfileId?: string; accountRoutingSource?: string } = {};
    stampAccountRouteOnInstance(instance as never, {
      accountRoute: { provider: 'claude', profileId: 'max-b', source: 'default', executionNodeId: 'local' },
    });
    expect(instance).toEqual({ accountProfileId: 'max-b', accountRoutingSource: 'default' });
  });
});

/**
 * Static backstop beside the factory's synchronous throw: every production
 * file that can construct a Claude or Codex adapter either routes through the
 * account preflight or is classified with a reason.
 */
describe('Claude/Codex account-pool spawn-path bypass detection', () => {
  const REPO_ROOT = resolve(__dirname, '../../../..');
  const ROUTED: Record<string, string> = {
    'src/main/instance/instance-lifecycle.ts': 'attachAccountRoute',
    'src/main/orchestration/default-invokers.ts': 'attachProviderRoutes',
    'src/main/orchestration/default-loop-invoker-helpers.ts': 'attachProviderRoutes',
    'src/main/orchestration/cross-model-review-service.ts': 'attachProviderRoutes',
    'src/main/orchestration/consensus-coordinator.ts': 'attachProviderRoutes',
    'src/main/orchestration/multi-verify-coordinator.ts': 'attachProviderRoutes',
    'src/main/instance/auto-title-service.ts': 'attachProviderRoutes',
    'src/main/magic-prompts/magic-prompt-service.ts': 'attachProviderRoutes',
    'src/main/compare/council-provider-invoke.ts': 'attachProviderRoutes',
    'src/main/review/review-execution-host.ts': 'attachProviderRoutes',
    'src/main/providers/claude-cli-provider.ts': 'attachAccountRoute',
    'src/main/providers/codex-cli-provider.ts': 'attachAccountRoute',
  };
  const EXEMPT: Record<string, string> = {
    'src/main/cli/adapters/adapter-factory.ts': 'The factory itself — it enforces the route rather than resolving it.',
    'src/main/providers/provider-runtime-service.ts': 'Thin delegation to the factory; every caller routes first.',
    'src/main/instance/instance-manager.ts': 'Warm-start callback only; warm-start-manager never pre-warms a pooled provider.',
    'src/main/instance/lifecycle/deferred-permission-handler.ts': 'Calls the instance-lifecycle adapter creator, which routes.',
    'src/main/providers/codex-cli-discovery-service.ts': 'Model listing only on the legacy sign-in; issues no conversation request.',
    'src/worker-agent/local-instance-manager.ts': 'Worker node: re-materialises the RPC route and verifies its local binding.',
  };
  const PATTERNS = ['createAdapter({', 'createCliAdapter(', 'createClaudeAdapter(', 'createCodexAdapter(', 'new ClaudeCliAdapter(', 'new CodexCliAdapter('];

  const walk = (dir: string, out: string[] = []): string[] => {
    for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel, out);
      else if (entry.name.endsWith('.ts')) out.push(rel);
    }
    return out;
  };

  it('routes every listed call site', () => {
    for (const [file, marker] of Object.entries(ROUTED)) {
      expect(readFileSync(join(REPO_ROOT, file), 'utf8'), file).toContain(marker);
    }
  });

  it('has no unclassified Claude/Codex adapter-creating file', () => {
    const found = [...walk('src/main'), ...walk('src/worker-agent')]
      .filter((file) => !file.includes('.spec.') && !file.includes('__tests__'))
      .filter((file) => {
        const source = readFileSync(join(REPO_ROOT, file), 'utf8').replace(/\s+/g, '');
        return PATTERNS.some((pattern) => source.includes(pattern));
      });
    expect(found.length).toBeGreaterThanOrEqual(10);
    const known = new Set([...Object.keys(ROUTED), ...Object.keys(EXEMPT)]);
    expect(found.filter((file) => !known.has(file))).toEqual([]);
  });
});
