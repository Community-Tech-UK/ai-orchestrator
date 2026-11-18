/**
 * `spawn_child` with `hardened:true`: the request must reach child creation intact, must never be answered by the
 * search shortcut (which would skip the jailed session entirely), and the parent must be able to read the flag back.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Instance } from '../../../shared/types/instance.types';
import type { SpawnChildCommand } from '../../orchestration/orchestration-protocol.types';
import type { ChildInfo } from '../../orchestration/orchestration-handler.types';
import { InstanceOrchestrationManager } from '../instance-orchestration';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../memory', () => ({ getUnifiedMemory: () => ({ recordTaskOutcome: vi.fn() }) }));
vi.mock('../../learning/outcome-tracker', () => ({
  OutcomeTracker: { getInstance: () => ({ recordOutcome: vi.fn() }) },
}));
vi.mock('../../learning/strategy-learner', () => ({
  StrategyLearner: { getInstance: () => ({ getRecommendation: vi.fn(() => null) }) },
}));
vi.mock('../../learning/preference-store', () => ({ getPreferenceStore: () => ({ get: vi.fn(() => undefined) }) }));

const SETTINGS = { maxTotalInstances: 0, maxChildrenPerParent: 0, allowNestedOrchestration: false, maxSpawnDepth: 0 };
const RETRIEVAL_TASK = 'find all usages of the readSession function';

function instance(fields: Partial<Instance>): Instance {
  return { status: 'idle', displayName: 'x', childrenIds: [], outputBuffer: [], workingDirectory: '/repo', depth: 0, ...fields } as unknown as Instance;
}

function setup(instances: Instance[], createChildInstance = vi.fn()) {
  const byId = new Map(instances.map((item) => [item.id, item]));
  const manager = new InstanceOrchestrationManager({
    getInstance: (id) => byId.get(id),
    getInstanceCount: () => byId.size,
    createChildInstance,
    sendInput: vi.fn(),
    terminateInstance: vi.fn(),
    getAdapter: vi.fn(),
    recordTaskOutcome: vi.fn(),
  });
  manager.setupOrchestrationHandlers(SETTINGS, vi.fn(), vi.fn());
  return manager;
}

describe('spawn_child hardened:true in the orchestration manager', () => {
  // The gate checks the host, and these tests run on any host.
  let platformSpy: { mockRestore: () => void } | undefined;
  afterEach(() => { platformSpy?.mockRestore(); platformSpy = undefined; });
  const onPlatform = (platform: NodeJS.Platform): void => {
    platformSpy = vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
  };

  it('reaches child creation with the flag intact, even for a task that looks like a search', async () => {
    onPlatform('darwin');
    const created = instance({ id: 'child-1', parentId: 'parent-1', hardened: true });
    const createChildInstance = vi.fn().mockResolvedValue(created);
    const manager = setup([instance({ id: 'parent-1' }), created], createChildInstance);
    const command: SpawnChildCommand = { action: 'spawn_child', task: RETRIEVAL_TASK, provider: 'codex', hardened: true };

    manager.getOrchestrationHandler().emit('spawn-child', 'parent-1', command);
    await vi.waitFor(() => expect(createChildInstance).toHaveBeenCalledTimes(1));

    expect(createChildInstance.mock.calls[0]?.[1]).toMatchObject({ hardened: true, provider: 'codex' });
  });

  describe('refusals', () => {
    /** What the parent is told when a request is refused: the handler's error notice to the parent. */
    const notifyErrors = (manager: InstanceOrchestrationManager): string[] => {
      const messages: string[] = [];
      vi.spyOn(manager.getOrchestrationHandler(), 'notifyError').mockImplementation((_id: string, message: string) => { messages.push(message); });
      return messages;
    };
    it.each([
      ['a worker computer is named', { provider: 'codex', node: 'windows-pc' }, {}, 'darwin', /remote instances/],
      ['the parent runs on a worker', { provider: 'codex' }, { executionLocation: { type: 'remote', nodeId: 'n1' } }, 'darwin', /remote instances/],
      ['the host is not a Mac', { provider: 'codex' }, {}, 'win32', /needs macOS/],
      ['the provider is not named and the parent has none', {}, {}, 'darwin', /must name its provider/],
      ['the provider was never tested in the jail', { provider: 'gemini' }, {}, 'darwin', /not supported for Gemini/i],
    ] as const)('tells the parent why and creates nothing when %s', async (_why, command, parentFields, platform, message) => {
      onPlatform(platform);
      const createChildInstance = vi.fn();
      const manager = setup([instance({ id: 'parent-1', ...parentFields } as Partial<Instance>)], createChildInstance);
      const errors = notifyErrors(manager);

      manager.getOrchestrationHandler().emit('spawn-child', 'parent-1', { action: 'spawn_child', task: 'Run the probe', hardened: true, ...command });
      await vi.waitFor(() => expect(errors).toHaveLength(1));

      expect(errors[0]).toMatch(/^Cannot spawn child: /);
      expect(errors[0]).toMatch(message);
      expect(createChildInstance).not.toHaveBeenCalled();
    });

    it('lets the same request through on a Mac when it can be honoured', async () => {
      onPlatform('darwin');
      const created = instance({ id: 'child-1', parentId: 'parent-1', hardened: true });
      const createChildInstance = vi.fn().mockResolvedValue(created);
      const manager = setup([instance({ id: 'parent-1', provider: 'codex' } as Partial<Instance>), created], createChildInstance);
      const errors = notifyErrors(manager);

      // No provider on the command: the parent's own provider applies, exactly as it does when the child is created.
      manager.getOrchestrationHandler().emit('spawn-child', 'parent-1', { action: 'spawn_child', task: 'Run the probe', hardened: true });
      await vi.waitFor(() => expect(createChildInstance).toHaveBeenCalledTimes(1));
      expect(errors).toEqual([]);
    });

    it('does not apply to an ordinary spawn on any host', async () => {
      onPlatform('win32');
      const createChildInstance = vi.fn().mockResolvedValue(instance({ id: 'child-1', parentId: 'parent-1' }));
      const manager = setup([instance({ id: 'parent-1' })], createChildInstance);

      manager.getOrchestrationHandler().emit('spawn-child', 'parent-1', { action: 'spawn_child', task: 'Run the probe', node: undefined });
      await vi.waitFor(() => expect(createChildInstance).toHaveBeenCalledTimes(1));
    });
  });

  it('keeps the search shortcut for an ordinary search task, and skips it for a hardened one', () => {
    const manager = setup([instance({ id: 'parent-1' })]);
    const shouldUseFastPath = (command: SpawnChildCommand): boolean =>
      (manager as unknown as { shouldUseFastPath: (c: SpawnChildCommand) => boolean }).shouldUseFastPath(command);

    expect(shouldUseFastPath({ action: 'spawn_child', task: RETRIEVAL_TASK })).toBe(true);
    expect(shouldUseFastPath({ action: 'spawn_child', task: RETRIEVAL_TASK, hardened: false })).toBe(true);
    expect(shouldUseFastPath({ action: 'spawn_child', task: RETRIEVAL_TASK, hardened: true })).toBe(false);
  });

  it('lets the parent read back which children are hardened, and only its own', () => {
    const jailed = instance({ id: 'child-jailed', parentId: 'parent-1', displayName: 'jailed', createdAt: 1, hardened: true });
    const plain = instance({ id: 'child-plain', parentId: 'parent-1', displayName: 'plain', createdAt: 2 });
    const parent = instance({ id: 'parent-1', childrenIds: ['child-jailed', 'child-plain'] });
    const stranger = instance({ id: 'other-child', parentId: 'parent-2', hardened: true });
    const manager = setup([parent, jailed, plain, stranger, instance({ id: 'parent-2', childrenIds: ['other-child'] })]);

    let children: ChildInfo[] = [];
    manager.getOrchestrationHandler().emit('get-children', 'parent-1', (list: ChildInfo[]) => { children = list; });

    expect(children).toEqual([
      { id: 'child-jailed', name: 'jailed', status: 'idle', createdAt: 1, hardened: true },
      { id: 'child-plain', name: 'plain', status: 'idle', createdAt: 2 },
    ]);
  });
});
