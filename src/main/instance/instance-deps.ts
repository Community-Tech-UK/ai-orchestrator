// src/main/instance/instance-deps.ts

import type { AgentProfile } from '../../shared/types/agent.types';
import type { AppSettings } from '../../shared/types/settings.types';
import type { PermissionRule } from '../security/permission-manager';
import type { MemoryPressureLevel } from '../memory/memory-monitor';

// ── Per-concern narrow interfaces ────────────────────────────────────────────

export interface AgentDeps {
  /** Resolve an agent by ID for a given working directory. */
  resolveAgent(agentId: string, workDir: string): Promise<AgentProfile>;
  /** Look up an agent profile by its ID (returns undefined if not found). */
  getAgentById(id: string): AgentProfile | undefined;
  /** Return the default agent profile. */
  getDefaultAgent(): AgentProfile;
}

export interface SettingsDeps {
  /** Return the full application settings snapshot. */
  getAll(): AppSettings;
}

export interface SupervisionDeps {
  /** Register an instance with the supervisor tree. */
  registerInstance(id: string, parentId: string | null): void;
  /** Remove an instance from the supervisor tree. */
  unregisterInstance(id: string): void;
}

export interface SessionDeps {
  /** Update persisted session state for an instance. */
  updateState(instanceId: string, state: Record<string, unknown>): void;
  /** Create a named snapshot for an instance. Returns the snapshot ID (or empty string on failure). */
  createSnapshot(
    instanceId: string,
    name: string,
    description: string,
    trigger: 'auto' | 'manual' | 'checkpoint',
  ): Promise<string>;
}

export interface PermissionDeps {
  /** Load project-level permission rules for a working directory. */
  loadProjectRules(workDir: string): Promise<PermissionRule[]>;
}

export interface ObservationDeps {
  /** Build an observation context string for injection into agent prompts. */
  buildContext(instanceId: string): string;
}

export interface MemoryDeps {
  /** Return the current memory pressure level. */
  getCurrentPressure(): MemoryPressureLevel;
}

export interface HistoryDeps {
  /** Register a new history thread for an instance (no-op if not applicable). */
  addThread(instanceId: string): void;
}

/** Aggregated narrow deps for the core execution loop. */
export interface CoreDeps {
  agents: AgentDeps;
  settings: SettingsDeps;
  supervision: SupervisionDeps;
  session: SessionDeps;
  permissions: PermissionDeps;
  observation: ObservationDeps;
  memory: MemoryDeps;
  history: HistoryDeps;
}

// ── Production wiring ────────────────────────────────────────────────────────
// Calling this function is deferred to runtime so that singletons are not
// initialized at module load time (avoids import-side-effect problems in tests).

export function productionCoreDeps(): CoreDeps {
  // Lazy imports inside the function body keep them out of the module-level scope.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getAgentRegistry } = require('../agents/agent-registry') as typeof import('../agents/agent-registry');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getAgentById: getBuiltinAgentById, getDefaultAgent: getBuiltinDefaultAgent } = require('../../shared/types/agent.types') as typeof import('../../shared/types/agent.types');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getSettingsManager } = require('../core/config/settings-manager') as typeof import('../core/config/settings-manager');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getSupervisorTree } = require('../process') as typeof import('../process');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getSessionContinuityManager } = require('../session/session-continuity') as typeof import('../session/session-continuity');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getPermissionManager } = require('../security/permission-manager') as typeof import('../security/permission-manager');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getMemoryMonitor } = require('../memory') as typeof import('../memory');

  return {
    agents: {
      resolveAgent: (agentId, workDir) =>
        getAgentRegistry().resolveAgent(workDir, agentId),
      getAgentById: (id) => getBuiltinAgentById(id) ?? undefined,
      getDefaultAgent: () => getBuiltinDefaultAgent(),
    },
    settings: {
      getAll: () => getSettingsManager().getAll(),
    },
    supervision: {
      registerInstance: (id, parentId) => {
        // Narrow adapter: delegate with minimal required arguments.
        // workingDirectory and displayName are not available at this interface level
        // so we pass empty strings — the supervisor tree handles missing values gracefully.
        getSupervisorTree().registerInstance(id, parentId, '', id);
      },
      unregisterInstance: (id) => getSupervisorTree().unregisterInstance(id),
    },
    session: {
      updateState: (id, state) => {
        void getSessionContinuityManager().updateState(id, state as Parameters<ReturnType<typeof getSessionContinuityManager>['updateState']>[1]);
      },
      createSnapshot: async (id, name, desc, trigger) => {
        const snapshot = await getSessionContinuityManager().createSnapshot(id, name, desc, trigger);
        return snapshot?.id ?? '';
      },
    },
    permissions: {
      loadProjectRules: (workDir) => {
        getPermissionManager().loadProjectRules(workDir);
        return Promise.resolve([]);
      },
    },
    observation: {
      // The real PolicyAdapter.buildObservationContext is async but the narrow
      // interface is sync (for test simplicity). Returns empty string; callers
      // that need async observation context call getPolicyAdapter() directly.
      buildContext: () => '',
    },
    memory: {
      getCurrentPressure: () => getMemoryMonitor().getPressureLevel(),
    },
    history: {
      // HistoryManager tracks conversations on termination (archiveInstance).
      // There is no separate addThread call during creation; this is a no-op.
      addThread: () => { /* no-op */ },
    },
  };
}
