/**
 * Per-spawn telemetry for the size of the Harness MCP tool schemas a session
 * receives (browser gateway and orchestrator tools). Extracted from
 * `SpawnConfigBuilder`, which keeps the options it returns; this module only
 * measures and logs.
 */

import {
  createBrowserMcpTools,
  createDeferredBrowserMcpTools,
  measureToolSchemaBytes,
  resolveBrowserGatewayToolMode,
  type BrowserGatewayToolMode,
} from '../../browser-gateway';
import { createStableBrowserMcpTools } from '../../browser-gateway/browser-mcp-stable-tools';
import {
  detectClaudeNativeToolSearch,
  type ClaudeNativeToolSearchState,
} from '../../cli/adapters/claude-native-tool-search';
import { getLogger } from '../../logging/logger';
import { createOrchestratorToolsForwarderTools } from '../../mcp/orchestrator-tools-mcp-forwarder';
import {
  createDeferredOrchestratorTools,
  measureOrchestratorToolSchemaBytes,
} from '../../mcp/orchestrator-mcp-deferral';
import { createStableOrchestratorTools } from '../../mcp/orchestrator-mcp-stable-tools';
import { resolveOrchestratorToolMode, type OrchestratorToolMode } from '../../mcp/orchestrator-tools-mcp-config';

const logger = getLogger('SpawnConfigBuilder');

interface SchemaMeasurement {
  visibleToolCount: number;
  visibleSchemaBytes: number;
  fullToolCount: number;
  fullSchemaBytes: number;
}

export class ToolSchemaTelemetry {
  private readonly browserMeasurements = new Map<BrowserGatewayToolMode, SchemaMeasurement>();
  private readonly orchestratorMeasurements = new Map<string, SchemaMeasurement>();

  /**
   * The spawn options keep the requested deferral, because the final Claude
   * seam (`configureClaudeNativeSearchMcp`, after account routing) reconciles
   * it against Claude's own tool search. The log must report the surface that
   * seam settles on, so it applies the same detection. Model and account home
   * are only known at the seam, so this is the spawn-independent best effort;
   * the seam logs the authoritative line.
   */
  private nativeToolSearchFor(provider?: string): ClaudeNativeToolSearchState | undefined {
    if (provider?.trim().toLowerCase() !== 'claude') return undefined;
    try {
      return detectClaudeNativeToolSearch();
    } catch {
      return undefined; // telemetry must never break a spawn
    }
  }

  /**
   * WS9 telemetry: log the orchestrator tool-schema bytes a session will
   * receive from its initial tools/list, next to the full-surface cost.
   */
  reportOrchestrator(
    instanceId: string,
    provider: string | undefined,
    toolDeferral: boolean | undefined,
    sessionMessagingEnabled: boolean,
  ): void {
    const toolMode = resolveOrchestratorToolMode(provider, toolDeferral, {
      nativeToolSearch: this.nativeToolSearchFor(provider),
    });
    try {
      const measurement = this.orchestratorMeasurement(toolMode, sessionMessagingEnabled);
      if (toolMode === 'eager') {
        logger.info('Orchestrator tool schemas injected eagerly', {
          instanceId,
          toolCount: measurement.fullToolCount,
          schemaBytes: measurement.fullSchemaBytes,
        });
        return;
      }
      logger.info('Orchestrator tool schemas deferred', { instanceId, toolMode, ...measurement });
    } catch (error) {
      logger.warn('Failed to measure orchestrator tool schema bytes', {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * WS9 telemetry: log the browser tool-schema bytes a session will receive
   * from its initial tools/list, next to the full-surface cost, so the
   * deferral win is measurable per spawn. Computed from static tool
   * definitions only — no gateway round trip.
   */
  reportBrowser(instanceId: string, provider: string | undefined, deferred: boolean): void {
    const toolMode = resolveBrowserGatewayToolMode(provider, deferred, {
      nativeToolSearch: this.nativeToolSearchFor(provider),
    });
    try {
      const measurement = this.browserMeasurement(toolMode);
      if (toolMode === 'eager') {
        logger.info('Browser gateway tool schemas injected eagerly', {
          instanceId,
          toolCount: measurement.fullToolCount,
          schemaBytes: measurement.fullSchemaBytes,
        });
        return;
      }
      logger.info('Browser gateway tool schemas deferred', { instanceId, toolMode, ...measurement });
    } catch (error) {
      logger.warn('Failed to measure browser tool schema bytes', {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Static per-process measurement — tool definitions never change at runtime. */
  private browserMeasurement(toolMode: BrowserGatewayToolMode): SchemaMeasurement {
    let measurement = this.browserMeasurements.get(toolMode);
    if (!measurement) {
      const noopClient = { call: async () => ({}) };
      const fullTools = createBrowserMcpTools(noopClient);
      const deferredTools = toolMode === 'stable'
        ? createStableBrowserMcpTools(noopClient)
        : createDeferredBrowserMcpTools(noopClient, { onReveal: () => undefined });
      const visibleTools = deferredTools.filter((tool) => !tool.hidden);
      measurement = {
        visibleToolCount: visibleTools.length,
        visibleSchemaBytes: measureToolSchemaBytes(visibleTools),
        fullToolCount: fullTools.length,
        fullSchemaBytes: measureToolSchemaBytes(fullTools),
      };
      this.browserMeasurements.set(toolMode, measurement);
    }
    return measurement;
  }

  private orchestratorMeasurement(
    toolMode: OrchestratorToolMode,
    sessionMessagingEnabled: boolean,
  ): SchemaMeasurement {
    const cacheKey = `${toolMode}:${sessionMessagingEnabled ? 'session-messaging-on' : 'session-messaging-off'}`;
    let measurement = this.orchestratorMeasurements.get(cacheKey);
    if (!measurement) {
      const noopClient = { call: async () => ({}) };
      const fullTools = createOrchestratorToolsForwarderTools(noopClient, {
        sessionMessagingEnabled,
      });
      const listed = toolMode === 'eager'
        ? fullTools
        : toolMode === 'stable'
          ? createStableOrchestratorTools(fullTools)
          : createDeferredOrchestratorTools(fullTools, { onReveal: () => undefined });
      const visibleTools = listed.filter((tool) => !tool.hidden);
      measurement = {
        visibleToolCount: visibleTools.length,
        visibleSchemaBytes: measureOrchestratorToolSchemaBytes(visibleTools),
        fullToolCount: fullTools.length,
        fullSchemaBytes: measureOrchestratorToolSchemaBytes(fullTools),
      };
      this.orchestratorMeasurements.set(cacheKey, measurement);
    }
    return measurement;
  }
}
