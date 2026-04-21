import Module from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  agentRegistry,
  getAgentById,
  getDefaultAgent,
  settingsManager,
  supervisorTree,
  sessionContinuityManager,
  permissionManager,
  memoryMonitor,
} = vi.hoisted(() => ({
  agentRegistry: {
    resolveAgent: vi.fn(),
  },
  getAgentById: vi.fn(),
  getDefaultAgent: vi.fn(),
  settingsManager: {
    getAll: vi.fn(),
  },
  supervisorTree: {
    registerInstance: vi.fn(),
    unregisterInstance: vi.fn(),
  },
  sessionContinuityManager: {
    updateState: vi.fn(),
    createSnapshot: vi.fn(),
  },
  permissionManager: {
    loadProjectRules: vi.fn(),
  },
  memoryMonitor: {
    getPressureLevel: vi.fn(),
  },
}));

import { productionCoreDeps } from '../instance-deps';

describe('productionCoreDeps', () => {
  const requireImpl = Module.prototype.require;
  let requireSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    requireSpy = vi.spyOn(Module.prototype, 'require').mockImplementation(function mockRequire(id: string) {
      switch (id) {
        case '../agents/agent-registry':
          return { getAgentRegistry: () => agentRegistry };
        case '../../shared/types/agent.types':
          return { getAgentById, getDefaultAgent };
        case '../core/config/settings-manager':
          return { getSettingsManager: () => settingsManager };
        case '../process':
          return { getSupervisorTree: () => supervisorTree };
        case '../session/session-continuity':
          return { getSessionContinuityManager: () => sessionContinuityManager };
        case '../security/permission-manager':
          return { getPermissionManager: () => permissionManager };
        case '../memory':
          return { getMemoryMonitor: () => memoryMonitor };
        default:
          return requireImpl.apply(this, [id]);
      }
    });

    agentRegistry.resolveAgent.mockResolvedValue({ id: 'resolved-agent' });
    getAgentById.mockReturnValue({ id: 'lookup-agent' });
    getDefaultAgent.mockReturnValue({ id: 'default-agent' });
    settingsManager.getAll.mockReturnValue({ theme: 'dark' });
    sessionContinuityManager.createSnapshot.mockResolvedValue({ id: 'snap-1' });
    permissionManager.loadProjectRules.mockResolvedValue([{ id: 'rule-1' }]);
    memoryMonitor.getPressureLevel.mockReturnValue('normal');
  });

  afterEach(() => {
    requireSpy.mockRestore();
  });

  it('delegates agent lookups and resolution', async () => {
    const deps = productionCoreDeps();

    await expect(deps.agents.resolveAgent('builder', '/tmp/project')).resolves.toEqual({
      id: 'resolved-agent',
    });
    expect(agentRegistry.resolveAgent).toHaveBeenCalledWith('/tmp/project', 'builder');

    expect(deps.agents.getAgentById('lookup-agent')).toEqual({ id: 'lookup-agent' });
    expect(getAgentById).toHaveBeenCalledWith('lookup-agent');

    expect(deps.agents.getDefaultAgent()).toEqual({ id: 'default-agent' });
    expect(getDefaultAgent).toHaveBeenCalledTimes(1);
  });

  it('delegates settings and supervision operations', () => {
    const deps = productionCoreDeps();

    expect(deps.settings.getAll()).toEqual({ theme: 'dark' });
    expect(settingsManager.getAll).toHaveBeenCalledTimes(1);

    deps.supervision.registerInstance('inst-1', 'parent-1');
    expect(supervisorTree.registerInstance).toHaveBeenCalledWith('inst-1', 'parent-1', '', 'inst-1');

    deps.supervision.unregisterInstance('inst-1');
    expect(supervisorTree.unregisterInstance).toHaveBeenCalledWith('inst-1');
  });

  it('delegates session persistence and normalizes snapshot ids', async () => {
    const deps = productionCoreDeps();
    const state = { status: 'running' };

    deps.session.updateState('inst-1', state);
    expect(sessionContinuityManager.updateState).toHaveBeenCalledWith('inst-1', state);

    await expect(
      deps.session.createSnapshot('inst-1', 'Checkpoint', 'manual snapshot', 'manual'),
    ).resolves.toBe('snap-1');
    expect(sessionContinuityManager.createSnapshot).toHaveBeenCalledWith(
      'inst-1',
      'Checkpoint',
      'manual snapshot',
      'manual',
    );

    sessionContinuityManager.createSnapshot.mockResolvedValueOnce(undefined);
    await expect(
      deps.session.createSnapshot('inst-1', 'Checkpoint', 'manual snapshot', 'manual'),
    ).resolves.toBe('');
  });

  it('delegates permissions, memory pressure, and preserves the documented no-op behaviors', async () => {
    const deps = productionCoreDeps();

    await expect(deps.permissions.loadProjectRules('/tmp/project')).resolves.toEqual([]);
    expect(permissionManager.loadProjectRules).toHaveBeenCalledWith('/tmp/project');

    expect(deps.observation.buildContext('inst-1')).toBe('');
    expect(deps.memory.getCurrentPressure()).toBe('normal');
    expect(memoryMonitor.getPressureLevel).toHaveBeenCalledTimes(1);

    expect(() => deps.history.addThread('inst-1')).not.toThrow();
  });
});
