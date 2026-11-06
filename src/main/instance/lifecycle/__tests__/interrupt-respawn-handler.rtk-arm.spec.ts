/**
 * Plan 18b item 4: recovery respawns must pass the same RTK spawn config the
 * lifecycle's own spawn sites pass, or an on-arm auto-approve session loses its
 * rewrite-only hook after the first respawn and the trial becomes
 * unmeasurable. Both recovery paths are covered:
 * `respawnAfterInterrupt` and `respawnAfterUnexpectedExit`.
 *
 * The RTK config comes from the REAL `resolveRtkSpawnConfig` (only the rtk
 * binary probe and the hook-script file are faked), the spawn core is the REAL
 * RuntimeReconciler, and the "keeps its hook" assertions run the options that
 * reached the provider runtime through the REAL Claude settings-overlay
 * builder and env builder.
 */
import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../../../cli/adapters/adapter-factory';
import { buildClaudeSettingsOverlay } from '../../../cli/adapters/claude-cli-argv-builder';
import {
  buildClaudeRtkEnv,
  resolveRtkSpawnConfig,
  rtkArmFor,
  stampRtkArm,
  type RtkAutoApproveScope,
  type RtkSpawnConfig,
} from '../../../cli/rtk/rtk-rollout';
import { InterruptRespawnHandler, type InterruptRespawnDeps } from '../interrupt-respawn-handler';
import { RuntimeReconciler } from '../runtime-reconciler';
import type { RuntimeReconcilerDeps } from '../runtime-reconciler.types';
import { applyProviderSessionDurability } from '../provider-session-durability';
import type { Instance } from '../../../../shared/types/instance.types';

const providerRuntime = vi.hoisted(() => ({ createAdapter: vi.fn() }));
const HOOK_PATH = vi.hoisted(() => '/tmp/r4k5/rtk-defer-hook.mjs');

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: () => providerRuntime,
}));
vi.mock('../../../cli/hooks/hook-path-resolver', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../cli/hooks/hook-path-resolver')>()),
  ensureRtkDeferHookScript: () => HOOK_PATH,
}));
vi.mock('../../../cli/rtk/rtk-runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../cli/rtk/rtk-runtime')>();
  return {
    ...actual,
    getRtkRuntime: () => ({
      isAvailable: () => true,
      version: () => '0.51.0',
      binaryPath: () => '/bin/rtk',
      binarySource: () => 'bundled' as const,
      supportsRewrite: () => true,
      rewrite: () => ({ kind: 'passthrough' as const }),
    }),
  };
});

class ReplacementAdapter extends EventEmitter {
  spawn = vi.fn<() => Promise<number>>().mockResolvedValue(777);
  terminate = vi.fn().mockResolvedValue(undefined);
  sendInput = vi.fn().mockResolvedValue(undefined);
  getName(): string { return 'claude-cli'; }
  getSessionId(): string | null { return null; }
  isRunning(): boolean { return true; }
}

class PreviousAdapter extends EventEmitter {
  terminate = vi.fn().mockResolvedValue(undefined);
  getName = vi.fn(() => 'claude-cli');
  isRunning = vi.fn(() => false);
}

function createClaudeYoloInstance(id: string): Instance {
  return {
    id,
    displayName: 'RTK respawn',
    createdAt: Date.now(),
    historyThreadId: `thread-${id}`,
    parentId: null,
    childrenIds: [],
    supervisorNodeId: '',
    depth: 0,
    terminationPolicy: 'terminate-children',
    launchMode: 'orchestrated',
    contextInheritance: {} as Instance['contextInheritance'],
    agentId: 'build',
    agentMode: 'build',
    planMode: { enabled: false, state: 'off' },
    status: 'respawning',
    contextUsage: { used: 0, total: 200000, percentage: 0 },
    lastActivity: Date.now(),
    processId: 1,
    providerSessionId: `provider-${id}`,
    sessionId: `session-${id}`,
    restartEpoch: 0,
    adapterGeneration: 1,
    workingDirectory: '/tmp/project',
    yoloMode: true,
    provider: 'claude',
    executionLocation: { type: 'local' },
    outputBuffer: [],
    outputBufferMaxSize: 1000,
    communicationTokens: new Map(),
    subscribedTo: [],
    totalTokensUsed: 0,
    requestCount: 0,
    errorCount: 0,
    restartCount: 0,
  };
}

type Path = 'interrupt' | 'unexpected-exit';

function buildHandler(
  instance: Instance,
  getRtkSpawnConfig: InterruptRespawnDeps['getRtkSpawnConfig'],
): InterruptRespawnHandler {
  const previous = new PreviousAdapter();
  const deps = {
    getInstance: (id: string) => (id === instance.id ? instance : undefined),
    getAdapter: () => previous as unknown as CliAdapter,
    setAdapter: vi.fn(),
    deleteAdapter: vi.fn(),
    queueUpdate: vi.fn(),
    markInterrupted: vi.fn(),
    clearInterrupted: vi.fn(),
    addToOutputBuffer: vi.fn(),
    setupAdapterEvents: vi.fn(),
    transitionState: (target: Instance, status: Instance['status']) => { target.status = status; },
    getAdapterRuntimeCapabilities: () => ({
      supportsResume: false,
      supportsForkSession: false,
      supportsNativeCompaction: false,
      supportsPermissionPrompts: false,
      supportsDeferPermission: false,
    }),
    resolveCliTypeForInstance: vi.fn().mockResolvedValue('claude'),
    getMcpConfig: () => [],
    getPermissionHookPath: () => undefined,
    waitForResumeHealth: vi.fn().mockResolvedValue(true),
    waitForAdapterWritable: vi.fn().mockResolvedValue(undefined),
    buildReplayContinuityMessage: () => 'replay continuity',
    buildFallbackHistory: vi.fn(),
    applyRecoveryRespawn: undefined as unknown as InterruptRespawnDeps['applyRecoveryRespawn'],
    emitOutput: vi.fn(),
    getRtkSpawnConfig,
  } satisfies InterruptRespawnDeps;
  const reconciler = new RuntimeReconciler({
    getInstance: deps.getInstance,
    setAdapter: deps.setAdapter,
    setupAdapterEvents: deps.setupAdapterEvents,
    createRuntimeAdapter: (cliType: unknown, options: unknown, executionLocation: unknown) =>
      providerRuntime.createAdapter({
        cliType,
        options: applyProviderSessionDurability(
          cliType as Parameters<typeof applyProviderSessionDurability>[0],
          instance,
          options as Parameters<typeof applyProviderSessionDurability>[2],
        ),
        executionLocation,
      }),
    waitForResumeHealth: (id: string) => deps.waitForResumeHealth(id),
    buildFallbackHistory: deps.buildFallbackHistory,
    buildReplayContinuityMessage: deps.buildReplayContinuityMessage,
  } as unknown as RuntimeReconcilerDeps);
  deps.applyRecoveryRespawn = (instanceId, request, hooks) =>
    reconciler.applyRecoveryRespawn(instanceId, request, hooks);
  return new InterruptRespawnHandler(deps);
}

async function respawn(handler: InterruptRespawnHandler, path: Path, instanceId: string): Promise<void> {
  if (path === 'interrupt') await handler.respawnAfterInterrupt(instanceId);
  else await handler.respawnAfterUnexpectedExit(instanceId);
}

/** The spawn options the provider runtime was handed for the replacement CLI. */
function replacementSpawnOptions(): { rtk?: RtkSpawnConfig; yoloMode?: boolean } {
  expect(providerRuntime.createAdapter).toHaveBeenCalledTimes(1);
  return providerRuntime.createAdapter.mock.calls[0][0].options;
}

/** What the lifecycle's own spawn sites pass: the real resolver, per instance id. */
function realRtkConfig(scope: RtkAutoApproveScope): (key?: string) => RtkSpawnConfig | undefined {
  return (key) => resolveRtkSpawnConfig(
    { rtkEnabled: true, rtkBundledOnly: false, rtkAutoApproveScope: scope },
    'session',
    key,
  );
}

/** A fresh key per test: the respawn circuit breaker is keyed on instance id. */
function findKey(scope: RtkAutoApproveScope, arm: 'on' | 'off', salt: string): string {
  for (let i = 0; i < 1000; i += 1) {
    const key = `r4k5-${salt}-${arm}-${i}`;
    if (rtkArmFor(key, scope) === arm) return key;
  }
  throw new Error('no key found');
}

describe.each<Path>(['interrupt', 'unexpected-exit'])('recovery respawn after %s keeps the RTK spawn config', (path) => {
  beforeEach(() => {
    providerRuntime.createAdapter.mockReset();
    providerRuntime.createAdapter.mockImplementation(() => new ReplacementAdapter());
  });

  it('asks for the config by instance id and hands it to the replacement CLI', async () => {
    const instance = createClaudeYoloInstance(`r4k5-key-${path}`);
    const getRtkSpawnConfig = vi.fn(realRtkConfig('on'));

    await respawn(buildHandler(instance, getRtkSpawnConfig), path, instance.id);

    expect(getRtkSpawnConfig).toHaveBeenCalledWith(instance.id);
    expect(replacementSpawnOptions().rtk).toMatchObject({
      enabled: true,
      binaryPath: '/bin/rtk',
      yoloHookPath: HOOK_PATH,
    });
  });

  it('an auto-approve session in the on-arm still has its rewrite-only hook after the respawn', async () => {
    const instance = createClaudeYoloInstance(findKey('trial', 'on', `hook-${path}`));
    // What the original spawn stamped.
    stampRtkArm(instance, realRtkConfig('trial')(instance.id), 'claude', true);
    expect(instance.metadata).toMatchObject({ rtkArm: 'on', rtkTrialEligible: true, rtkTrialKey: instance.id });

    await respawn(buildHandler(instance, realRtkConfig('trial')), path, instance.id);

    const options = replacementSpawnOptions();
    expect(options.rtk).toMatchObject({ rtkArm: 'on', yoloHookPath: HOOK_PATH });
    // Through the real Claude builders: the Bash PreToolUse hook is in the
    // settings overlay and the hook script is told to run rewrite-only.
    const overlay = JSON.parse(buildClaudeSettingsOverlay(options as never, false) ?? '{}');
    expect(overlay.hooks.PreToolUse[0].matcher).toBe('Bash');
    expect(overlay.hooks.PreToolUse[0].hooks[0].command).toContain(HOOK_PATH);
    expect(buildClaudeRtkEnv({ yoloMode: options.yoloMode, rtk: options.rtk })).toMatchObject({
      ORCHESTRATOR_RTK_ENABLED: '1',
      ORCHESTRATOR_RTK_REWRITE_ONLY: '1',
    });
    // The trial stamp survives (the cost rows still carry the group).
    expect(instance.metadata).toMatchObject({ rtkArm: 'on', rtkTrialEligible: true, rtkTrialKey: instance.id });
  });

  it('an off-arm session stays unhooked but is still stamped as the control group', async () => {
    const instance = createClaudeYoloInstance(findKey('trial', 'off', `ctl-${path}`));
    stampRtkArm(instance, realRtkConfig('trial')(instance.id), 'claude', true);

    await respawn(buildHandler(instance, realRtkConfig('trial')), path, instance.id);

    const options = replacementSpawnOptions();
    expect(options.rtk?.yoloHookPath).toBeUndefined();
    expect(options.rtk?.rtkArm).toBe('off');
    expect(JSON.parse(buildClaudeSettingsOverlay(options as never, false) ?? '{}').hooks).toBeUndefined();
    expect(instance.metadata).toMatchObject({ rtkArm: 'off', rtkTrialEligible: true, rtkTrialKey: instance.id });
  });

  it('restamps the arm from the same config, as the lifecycle spawn sites do', async () => {
    const instance = createClaudeYoloInstance(findKey('trial', 'on', `stamp-${path}`));
    expect(instance.metadata).toBeUndefined();

    await respawn(buildHandler(instance, realRtkConfig('trial')), path, instance.id);

    expect(instance.metadata).toMatchObject({ rtkArm: 'on', rtkTrialEligible: true, rtkTrialKey: instance.id });
  });

  it('passes no rtk when RTK is off, exactly as before', async () => {
    const instance = createClaudeYoloInstance(`r4k5-off-${path}`);

    await respawn(buildHandler(instance, () => undefined), path, instance.id);

    expect(replacementSpawnOptions().rtk).toBeUndefined();
    expect(instance.metadata?.['rtkArm']).toBeUndefined();
  });
});
