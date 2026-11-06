import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  capturedOptions: [] as Record<string, unknown>[],
  cliType: 'claude',
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({ defaultCli: 'claude' }) }),
}));
vi.mock('../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: () => ({
    createAdapter: ({ options }: { options: Record<string, unknown> }) => {
      state.capturedOptions.push(options);
      return {
        spawn: vi.fn(async () => undefined),
        sendMessage: vi.fn(async () => ({ content: 'a verdict', role: 'assistant' })),
        terminate: vi.fn(async () => undefined),
        on: vi.fn(),
        off: vi.fn(),
        removeListener: vi.fn(),
      };
    },
  }),
}));
vi.mock('../instance/lifecycle/provider-route-preflight', () => ({
  attachProviderRoutes: vi.fn(async (_cli: string, options: unknown) => options),
}));
vi.mock('../cli/adapters/adapter-factory', () => ({
  resolveCliType: vi.fn(async () => state.cliType),
}));
vi.mock('../review/copilot-model-entitlements', () => ({
  learnFromCheckerFailure: vi.fn(),
}));
vi.mock('./verification-cache', () => ({
  getVerificationCache: () => ({
    get: vi.fn(),
    set: vi.fn(),
  }),
}));
vi.mock('../cli/cli-detection', () => ({
  CliDetectionService: {
    getInstance: () => ({ detectAll: async () => ({ available: [{ name: 'claude' }, { name: 'codex' }] }) }),
  },
  isCliAvailable: vi.fn(async () => ({ installed: true })),
}));

import { ConsensusCoordinator } from './consensus-coordinator';
import { MultiVerifyCoordinator } from './multi-verify-coordinator';
import type { ConsensusProviderSpec } from './consensus.types';

type QueryProvider = (
  queryId: string,
  spec: ConsensusProviderSpec,
  question: string,
  context: string | undefined,
  workingDirectory: string,
  timeoutMs: number,
  isAborted: () => boolean,
) => Promise<{ success: boolean }>;

type SynthesizeMerge = (
  request: { prompt: string },
  responses: unknown[],
  analysis: {
    agreements: unknown[];
    disagreements: unknown[];
    uniqueInsights: unknown[];
    outlierAgents: unknown[];
    consensusStrength: number;
  },
) => Promise<{ synthesizedResponse: string }>;

const EMPTY_ANALYSIS = {
  agreements: [], disagreements: [], uniqueInsights: [], outlierAgents: [], consensusStrength: 0.5,
};

describe('reviewer spawn options carry the read-only Claude profile (plan Step 4 item 4)', () => {
  beforeEach(() => {
    state.capturedOptions = [];
    state.cliType = 'claude';
    ConsensusCoordinator._resetForTesting();
  });

  async function runConsensus(provider: 'claude' | 'codex') {
    const coordinator = ConsensusCoordinator.getInstance();
    // The response collection is not under test here, only the spawn options.
    (coordinator as unknown as { collectResponse: unknown }).collectResponse = vi.fn(async () => 'a verdict');
    const queryProvider = (coordinator as unknown as { queryProvider: QueryProvider }).queryProvider.bind(coordinator);
    return queryProvider('q1', { provider }, 'question', undefined, process.cwd(), 5_000, () => false);
  }

  it('consensus fan-out gives a Claude reviewer readOnlyReview and never auto-approves', async () => {
    const response = await runConsensus('claude');
    expect(response.success).toBe(true);
    expect(state.capturedOptions[0]).toMatchObject({ readOnlyReview: true, yoloMode: false });
  });

  it('consensus fan-out does not ask a Codex reviewer for the Claude-only profile', async () => {
    await runConsensus('codex');
    expect(state.capturedOptions[0]['readOnlyReview']).not.toBe(true);
    expect(state.capturedOptions[0]['yoloMode']).toBe(false);
  });

  it('multi-verify merge synthesis gives a Claude reviewer readOnlyReview and never auto-approves', async () => {
    const coordinator = MultiVerifyCoordinator.getInstance();
    const synthesizeMerge = (coordinator as unknown as { synthesizeMerge: SynthesizeMerge })
      .synthesizeMerge.bind(coordinator);
    const result = await synthesizeMerge({ prompt: 'the question' }, [], EMPTY_ANALYSIS);
    expect(result.synthesizedResponse).toBe('a verdict');
    expect(state.capturedOptions[0]).toMatchObject({ readOnlyReview: true, yoloMode: false });
  });
});
