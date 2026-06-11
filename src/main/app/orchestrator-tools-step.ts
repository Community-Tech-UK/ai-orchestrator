import { getSettingsManager } from '../core/config/settings-manager';
import { initializeOrchestratorToolsRpcServer } from '../mcp/orchestrator-tools-rpc-server';
import { defaultOperatorDbPath } from '../operator/operator-database';
import { getWorkerNodeConnectionServer, getWorkerNodeRegistry } from '../remote-node';
import { COORDINATOR_TO_NODE } from '../remote-node/worker-node-rpc';
import { ConfigUpdateParamsSchema } from '../remote-node/rpc-schemas';
import { resolveWorkerNodeTarget } from '../remote-node/worker-node-registry';
import { sendServiceRpc } from '../remote-node/service-rpc-client';
import { evaluateSpawn } from '../orchestration/subagent-spawn-guard';
import {
  getAutomationRunner,
  getAutomationScheduler,
  getAutomationStore,
} from '../automations';
import {
  createAutomationWithScheduling,
  handlePastOneTimeAutomation,
} from '../automations/automation-create-service';
import { getAutomationEvents } from '../automations/automation-events';
import { createAutomationToolImplementations } from '../automations/automation-tool-impl';
import type { Instance } from '../../shared/types/instance.types';
import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';
import { getLogger } from '../logging/logger';
import { broadcastSettingsChanged } from '../ipc/handlers/settings-broadcast';
import type { AppInitializationStep } from './initialization-steps';

const logger = getLogger('AppInitialization');

/**
 * Effective spawn depth of an instance for the recursion guard (claude2_todo
 * #18). Unifies the two lineage systems: locally-orchestrated children carry a
 * real `depth` (set from `parent.depth + 1`), while `run_on_node`-spawned
 * instances record their depth in `metadata.spawnDepth` (they deliberately
 * don't set `parentId`, to avoid coupling remote spawns to parent-termination
 * / hibernation cascades). The larger of the two wins.
 */
export function effectiveSpawnDepth(instance: Instance | undefined): number {
  if (!instance) return 0;
  const metaDepth = instance.metadata?.['spawnDepth'];
  const fromMeta = typeof metaDepth === 'number' && Number.isFinite(metaDepth) ? metaDepth : 0;
  const fromField = typeof instance.depth === 'number' && Number.isFinite(instance.depth) ? instance.depth : 0;
  return Math.max(fromMeta, fromField, 0);
}

/**
 * Creates the "Orchestrator-tools RPC server" initialization step.
 *
 * Parent-side RPC servers backing the orchestrator-tools / codemem
 * MCP forwarders that the `aio-mcp` SEA dispatcher spawns. Must be
 * started before any child instance does — the MCP config builders
 * bail out (and log a warning) if the socket path is missing.
 */
export function createOrchestratorToolsStep(
  instanceManager: InstanceManager,
  windowManager: WindowManager,
): AppInitializationStep {
  return {
    name: 'Orchestrator-tools RPC server',
    fn: async () => {
      // Statuses where the instance is still actively working a turn. Used to
      // derive `done` for read_node_output. Mirrors the mobile gateway's
      // WORKING_STATUSES.
      const WORKING_STATUSES = new Set<string>([
        'initializing',
        'busy',
        'processing',
        'thinking_deeply',
        'interrupting',
        'interrupt-escalating',
        'cancelling',
        'respawning',
        'waking',
      ]);
      const MAX_MESSAGE_CONTENT = 4000;
      const sleep = (ms: number): Promise<void> =>
        new Promise((resolve) => setTimeout(resolve, ms));
      // Implementations backing create/list/delete/update/postpone automation
      // MCP tools. Extracted to ../automations/automation-tool-impl.ts so the
      // logic is integration-tested against a real in-memory store; here we wire
      // the real singletons + caller-instance working-directory resolution.
      const automationTools = createAutomationToolImplementations({
        store: getAutomationStore(),
        scheduler: getAutomationScheduler(),
        runner: getAutomationRunner(),
        events: getAutomationEvents(),
        createWithScheduling: createAutomationWithScheduling,
        handlePastOneTime: handlePastOneTimeAutomation,
        resolveWorkingDirectory: (callerInstanceId) =>
          callerInstanceId
            ? instanceManager.getInstance(callerInstanceId)?.workingDirectory
            : undefined,
      });
      await initializeOrchestratorToolsRpcServer({
        operatorDbPath: defaultOperatorDbPath(),
        isKnownLocalInstance: (instanceId) => Boolean(instanceManager.getInstance(instanceId)),
        // Backs the read-only `list_remote_nodes` MCP tool: expose only
        // operational routing/status fields already advertised by workers.
        listRemoteNodes: async () => {
          const nodes = getWorkerNodeRegistry().getAllNodes();
          return {
            connectedCount: nodes.filter((node) => node.status === 'connected').length,
            totalCount: nodes.length,
            nodes: nodes.map((node) => ({
              id: node.id,
              name: node.name,
              status: node.status,
              platform: node.capabilities.platform,
              arch: node.capabilities.arch,
              supportedClis: [...node.capabilities.supportedClis],
              hasBrowserRuntime: node.capabilities.hasBrowserRuntime,
              hasBrowserMcp: node.capabilities.hasBrowserMcp,
              hasDocker: node.capabilities.hasDocker,
              ...(node.capabilities.gpuName ? { gpuName: node.capabilities.gpuName } : {}),
              ...(node.capabilities.gpuMemoryMB ? { gpuMemoryMB: node.capabilities.gpuMemoryMB } : {}),
              activeInstances: node.activeInstances,
              maxConcurrentInstances: node.capabilities.maxConcurrentInstances,
              workingDirectories: [...node.capabilities.workingDirectories],
              ...(node.lastHeartbeat !== undefined ? { lastHeartbeat: node.lastHeartbeat } : {}),
              ...(node.latencyMs !== undefined ? { latencyMs: node.latencyMs } : {}),
            })),
          };
        },
        // Backs the `run_on_node` MCP tool: resolve the target worker node and
        // spawn an agent on it via the already-deployed `instance.spawn` RPC.
        // Mirrors the `/run-on` channel command (project-less default cwd).
        spawnRemoteInstance: async (args, meta) => {
          // Recursion-depth guard (claude2_todo #18): a remote-spawned agent
          // also receives the orchestrator MCP, so without a cap it could
          // call run_on_node again and fork-bomb across nodes. Block spawns
          // past the configured depth and beyond the global instance ceiling.
          const callerInstance = meta?.callerInstanceId
            ? instanceManager.getInstance(meta.callerInstanceId)
            : undefined;
          const guardSettings = getSettingsManager().getAll();
          const activeSpawnedChildren = instanceManager
            .getAllInstances()
            .filter(
              (i) =>
                i.status !== 'terminated' &&
                typeof i.metadata?.['spawnDepth'] === 'number',
            ).length;
          const spawnDecision = evaluateSpawn({
            parentDepth: effectiveSpawnDepth(callerInstance),
            activeChildCount: activeSpawnedChildren,
            limits: {
              maxDepth: guardSettings.maxSpawnDepth,
              maxConcurrentChildren: guardSettings.maxTotalInstances,
            },
          });
          if (!spawnDecision.allowed) {
            logger.info('run_on_node blocked by spawn guard', {
              callerInstanceId: meta?.callerInstanceId ?? null,
              childDepth: spawnDecision.childDepth,
              activeSpawnedChildren,
              maxSpawnDepth: guardSettings.maxSpawnDepth,
              maxTotalInstances: guardSettings.maxTotalInstances,
              reason: spawnDecision.reason,
            });
            throw new Error(`run_on_node blocked: ${spawnDecision.reason}`);
          }

          const registry = getWorkerNodeRegistry();
          const allNodes = registry.getAllNodes();
          const connected = allNodes.filter(
            (n) => n.status === 'connected' || n.status === 'degraded',
          );
          let node;
          if (args.node) {
            const resolved = resolveWorkerNodeTarget(args.node, connected);
            if ('error' in resolved) {
              throw new Error(resolved.error);
            }
            node = connected.find((n) => n.id === resolved.nodeId);
            if (!node) {
              throw new Error(`Worker node not found: ${args.node}`);
            }
          } else if (connected.length === 1) {
            node = connected[0];
          } else if (connected.length === 0) {
            throw new Error('No worker nodes are connected');
          } else {
            throw new Error(
              `Multiple worker nodes connected (${connected
                .map((n) => n.name)
                .join(', ')}); specify one via "node"`,
            );
          }
          const allowedDirs = node.capabilities?.workingDirectories ?? [];
          const workingDirectory = args.workingDirectory || allowedDirs[0] || process.cwd();
          const instance = await instanceManager.createInstance({
            displayName: `run_on_node:${node.name}`,
            workingDirectory,
            initialPrompt: args.prompt,
            yoloMode: true,
            forceNodeId: node.id,
            provider: args.provider,
            modelOverride: args.model,
            // Record spawn lineage for the recursion guard so a child that
            // itself calls run_on_node is seen at the next depth.
            metadata: {
              spawnDepth: spawnDecision.childDepth,
              hideFromProjectRail: true,
              ...(meta?.callerInstanceId
                ? { spawnParentInstanceId: meta.callerInstanceId }
                : {}),
            },
          });
          return {
            instanceId: instance.id,
            nodeId: node.id,
            nodeName: node.name,
            workingDirectory,
            status: instance.status,
          };
        },
        // Backs the `read_node_output` MCP tool: serialize a remote-spawned
        // instance's output buffer + status so an external agent can read the
        // results back. Optionally polls until the turn completes.
        readInstanceOutput: async (args) => {
          const deadline = Date.now() + (args.waitMs ?? 0);
          let instance = instanceManager.getInstance(args.instanceId);
          if (!instance) {
            return null;
          }
          // Poll until the instance leaves a working state or the wait budget
          // is exhausted. The first check happens before any sleep.
          while (WORKING_STATUSES.has(instance.status) && Date.now() < deadline) {
            await sleep(Math.min(500, Math.max(0, deadline - Date.now())));
            instance = instanceManager.getInstance(args.instanceId);
            if (!instance) {
              return null;
            }
          }
          const limit = args.limit ?? 100;
          const buffer = instance.outputBuffer ?? [];
          const sliced = buffer.slice(-limit);
          let contentCapped = false;
          const messages = sliced.map((m) => {
            let content = m.content ?? '';
            if (content.length > MAX_MESSAGE_CONTENT) {
              content = `${content.slice(0, MAX_MESSAGE_CONTENT)}… [truncated]`;
              contentCapped = true;
            }
            return { type: m.type, content, timestamp: m.timestamp };
          });
          return {
            instanceId: instance.id,
            status: instance.status,
            done: !WORKING_STATUSES.has(instance.status),
            messageCount: buffer.length,
            truncated: contentCapped || sliced.length < buffer.length,
            messages,
          };
        },
        settingsManager: getSettingsManager(),
        broadcastSettingsChange: (payload) => broadcastSettingsChanged(windowManager, payload),
        updateNodeConfig: async (args) => {
          const registry = getWorkerNodeRegistry();
          const server = getWorkerNodeConnectionServer();
          const connectedIds = new Set(server.getConnectedNodeIds());
          const connectedNodes = registry
            .getAllNodes()
            .filter((node) => connectedIds.has(node.id));
          const resolved = resolveWorkerNodeTarget(args.nodeId, connectedNodes);
          if ('error' in resolved) {
            throw new Error(resolved.error);
          }
          const node = registry.getNode(resolved.nodeId);
          if (!node || !server.isNodeConnected(node.id)) {
            throw new Error(`Node not connected: ${args.nodeId}`);
          }
          const params = ConfigUpdateParamsSchema.parse({
            ...(args.browserAutomation
              ? { browserAutomation: args.browserAutomation }
              : {}),
            ...(args.androidAutomation
              ? { androidAutomation: args.androidAutomation }
              : {}),
            ...(args.extensionRelay ? { extensionRelay: args.extensionRelay } : {}),
          });
          const result = await sendServiceRpc(
            node.id,
            COORDINATOR_TO_NODE.CONFIG_UPDATE,
            params,
            30_000,
          );
          return {
            nodeId: node.id,
            nodeName: node.name,
            updatedBlocks: Object.keys(params),
            result,
          };
        },
        // Automation MCP tools (create/list/delete/update/postpone) — logic
        // lives in ../automations/automation-tool-impl.ts (integration-tested).
        createAutomation: automationTools.createAutomation,
        listAutomations: automationTools.listAutomations,
        deleteAutomation: automationTools.deleteAutomation,
        updateAutomation: automationTools.updateAutomation,
        postponeAutomation: automationTools.postponeAutomation,
        // #18a/#19: strip the spawn-capable `run_on_node` tool from instances
        // that have already reached the spawn-depth limit — defense-in-depth
        // alongside the depth guard in the run_on_node handler.
        resolveSpawnEligibility: (instanceId) => {
          const max = getSettingsManager().get('maxSpawnDepth') ?? 0;
          if (!max || max <= 0) return true; // unbounded → always eligible
          const inst = instanceManager.getInstance(instanceId);
          if (!inst) return true; // unknown instance → don't over-restrict
          return effectiveSpawnDepth(inst) + 1 <= max;
        },
      });
    },
  };
}
