import { randomUUID } from 'node:crypto';
import { getSettingsManager } from '../core/config/settings-manager';
import { detectAndroidIntent } from '../channels/android-intent';
import { initializeOrchestratorToolsRpcServer } from '../mcp/orchestrator-tools-rpc-server';
import { defaultOperatorDbPath } from '../operator/operator-database';
import {
  getWorkerNodeConnectionServer,
  getRemoteNodeRosterService,
  getWorkerNodeRegistry,
  isAndroidAutomationReady,
} from '../remote-node';
import { COORDINATOR_TO_NODE } from '../remote-node/worker-node-rpc';
import { ConfigUpdateParamsSchema } from '../remote-node/rpc-schemas';
import { resolveWorkerNodeTarget } from '../remote-node/worker-node-registry';
import { sendServiceRpc } from '../remote-node/service-rpc-client';
import { createRemoteNodeFileTransferImplementations } from '../remote-node/remote-node-file-transfer-mcp-service';
import { evaluateSpawn } from '../orchestration/subagent-spawn-guard';
import { getPermissionRegistry } from '../orchestration/permission-registry';
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
import { getDocReviewService } from '../doc-review/doc-review-service';
import { DocReviewDeliveryCoordinator } from '../doc-review/doc-review-delivery-coordinator';
import { getLoopCoordinator } from '../orchestration/loop-coordinator';
import { getPauseCoordinator } from '../pause/pause-coordinator';
import type { Instance } from '../../shared/types/instance.types';
import type { NodePlacementPrefs, WorkerNodeInfo } from '../../shared/types/worker-node.types';
import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';
import { getLogger } from '../logging/logger';
import { broadcastSettingsChanged } from '../ipc/handlers/settings-broadcast';
import type { AppInitializationStep } from './initialization-steps';
import { getContextEvidenceCoordinator } from '../context-evidence/context-evidence-coordinator';

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

interface RunOnNodePlacementArgs {
  prompt: string;
  requiresBrowser?: boolean;
  requiresAndroid?: boolean;
  androidDeviceKind?: 'emulator' | 'physical' | 'any';
}

function buildRunOnNodePlacement(args: RunOnNodePlacementArgs): NodePlacementPrefs | undefined {
  const requiresAndroid = args.requiresAndroid ?? detectAndroidIntent(args.prompt);
  const placement: NodePlacementPrefs = {
    ...(args.requiresBrowser === true ? { requiresBrowser: true } : {}),
    ...(requiresAndroid
      ? {
          requiresAndroid: true,
          androidDeviceKind: args.androidDeviceKind ?? 'any',
        }
      : {}),
  };
  return Object.keys(placement).length > 0 ? placement : undefined;
}

function assertNodeSatisfiesPlacement(
  node: WorkerNodeInfo,
  placement: NodePlacementPrefs | undefined,
): void {
  if (!placement) {
    return;
  }
  if (placement.requiresBrowser && !node.capabilities.hasBrowserMcp) {
    throw new Error(
      `Worker node "${node.name}" is not browser-automation ready. Enable browser automation or choose a node with hasBrowserMcp=true.`,
    );
  }
  if (placement.requiresAndroid && !isAndroidAutomationReady(node.capabilities)) {
    throw new Error(
      `Worker node "${node.name}" is not Android-automation ready. Enable Android automation and verify adb/AVD/device readiness before running this test.`,
    );
  }
  if (
    placement.requiresAndroid &&
    placement.androidDeviceKind === 'physical' &&
    !node.capabilities.androidAutomation?.connectedDevices.some((device) =>
      (device.kind === 'usb' || device.kind === 'wifi') && device.state === 'device'
    )
  ) {
    throw new Error(
      `Worker node "${node.name}" does not report an online physical Android device.`,
    );
  }
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
      const fileTransferTools = createRemoteNodeFileTransferImplementations({
        resolveLocalWorkspace: (callerInstanceId) =>
          callerInstanceId
            ? instanceManager.getInstance(callerInstanceId)?.workingDirectory
            : undefined,
      });
      // Persisted review decisions are delivered through lifecycle policy, not a
      // bare sendInput side effect. A later idle/resume event drains queued work.
      const docReviewService = getDocReviewService();
      docReviewService.setDeliveryCoordinator(new DocReviewDeliveryCoordinator({
        instanceManager,
        pauseCoordinator: getPauseCoordinator(),
        loopCoordinator: getLoopCoordinator(),
        resumeOnSubmit: () => getSettingsManager().get('docReviewResumeOnSubmit') !== false,
        recordRecoveredAttempt: (reviewId, attempt) => {
          docReviewService.appendDeliveryAttempt(reviewId, attempt);
        },
      }));
      void docReviewService.recoverUndelivered().catch((error) => {
        logger.warn('Failed to recover queued doc-review deliveries', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
      await initializeOrchestratorToolsRpcServer({
        operatorDbPath: defaultOperatorDbPath(),
        isKnownLocalInstance: (instanceId) => Boolean(instanceManager.getInstance(instanceId)),
        resolveContextEvidence: (instanceId) => {
          const instance = instanceManager.getInstance(instanceId);
          const state = instance?.contextEvidence;
          if (!instance || !state?.conversationId || state.mode === 'off') return null;
          const providerWindowTokens = instance.contextUsage.total;
          return {
            coordinator: getContextEvidenceCoordinator(),
            conversationId: state.conversationId,
            mode: state.mode,
            ...(Number.isSafeInteger(providerWindowTokens) && providerWindowTokens > 0
              ? { providerWindowTokens }
              : {}),
          };
        },
        authorizeReleaseMutation: async ({ instanceId, method, payload }) => {
          const isAndroid = method === 'orchestrator_tools.execute_android_play_release';
          const appIdentity = isAndroid ? payload['packageName'] : payload['bundleId'];
          const releaseIdentity = isAndroid ? payload['versionCode'] : payload['buildNumber'];
          const destination = isAndroid
            ? (payload['track'] ?? payload['destinationTrack'])
            : payload['destination'];
          const safeLabel = (value: unknown): string => String(value ?? '')
            .replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' ')
            .trim()
            .slice(0, 200);
          const decision = await getPermissionRegistry().requestPermission({
            id: `release_${randomUUID()}`,
            instanceId,
            action: 'store_release_mutation',
            description: `Allow ${isAndroid ? 'Google Play' : 'App Store Connect'} release for ${safeLabel(appIdentity) || 'unknown app'} (${safeLabel(releaseIdentity) || 'unknown version'}) to ${safeLabel(destination) || 'unknown destination'}?`,
            toolName: method.slice('orchestrator_tools.'.length),
            details: {
              platform: isAndroid ? 'android' : 'ios',
              appIdentity: safeLabel(appIdentity),
              releaseIdentity: safeLabel(releaseIdentity),
              destination: safeLabel(destination),
            },
            createdAt: Date.now(),
            timeoutMs: 5 * 60_000,
          });
          return decision.granted && decision.decidedBy === 'user';
        },
        // Backs the read-only `list_remote_nodes` MCP tool: expose only
        // operational routing/status fields already advertised by workers.
        listRemoteNodes: async () => {
          const nodes = getRemoteNodeRosterService().list();
          return {
            connectedCount: nodes.filter((node) => node.connected ?? node.status === 'connected').length,
            totalCount: nodes.length,
            nodes: nodes.map((node) => {
              const capabilities = node.capabilities;
              const workerAgent = node.workerAgent ?? capabilities.workerAgent;
              const hasExtensionRelay = node.hasExtensionRelay ?? capabilities.hasExtensionRelay;
              const extensionRelay = node.extensionRelay ?? capabilities.extensionRelay;
              return {
                id: node.id,
                name: node.name,
                status: node.status,
                connected: node.connected ?? node.status === 'connected',
                platform: node.platform ?? 'unknown',
                arch: node.arch ?? capabilities.arch ?? '',
                ...(node.address ? { address: node.address } : {}),
                supportedClis: [...(node.supportedClis ?? capabilities.supportedClis ?? [])],
                ...(workerAgent ? { workerAgent } : {}),
                hasBrowserRuntime: node.hasBrowserRuntime ?? capabilities.hasBrowserRuntime,
                hasBrowserMcp: node.hasBrowserMcp ?? capabilities.hasBrowserMcp,
                ...(node.browserAutomation ?? capabilities.browserAutomation
                  ? { browserAutomation: node.browserAutomation ?? capabilities.browserAutomation }
                  : {}),
                ...(hasExtensionRelay !== undefined
                  ? { hasExtensionRelay }
                  : {}),
                ...(extensionRelay ? { extensionRelay } : {}),
                hasAndroidMcp: node.hasAndroidMcp ?? capabilities.hasAndroidMcp,
                ...(node.androidAutomation ?? capabilities.androidAutomation
                  ? { androidAutomation: node.androidAutomation ?? capabilities.androidAutomation }
                  : {}),
                hasDocker: node.hasDocker ?? capabilities.hasDocker,
                ...(node.gpuName ?? capabilities.gpuName ? { gpuName: node.gpuName ?? capabilities.gpuName } : {}),
                ...(node.gpuMemoryMB ?? capabilities.gpuMemoryMB
                  ? { gpuMemoryMB: node.gpuMemoryMB ?? capabilities.gpuMemoryMB }
                  : {}),
                activeInstances: node.activeInstances,
                maxConcurrentInstances: node.maxConcurrentInstances ?? capabilities.maxConcurrentInstances,
                workingDirectories: [...(node.workingDirectories ?? capabilities.workingDirectories ?? [])],
                ...(node.fileTransfer ?? capabilities.fileTransfer
                  ? { fileTransfer: node.fileTransfer ?? capabilities.fileTransfer }
                  : {}),
                ...(node.connectedAt !== undefined ? { connectedAt: node.connectedAt } : {}),
                ...(node.lastHeartbeat !== undefined ? { lastHeartbeat: node.lastHeartbeat } : {}),
                ...(node.lastAuthenticatedAt !== undefined ? { lastAuthenticatedAt: node.lastAuthenticatedAt } : {}),
                ...(node.pairingLabel ? { pairingLabel: node.pairingLabel } : {}),
                ...(node.authMethod ? { authMethod: node.authMethod } : {}),
                ...(node.latencyMs !== undefined ? { latencyMs: node.latencyMs } : {}),
              };
            }),
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
          const nodePlacement = buildRunOnNodePlacement(args);
          let node: WorkerNodeInfo;
          if (args.node) {
            const resolved = resolveWorkerNodeTarget(args.node, connected);
            if ('error' in resolved) {
              throw new Error(resolved.error);
            }
            const exactNode = connected.find((n) => n.id === resolved.nodeId);
            if (!exactNode) {
              throw new Error(`Worker node not found: ${args.node}`);
            }
            node = exactNode;
          } else if (connected.length === 1) {
            node = connected[0];
          } else if (nodePlacement) {
            const selectedNode = registry.selectNode(nodePlacement);
            if (!selectedNode) {
              throw new Error(
                'No connected worker node satisfies the requested remote testing capabilities.',
              );
            }
            node = selectedNode;
          } else if (connected.length === 0) {
            throw new Error('No worker nodes are connected');
          } else {
            throw new Error(
              `Multiple worker nodes connected (${connected
                .map((n) => n.name)
                .join(', ')}); specify one via "node"`,
            );
          }
          assertNodeSatisfiesPlacement(node, nodePlacement);
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
            ...(nodePlacement ? { nodePlacement } : {}),
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
        // Backs the `terminate_node_instance` MCP tool: terminate one specific
        // run_on_node-spawned instance, or sweep all finished ones (optionally
        // scoped to a node). Only instances carrying the `spawnDepth` lineage
        // marker are eligible — MCP callers can never terminate the user's own
        // interactive sessions. Without this, idle one-shot agents accumulate
        // and permanently exhaust a node's maxConcurrentInstances capacity.
        terminateNodeInstances: async (args) => {
          const isRemoteSpawn = (instance: Instance): boolean =>
            typeof instance.metadata?.['spawnDepth'] === 'number';
          const terminated: { instanceId: string }[] = [];
          const skipped: { instanceId: string; reason: string }[] = [];

          if (args.instanceId) {
            const instance = instanceManager.getInstance(args.instanceId);
            if (!instance) {
              throw new Error(`Instance not found: ${args.instanceId}`);
            }
            if (!isRemoteSpawn(instance)) {
              throw new Error(
                `Refusing to terminate ${args.instanceId}: only run_on_node-spawned instances can be terminated via MCP`,
              );
            }
            await instanceManager.terminateInstance(instance.id, true);
            terminated.push({ instanceId: instance.id });
            return { terminated, skipped };
          }

          // allIdle sweep — resolve the optional node filter first so a typo'd
          // node name errors instead of silently sweeping nothing.
          let nodeIdFilter: string | null = null;
          if (args.node) {
            const resolved = resolveWorkerNodeTarget(
              args.node,
              getWorkerNodeRegistry().getAllNodes(),
            );
            if ('error' in resolved) {
              throw new Error(resolved.error);
            }
            nodeIdFilter = resolved.nodeId;
          }
          const candidates = instanceManager.getAllInstances().filter(
            (instance) =>
              isRemoteSpawn(instance) &&
              instance.status !== 'terminated' &&
              (!nodeIdFilter ||
                (instance.executionLocation.type === 'remote' &&
                  instance.executionLocation.nodeId === nodeIdFilter)),
          );
          for (const instance of candidates) {
            if (WORKING_STATUSES.has(instance.status)) {
              skipped.push({
                instanceId: instance.id,
                reason: `still working (${instance.status})`,
              });
              continue;
            }
            try {
              await instanceManager.terminateInstance(instance.id, true);
              terminated.push({ instanceId: instance.id });
            } catch (error) {
              skipped.push({
                instanceId: instance.id,
                reason: error instanceof Error ? error.message : String(error),
              });
            }
          }
          logger.info('terminate_node_instance sweep completed', {
            node: args.node ?? null,
            terminated: terminated.length,
            skipped: skipped.length,
          });
          return { terminated, skipped };
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
            ...(args.fileTransfer ? { fileTransfer: args.fileTransfer } : {}),
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
        // Doc-review MCP tools (request_doc_review / get_doc_review_result).
        requestDocReview: async ({ instanceId, artifactPath, title, sourcePath }) => {
          const workspacePath = instanceManager.getInstance(instanceId)?.workingDirectory;
          if (!workspacePath) {
            throw new Error('Calling instance has no working directory for the review artifact');
          }
          const requestingInstance = instanceManager.getInstance(instanceId);
          const session = await getDocReviewService().createSession({
            instanceId,
            historyThreadId: requestingInstance?.historyThreadId,
            sessionId: requestingInstance?.providerSessionId,
            workspacePath,
            artifactPath,
            title,
            sourcePath,
          });
          return { reviewId: session.id };
        },
        getDocReviewResult: (reviewId) => getDocReviewService().getSession(reviewId) ?? null,
        listNodeFiles: fileTransferTools.listNodeFiles,
        findNodeFiles: fileTransferTools.findNodeFiles,
        getNodeFileInfo: fileTransferTools.getNodeFileInfo,
        downloadFromNode: fileTransferTools.downloadFromNode,
        uploadToNode: fileTransferTools.uploadToNode,
        syncToNode: fileTransferTools.syncToNode,
        syncFromNode: fileTransferTools.syncFromNode,
        collectBrowserDownload: fileTransferTools.collectBrowserDownload,
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
