/**
 * Orchestration Domain Bootstrap
 *
 * Initializes consensus, voting, supervision, synthesis, restart policy,
 * doom loop detection, and orchestration activity bridge singletons.
 */

import { registerBootstrapModule } from './index';
import { isFeatureEnabled } from '../../shared/constants/feature-flags';

export function registerOrchestrationBootstrap(): void {
  registerBootstrapModule({
    name: 'Orchestration singletons',
    domain: 'orchestration',
    failureMode: 'degraded',
    init: () => {
      // Lazy-load to avoid import-time side effects
      const { getConsensusManager } = require('../orchestration/consensus') as typeof import('../orchestration/consensus');
      const { getRestartPolicy } = require('../orchestration/restart-policy') as typeof import('../orchestration/restart-policy');
      const { getSupervisor } = require('../orchestration/supervisor') as typeof import('../orchestration/supervisor');
      const { getSynthesisAgent } = require('../orchestration/synthesis-agent') as typeof import('../orchestration/synthesis-agent');
      const { getVotingSystem } = require('../orchestration/voting') as typeof import('../orchestration/voting');
      const { getDoomLoopDetector } = require('../orchestration/doom-loop-detector') as typeof import('../orchestration/doom-loop-detector');

      getConsensusManager();
      getRestartPolicy();
      getSupervisor();
      getSynthesisAgent();
      getVotingSystem();
      getDoomLoopDetector();
    },
  });

  registerBootstrapModule({
    name: 'Orchestration event store',
    domain: 'orchestration',
    failureMode: 'degraded',
    dependencies: ['Orchestration singletons'],
    teardown: () => {
      const globalState = globalThis as typeof globalThis & {
        __orchestrationEventBridge?: import('../orchestration/event-store/coordinator-event-bridge').CoordinatorEventBridge;
      };
      globalState.__orchestrationEventBridge?.dispose();
      delete globalState.__orchestrationEventBridge;
    },
    init: () => {
      if (!isFeatureEnabled('EVENT_SOURCING')) {
        return;
      }

      const { getRLMDatabase } = require('../persistence/rlm-database') as typeof import('../persistence/rlm-database');
      const { getDebateCoordinator } = require('../orchestration/debate-coordinator') as typeof import('../orchestration/debate-coordinator');
      const { getMultiVerifyCoordinator } = require('../orchestration/multi-verify-coordinator') as typeof import('../orchestration/multi-verify-coordinator');
      const { getParallelWorktreeCoordinator } = require('../orchestration/parallel-worktree-coordinator') as typeof import('../orchestration/parallel-worktree-coordinator');
      const { OrchestrationEngine } = require('../orchestration/orchestration-engine') as typeof import('../orchestration/orchestration-engine');
      const { OrchestrationEventStore } = require('../orchestration/event-store/orchestration-event-store') as typeof import('../orchestration/event-store/orchestration-event-store');
      const { CoordinatorEventBridge } = require('../orchestration/event-store/coordinator-event-bridge') as typeof import('../orchestration/event-store/coordinator-event-bridge');

      const store = OrchestrationEventStore.getInstance(getRLMDatabase().getRawDb());
      store.initialize();
      const engine = new OrchestrationEngine(store);

      const bridge = new CoordinatorEventBridge(engine);
      const globalState = globalThis as typeof globalThis & {
        __orchestrationEventBridge?: import('../orchestration/event-store/coordinator-event-bridge').CoordinatorEventBridge;
      };
      globalState.__orchestrationEventBridge?.dispose();
      globalState.__orchestrationEventBridge = bridge;
      bridge.wireVerifyCoordinator(getMultiVerifyCoordinator());
      bridge.wireDebateCoordinator(getDebateCoordinator());
      bridge.wireParallelWorktreeCoordinator(getParallelWorktreeCoordinator());
    },
  });
}
