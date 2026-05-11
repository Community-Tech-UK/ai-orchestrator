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

      // Wire OrchestrationWAL and JobJournal as observers on the engine.
      // Both are append-only mirrors: WAL captures every mutation for audit,
      // JobJournal tracks long-lived debate/consensus/multi-verify jobs so
      // status survives daemon restarts. Failures here are non-fatal.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getOrchestrationWAL } = require('../orchestration/orchestration-wal') as typeof import('../orchestration/orchestration-wal');
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { getJobJournal } = require('../orchestration/job-journal') as typeof import('../orchestration/job-journal');
      try {
        const wal = getOrchestrationWAL();
        const journal = getJobJournal();
        engine.on('event:appended', (event) => {
          try {
            wal.append({
              ts: event.timestamp,
              kind: event.type,
              instanceId:
                typeof event.metadata?.instanceId === 'string'
                  ? event.metadata.instanceId
                  : undefined,
              runId: event.aggregateId,
              payload: event.payload,
            });
          } catch { /* WAL is best-effort */ }

          // Job lifecycle: map known terminal events to journal states.
          // We deliberately match exact event names (NOT suffixes) because
          // events like `debate.round_completed` are intermediate, not terminal.
          try {
            const eventType = String(event.type);
            const aggregateId = event.aggregateId;
            const startEvents = new Set<string>([
              'debate.started',
              'verification.requested',
              'consensus.started',
            ]);
            const completeEvents = new Set<string>([
              'debate.completed',
              'verification.completed',
              'consensus.completed',
            ]);
            if (startEvents.has(eventType)) {
              journal.start(aggregateId, eventType, { event: eventType });
            } else if (completeEvents.has(eventType)) {
              const payload = event.payload as Record<string, unknown> | undefined;
              const err = payload?.['error'];
              if (typeof err === 'string' && err.length > 0) {
                journal.fail(aggregateId, err, { event: eventType });
              } else {
                journal.complete(aggregateId, { event: eventType });
              }
            } else if (eventType === 'verification.cancelled') {
              journal.fail(aggregateId, 'cancelled', { event: eventType });
            }
          } catch { /* journal is best-effort */ }
        });
      } catch (err) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { getLogger } = require('../logging/logger') as typeof import('../logging/logger');
        getLogger('OrchestrationBootstrap').warn('Failed to attach WAL/JobJournal observers', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  });
}
