/**
 * Infrastructure Domain Bootstrap
 *
 * Initializes checkpointing, health checks, failover, CLI detection, skills,
 * and hooks.
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
      const { getFailoverManager } = require('../providers/failover-manager') as typeof import('../providers/failover-manager');
      const { getClaudeMdLoader } = require('../core/config/claude-md-loader') as typeof import('../core/config/claude-md-loader');

      getCheckpointManager();
      getHealthChecker();
      getFailoverManager();
      getClaudeMdLoader();
    },
  });

  registerBootstrapModule({
    name: 'Skills & Hooks',
    domain: 'infrastructure',
    failureMode: 'degraded',
    init: () => {
      const { getEnhancedHookExecutor } = require('../hooks/enhanced-hook-executor') as typeof import('../hooks/enhanced-hook-executor');

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
    name: 'Model pricing sync',
    domain: 'infrastructure',
    failureMode: 'degraded',
    init: () => {
      // Seed the committed offline snapshot synchronously first, so pricing +
      // context windows for the supported providers are correct immediately and
      // fully offline. start() then fires an immediate live refresh (which
      // overwrites individual entries when it lands) and schedules periodic
      // refreshes so a long-running instance picks up models published upstream
      // after launch. Fire-and-forget: refresh() is fail-soft and never throws,
      // so a slow or offline models.dev never blocks startup.
      const { getModelsDevService } = require('../providers/models-dev-service') as typeof import('../providers/models-dev-service');
      const modelsDev = getModelsDevService();
      modelsDev.loadOfflineSnapshot();
      modelsDev.start();
    },
    teardown: () => {
      const { getModelsDevService } = require('../providers/models-dev-service') as typeof import('../providers/models-dev-service');
      getModelsDevService().stop();
    },
  });

  registerBootstrapModule({
    name: 'Observability',
    domain: 'infrastructure',
    failureMode: 'degraded',
    init: () => {
      const { initTracer } = require('../observability/otel-setup') as typeof import('../observability/otel-setup');
      const { initMetrics } = require('../observability/otel-metrics') as typeof import('../observability/otel-metrics');
      initTracer();
      initMetrics({
        enableConsole: Boolean(process.env['OTEL_METRICS_CONSOLE']),
      });
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
