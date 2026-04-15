/**
 * Orchestration Domain Bootstrap
 *
 * Initializes consensus, voting, supervision, synthesis, restart policy,
 * doom loop detection, and orchestration activity bridge singletons.
 */

import { registerBootstrapModule } from './index';

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
}
