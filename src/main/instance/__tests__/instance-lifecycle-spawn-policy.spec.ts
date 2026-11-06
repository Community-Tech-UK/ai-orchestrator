/**
 * Plan 1b item 4 / Step 4 item 2 (review W1): `createRuntimeAdapter` in
 * `instance-lifecycle.ts` is the only production caller of
 * `applyInstanceSpawnPolicy`. This drives the REAL
 * `InstanceLifecycleManager.createInstance()` and reads the options that reach
 * `createAdapter`, so swapping that call for the plain
 * `applyProviderSessionDurability` (which stamps none of these) fails here.
 *
 * Metadata shapes are the ones the real spawners write
 * (`plan-queue-item-flow.ts` worker create and `reviewer-session-spawner.ts`
 * ping-pong reviewer create). Only the settings reader behind the context
 * ceiling is replaced: its default reader loads the settings manager with a bare
 * `require()`, which vitest does not route through `vi.mock` (same note as
 * `adapter-factory-context-ceiling.spec.ts`). The clamp itself is the real one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceCreateConfig } from '../../../shared/types/instance.types';
import { getDefaultAgent } from '../../../shared/types/agent.types';
import { CLAUDE_REVIEWER_MAX_TURNS } from '../../cli/adapters/claude-machine-session-policy';
import { getMocks, makeFakeAdapter, makeHarness } from './instance-lifecycle-source-diagnostics.fixture';

const ceilings = vi.hoisted(() => ({
  machineContextCeilingTokens: 300_000,
  ownChatContextCeilingTokens: 200_000,
} as Record<string, unknown>));

vi.mock('../../cli/adapters/context-ceiling', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../cli/adapters/context-ceiling')>();
  return {
    ...actual,
    resolveContextCeilingTokens: (machineSession: boolean) =>
      actual.resolveContextCeilingTokens(machineSession, (key) => ceilings[key]),
  };
});

const mocks = getMocks();
type Harness = ReturnType<typeof makeHarness>;

function spawnOptionsOfLastCreate(): Record<string, unknown> {
  const call = mocks.createAdapter.mock.calls.at(-1)?.[0] as { options: Record<string, unknown> } | undefined;
  expect(call).toBeDefined();
  return call!.options;
}

describe('InstanceLifecycleManager stamps the spawn policy on the options handed to createAdapter', () => {
  let harness: Harness;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAdapter.mockReset();
    mocks.resolveCliType.mockResolvedValue('claude');
    mocks.resolveAgent.mockResolvedValue(getDefaultAgent());
    mocks.supervisorRegister.mockReturnValue({ supervisorNodeId: 'sup-1', workerNodeId: 'worker-1' });
    mocks.maybeGenerateTitle.mockResolvedValue(undefined);
    mocks.localModelInventory.length = 0;
    mocks.localModelRefresh.mockResolvedValue(mocks.localModelInventory);
    mocks.getProviderCapabilities.mockReturnValue({
      supportsResume: true,
      supportsForkSession: false,
      supportsNativeCompaction: false,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
      selfManagedAutoCompaction: false,
    });
    mocks.continuityStartTracking.mockResolvedValue(undefined);
    mocks.continuityResumeSession.mockResolvedValue(null);
    mocks.evaluateResumeHealth.mockResolvedValue('healthy');
    mocks.resolveExecutionLocation.mockReturnValue({ type: 'local' });
    mocks.getKnownModelsForCli.mockResolvedValue([]);
    mocks.settings.defaultModel = undefined;
    mocks.settings.defaultModelByProvider = {};
    ceilings['machineContextCeilingTokens'] = 300_000;
    ceilings['ownChatContextCeilingTokens'] = 200_000;
    harness = makeHarness();
    mocks.createAdapter.mockReturnValue(makeFakeAdapter());
  });
  afterEach(() => harness.manager.destroy());

  async function create(config: Partial<InstanceCreateConfig>) {
    const instance = await harness.manager.createInstance({ workingDirectory: '/tmp/project', provider: 'claude', ...config });
    await instance.readyPromise;
    return instance;
  }

  it('a plan-queue worker gets plan-queue kind, its item as trial key and the machine ceiling', async () => {
    const instance = await create({
      yoloMode: true,
      metadata: { planQueueRunId: 'run-fixture-1', planQueueItemId: 'item-fixture-1', planQueueRole: 'worker' },
    });
    expect(spawnOptionsOfLastCreate()).toMatchObject({
      instanceId: instance.id,
      sessionKind: 'plan-queue',
      machineSession: 'plan-queue',
      trialKey: 'item-fixture-1',
      trialKeySource: 'plan-queue-item',
      contextCeilingTokens: 300_000,
    });
    expect(spawnOptionsOfLastCreate()['readOnlyReview']).toBeUndefined();
  });

  it('a Claude ping-pong reviewer is read-only, never auto-approve, turn-capped and on the machine ceiling', async () => {
    const instance = await create({
      agentId: 'review',
      yoloMode: true,
      launchMode: 'orchestrated',
      metadata: { spendPurpose: 'review', pingPongReviewer: true, spawnedAt: 1, hideFromProjectRail: true },
    });
    expect(spawnOptionsOfLastCreate()).toMatchObject({
      instanceId: instance.id,
      sessionKind: 'review',
      machineSession: 'ping-pong-review',
      trialKey: instance.id,
      trialKeySource: 'instance',
      readOnlyReview: true,
      yoloMode: false,
      maxTurns: CLAUDE_REVIEWER_MAX_TURNS,
      contextCeilingTokens: 300_000,
    });
  });

  it('a Codex ping-pong reviewer is classed as a review but keeps its tools and has no Claude ceiling', async () => {
    mocks.resolveCliType.mockResolvedValue('codex');
    await create({
      provider: 'codex',
      yoloMode: true,
      metadata: { spendPurpose: 'review', pingPongReviewer: true, spawnedAt: 1, hideFromProjectRail: true },
    });
    const options = spawnOptionsOfLastCreate();
    expect(options).toMatchObject({ sessionKind: 'review', machineSession: 'ping-pong-review', yoloMode: true });
    expect(options['readOnlyReview']).toBeUndefined();
    expect(options['contextCeilingTokens']).toBeUndefined();
  });

  it("a person's own chat is a chat with no machine stamp and the own-chat ceiling", async () => {
    await create({});
    const options = spawnOptionsOfLastCreate();
    expect(options).toMatchObject({ sessionKind: 'chat', contextCeilingTokens: 200_000 });
    expect(options['machineSession']).toBeUndefined();
    expect(options['readOnlyReview']).toBeUndefined();
  });

  it('a zero machine ceiling setting leaves the provider default (no ceiling is passed)', async () => {
    ceilings['machineContextCeilingTokens'] = 0;
    await create({ metadata: { planQueueRunId: 'run-fixture-2', planQueueItemId: 'item-fixture-2', planQueueRole: 'worker' } });
    expect(spawnOptionsOfLastCreate()).toMatchObject({ sessionKind: 'plan-queue', machineSession: 'plan-queue' });
    expect(spawnOptionsOfLastCreate()['contextCeilingTokens']).toBeUndefined();
  });
});
