import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../providers/automation-provider-exclusions', () => ({
  filterProvidersForAutomation: (providers: string[]) => providers.filter((p) => !excluded.has(p)),
}));

let excluded = new Set<string>();
const openScope = () => ({ kind: 'open' }) as never;

import { selectPlanQueueVerifier } from './plan-queue-verifier-select';

beforeEach(() => {
  excluded = new Set();
});

describe('selectPlanQueueVerifier', () => {
  const base = { workingDirectory: '/repo' };

  it('never picks the worker provider', async () => {
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'codex' },
      { listInstalledProviders: async () => ['codex', 'claude'], classifyScope: openScope, resolveProviderModel: () => undefined },
    );
    expect(result).toEqual({ ok: true, choice: { provider: 'claude' } });
  });

  it('prefers codex for a claude worker', async () => {
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'claude' },
      { listInstalledProviders: async () => ['claude', 'copilot', 'codex'], classifyScope: openScope, resolveProviderModel: () => undefined },
    );
    expect(result.ok && result.choice.provider).toBe('codex');
  });

  it('refuses rather than falling back to the worker provider', async () => {
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'claude' },
      { listInstalledProviders: async () => ['claude'], classifyScope: openScope },
    );
    expect(result.ok).toBe(false);
  });

  it('honours the automation exclusion list', async () => {
    excluded = new Set(['copilot']);
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'claude' },
      { listInstalledProviders: async () => ['claude', 'copilot'], classifyScope: openScope },
    );
    expect(result.ok).toBe(false);
  });

  it('parks when the licence scope blocks checking', async () => {
    const result = await selectPlanQueueVerifier(
      { ...base, workerProvider: 'claude' },
      {
        listInstalledProviders: async () => ['claude', 'codex'],
        classifyScope: () => ({ kind: 'indeterminate', reason: 'routing unavailable' }) as never,
      },
    );
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('licence boundary') });
  });
});
