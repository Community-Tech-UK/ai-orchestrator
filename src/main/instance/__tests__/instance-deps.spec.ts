// src/main/instance/__tests__/instance-deps.spec.ts
import { describe, it, expect, vi } from 'vitest';
import type {
  CoreDeps,
  AgentDeps,
  SettingsDeps,
  SupervisionDeps,
  SessionDeps,
  PermissionDeps,
  ObservationDeps,
  MemoryDeps,
  HistoryDeps,
} from '../instance-deps';

// ── Shape tests ─────────────────────────────────────────────────────────────
// These verify that the interfaces are structurally correct and that
// mock implementations satisfy them — no singleton initialization required.

describe('CoreDeps interfaces', () => {
  it('AgentDeps can be implemented with vi.fn()', () => {
    const deps: AgentDeps = {
      resolveAgent: vi.fn().mockResolvedValue({}),
      getAgentById: vi.fn().mockReturnValue(undefined),
      getDefaultAgent: vi.fn().mockReturnValue({ id: 'build', name: 'Build' }),
    };
    expect(deps.resolveAgent).toBeDefined();
    expect(deps.getAgentById).toBeDefined();
    expect(deps.getDefaultAgent).toBeDefined();
  });

  it('SettingsDeps can be implemented with vi.fn()', () => {
    const deps: SettingsDeps = {
      getAll: vi.fn().mockReturnValue({}),
    };
    expect(deps.getAll).toBeDefined();
  });

  it('SupervisionDeps can be implemented with vi.fn()', () => {
    const deps: SupervisionDeps = {
      registerInstance: vi.fn(),
      unregisterInstance: vi.fn(),
    };
    expect(deps.registerInstance).toBeDefined();
    expect(deps.unregisterInstance).toBeDefined();
  });

  it('SessionDeps can be implemented with vi.fn()', () => {
    const deps: SessionDeps = {
      updateState: vi.fn(),
      createSnapshot: vi.fn().mockResolvedValue('snap-1'),
    };
    expect(deps.updateState).toBeDefined();
    expect(deps.createSnapshot).toBeDefined();
  });

  it('PermissionDeps can be implemented with vi.fn()', () => {
    const deps: PermissionDeps = {
      loadProjectRules: vi.fn().mockResolvedValue([]),
    };
    expect(deps.loadProjectRules).toBeDefined();
  });

  it('ObservationDeps can be implemented with vi.fn()', () => {
    const deps: ObservationDeps = {
      buildContext: vi.fn().mockReturnValue(''),
    };
    expect(deps.buildContext).toBeDefined();
  });

  it('MemoryDeps can be implemented with vi.fn()', () => {
    const deps: MemoryDeps = {
      getCurrentPressure: vi.fn().mockReturnValue('normal'),
    };
    expect(deps.getCurrentPressure).toBeDefined();
  });

  it('HistoryDeps can be implemented with vi.fn()', () => {
    const deps: HistoryDeps = {
      addThread: vi.fn(),
    };
    expect(deps.addThread).toBeDefined();
  });

  it('CoreDeps assembles all sub-deps', () => {
    const deps: CoreDeps = {
      agents: {
        resolveAgent: vi.fn().mockResolvedValue({}),
        getAgentById: vi.fn().mockReturnValue(undefined),
        getDefaultAgent: vi.fn().mockReturnValue({ id: 'build', name: 'Build' }),
      },
      settings: { getAll: vi.fn().mockReturnValue({}) },
      supervision: {
        registerInstance: vi.fn(),
        unregisterInstance: vi.fn(),
      },
      session: {
        updateState: vi.fn(),
        createSnapshot: vi.fn().mockResolvedValue('snap-1'),
      },
      permissions: { loadProjectRules: vi.fn().mockResolvedValue([]) },
      observation: { buildContext: vi.fn().mockReturnValue('') },
      memory: { getCurrentPressure: vi.fn().mockReturnValue('normal') },
      history: { addThread: vi.fn() },
    };

    // Verify each group is present and callable
    expect(deps.agents.getDefaultAgent()).toMatchObject({ id: 'build' });
    expect(deps.settings.getAll()).toBeDefined();
    deps.supervision.registerInstance('inst-1', null);
    expect(deps.supervision.registerInstance).toHaveBeenCalledWith('inst-1', null);
    expect(deps.memory.getCurrentPressure()).toBe('normal');
  });
});

// ── productionCoreDeps structural test ──────────────────────────────────────
// We only verify the shape is correct (all keys present).
// We do NOT call the function because it would initialize singletons.

describe('productionCoreDeps export', () => {
  it('is exported as a function', async () => {
    // Dynamic import to avoid singleton side-effects at describe time
    const mod = await import('../instance-deps');
    expect(typeof mod.productionCoreDeps).toBe('function');
  });
});
