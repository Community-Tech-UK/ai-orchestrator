/**
 * Infrastructure Domain Bootstrap
 *
 * Initializes checkpointing, health checks, retry management,
 * failover, sandboxing, CLI detection, skills, and hooks.
 */

import { registerBootstrapModule } from './index';
import { getCliUpdatePollService } from '../cli/cli-update-poll-service';

export function registerInfrastructureBootstrap(): void {
  registerBootstrapModule({
    name: 'Infrastructure singletons',
    domain: 'infrastructure',
    failureMode: 'degraded',
    init: () => {
      const { getCheckpointManager } = require('../session/checkpoint-manager') as typeof import('../session/checkpoint-manager');
      const { getHealthChecker } = require('../core/system/health-checker') as typeof import('../core/system/health-checker');
      const { getRetryManager } = require('../core/retry-manager') as typeof import('../core/retry-manager');
      const { getFailoverManager } = require('../providers/failover-manager') as typeof import('../providers/failover-manager');
      const { getSandboxManager } = require('../security/sandbox-manager') as typeof import('../security/sandbox-manager');
      const { getClaudeMdLoader } = require('../core/config/claude-md-loader') as typeof import('../core/config/claude-md-loader');

      getCheckpointManager();
      getHealthChecker();
      getRetryManager();
      getFailoverManager();
      getSandboxManager();
      getClaudeMdLoader();
    },
  });

  registerBootstrapModule({
    name: 'Skills & Hooks',
    domain: 'infrastructure',
    failureMode: 'degraded',
    init: () => {
      const { getTriggerMatcher } = require('../skills/trigger-matcher') as typeof import('../skills/trigger-matcher');
      const { getSkillMatcher } = require('../skills/skill-matcher') as typeof import('../skills/skill-matcher');
      const { getEnhancedHookExecutor } = require('../hooks/enhanced-hook-executor') as typeof import('../hooks/enhanced-hook-executor');

      getTriggerMatcher();
      getSkillMatcher();
      getEnhancedHookExecutor();
    },
  });

  registerBootstrapModule({
    name: 'CLI detection',
    domain: 'infrastructure',
    failureMode: 'degraded',
    init: () => {
      const { getCliDetectionService } = require('../cli/cli-detection') as typeof import('../cli/cli-detection');
      getCliDetectionService();
    },
  });

  registerBootstrapModule({
    name: 'CLI update poller',
    domain: 'infrastructure',
    failureMode: 'degraded',
    dependencies: ['CLI detection'],
    init: () => {
      getCliUpdatePollService().start();
    },
    teardown: () => {
      getCliUpdatePollService().stop();
    },
  });

  registerBootstrapModule({
    name: 'Observability',
    domain: 'infrastructure',
    failureMode: 'degraded',
    init: () => {
      const { initTracer } = require('../observability/otel-setup') as typeof import('../observability/otel-setup');
      initTracer();
    },
  });

  registerBootstrapModule({
    name: 'Startup capability probe',
    domain: 'infrastructure',
    failureMode: 'degraded',
    dependencies: ['CLI detection', 'Observability'],
    init: async () => {
      const { getCapabilityProbe } = require('./capability-probe') as typeof import('./capability-probe');
      await getCapabilityProbe().run();
    },
  });
}
