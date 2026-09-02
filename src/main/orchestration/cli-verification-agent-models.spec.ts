import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Guards the WS9 wiring seam: the model the checking policy chooses must reach
 * `createCliProvider` as a `defaultModel` override.
 *
 * This is here because the first WS9 implementation was a no-op that looked
 * finished — the policy computed nothing and nothing noticed. A regression at
 * this exact call site would be equally silent, since the panel would still
 * spawn N agents and still produce a verdict.
 */
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({
      // claude and cursor both on Anthropic: the collision the policy breaks up.
      crossModelReviewModelByProvider: {
        claude: 'opus',
        cursor: 'claude-opus-5-thinking-high',
      },
      copilotAccountProfiles: [],
      copilotAccountRoutingRules: [],
    }),
  }),
}));

import { CliVerificationCoordinator } from './cli-verification-extension';
import { modelFamily } from '../../shared/models/model-family';

interface CliInfoLike {
  name: string;
  displayName: string;
  command: string;
  installed: boolean;
}

function cli(name: string): CliInfoLike {
  return { name, displayName: name, command: name, installed: true };
}

describe('verification agent model wiring', () => {
  let createCliProvider: ReturnType<typeof vi.fn>;
  let coordinator: { selectAgents: (c: unknown, clis: unknown[]) => Promise<unknown[]> };

  beforeEach(() => {
    createCliProvider = vi.fn(() => ({ initialize: vi.fn(), terminate: vi.fn() }));
    const instance = CliVerificationCoordinator.getInstance() as unknown as {
      registry: unknown;
      selectAgents: (c: unknown, clis: unknown[]) => Promise<unknown[]>;
    };
    instance.registry = {
      createCliProvider,
      createProvider: vi.fn(),
      isSupported: () => false,
      getEnabledProviders: () => [],
    };
    coordinator = instance;
  });

  it('passes the policy-chosen model to createCliProvider as defaultModel', async () => {
    await coordinator.selectAgents(
      { agentCount: 2, cliAgents: ['claude', 'cursor'] },
      [cli('claude'), cli('cursor')],
    );

    const byCli = new Map<string, unknown>(
      createCliProvider.mock.calls.map((call) => [call[0] as string, call[1]]),
    );
    // claude claims Anthropic first and is left alone.
    expect(byCli.get('claude')).toBeUndefined();
    // cursor collided, so it must arrive with a different-vendor model.
    const cursorOverride = byCli.get('cursor') as { defaultModel?: string } | undefined;
    expect(cursorOverride?.defaultModel).toBeDefined();
    expect(modelFamily(cursorOverride?.defaultModel)).not.toBe('anthropic');
  });

  it('records the chosen model on the agent for provenance', async () => {
    const agents = await coordinator.selectAgents(
      { agentCount: 2, cliAgents: ['claude', 'cursor'] },
      [cli('claude'), cli('cursor')],
    ) as Array<{ name: string; model?: string }>;

    const cursorAgent = agents.find((agent) => agent.name === 'cursor');
    expect(cursorAgent?.model).toBeDefined();
  });
});

describe('verification refusal learning', () => {
  it('teaches the entitlement cache when an agent fails on a refused model', async () => {
    // Without this, the assigner re-picks the same dead model on every future
    // panel — the "re-picked forever" failure every other checking surface
    // already guards against.
    const entitlements = await import('../review/copilot-model-entitlements');
    entitlements._resetCopilotEntitlementsForTesting();

    const message = 'Error: Model "grok-4.6" from --model flag is not available.';
    entitlements.learnFromCheckerFailure(undefined, message);

    // The assigner reads through the same unscoped bucket this surface writes.
    expect(entitlements.isModelKnownUnavailable(undefined, 'grok-4.6')).toBe(true);
    entitlements._resetCopilotEntitlementsForTesting();
  });

  it('learns from a real agent failure through runAgent, not just by inspection', async () => {
    const entitlements = await import('../review/copilot-model-entitlements');
    entitlements._resetCopilotEntitlementsForTesting();

    const instance = CliVerificationCoordinator.getInstance() as unknown as {
      runAgent: (req: unknown, agent: unknown, index: number, session: unknown) => Promise<unknown>;
    };
    const failingAgent = {
      type: 'cli' as const,
      name: 'copilot',
      provider: {
        // The seat refuses the model the assigner chose.
        initialize: vi.fn(async () => {
          throw new Error('Error: Model "grok-4.6" from --model flag is not available.');
        }),
        terminate: vi.fn(),
      },
    };

    await instance.runAgent(
      { id: 'req-1', prompt: 'check this' },
      failingAgent,
      0,
      { cancelled: false, providers: new Map() },
    );

    expect(entitlements.isModelKnownUnavailable(undefined, 'grok-4.6')).toBe(true);
    entitlements._resetCopilotEntitlementsForTesting();
  });
});

/**
 * The assigner is stateful and order-dependent, so an agent that is SKIPPED must
 * not consume a family slot it never used. This item has twice shipped something
 * that looked wired and wasn't, so this is pinned permanently rather than left
 * to source reading.
 */
describe('skipped agents do not consume a diversity slot', () => {
  let createCliProvider: ReturnType<typeof vi.fn>;
  let coordinator: { selectAgents: (c: unknown, clis: unknown[]) => Promise<unknown[]> };

  beforeEach(() => {
    createCliProvider = vi.fn(() => ({ initialize: vi.fn(), terminate: vi.fn() }));
    const instance = CliVerificationCoordinator.getInstance() as unknown as {
      registry: unknown;
      selectAgents: (c: unknown, clis: unknown[]) => Promise<unknown[]>;
    };
    instance.registry = {
      createCliProvider,
      createProvider: vi.fn(),
      isSupported: () => false,
      getEnabledProviders: () => [],
    };
    coordinator = instance;
  });

  async function cursorModelFor(cliAgents: string[], clis: CliInfoLike[]): Promise<string | undefined> {
    createCliProvider.mockClear();
    await coordinator.selectAgents({ agentCount: 3, cliAgents }, clis);
    const call = createCliProvider.mock.calls.find((c) => c[0] === 'cursor');
    return (call?.[1] as { defaultModel?: string } | undefined)?.defaultModel;
  }

  it('gives cursor the same model whether or not an uninstalled CLI precedes it', async () => {
    const baseline = await cursorModelFor(['claude', 'cursor'], [cli('claude'), cli('cursor')]);

    const withSkip = await cursorModelFor(
      ['ghost', 'claude', 'cursor'],
      // `ghost` is requested but not installed, and API fallback is off by
      // default here, so it is skipped before the assigner is ever consulted.
      [cli('claude'), cli('cursor')],
    );

    expect(baseline).toBeDefined();
    expect(withSkip).toBe(baseline);
  });
});
