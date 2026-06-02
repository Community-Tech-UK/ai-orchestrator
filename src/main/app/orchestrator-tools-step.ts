import { getSettingsManager } from '../core/config/settings-manager';
import { initializeOrchestratorToolsRpcServer } from '../mcp/orchestrator-tools-rpc-server';
import { defaultOperatorDbPath } from '../operator/operator-database';
import { getWorkerNodeRegistry } from '../remote-node';
import { resolveWorkerNodeTarget } from '../remote-node/worker-node-registry';
import { evaluateSpawn } from '../orchestration/subagent-spawn-guard';
import { getAutomationStore } from '../automations';
import { createAutomationWithScheduling } from '../automations/automation-create-service';
import { validateCronExpression } from '../automations/automation-schedule';
import type { AutomationSchedule, CreateAutomationInput } from '../../shared/types/automation.types';
import type { Instance } from '../../shared/types/instance.types';
import type { InstanceManager } from '../instance/instance-manager';
import { getLogger } from '../logging/logger';
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
export function createOrchestratorToolsStep(instanceManager: InstanceManager): AppInitializationStep {
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
        // Backs the `create_automation` MCP tool: build a CreateAutomationInput
        // from the agent-supplied args and route it through the same
        // create+schedule service the IPC handler uses (so events fire and the
        // Automations UI updates live). Working directory defaults to the
        // calling chat's project when the agent omits it.
        createAutomation: async (args, meta) => {
          const callerInstance = meta?.callerInstanceId
            ? instanceManager.getInstance(meta.callerInstanceId)
            : undefined;
          const workingDirectory =
            args.workingDirectory?.trim() || callerInstance?.workingDirectory?.trim() || '';
          if (!workingDirectory) {
            throw new Error(
              'create_automation requires a workingDirectory; this session has no project folder set.',
            );
          }
          const timezone =
            args.timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

          let schedule: AutomationSchedule;
          if (args.cron?.trim()) {
            const expression = args.cron.trim();
            try {
              const next = validateCronExpression(expression, timezone);
              if (!next) {
                throw new Error('no upcoming run time');
              }
            } catch (error) {
              throw new Error(
                `Invalid cron expression "${expression}" (${timezone}): ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            }
            schedule = { type: 'cron', expression, timezone };
          } else {
            const runAt = Date.parse(args.runAt ?? '');
            if (Number.isNaN(runAt)) {
              throw new Error('runAt must be an ISO-8601 timestamp.');
            }
            schedule = { type: 'oneTime', runAt, timezone };
          }

          const input: CreateAutomationInput = {
            name: args.name,
            description: args.description,
            enabled: args.enabled ?? true,
            schedule,
            concurrencyPolicy: 'skip',
            action: {
              prompt: args.prompt,
              workingDirectory,
              provider: args.provider,
            },
          };

          const automation = await createAutomationWithScheduling(input);
          if (!automation) {
            throw new Error('Failed to create automation.');
          }
          const scheduleSummary =
            schedule.type === 'cron'
              ? `cron ${schedule.expression} (${timezone})`
              : `once at ${new Date(schedule.runAt).toISOString()}`;
          return {
            id: automation.id,
            name: automation.name,
            scheduleSummary,
            nextRunAt: automation.nextFireAt,
            enabled: automation.enabled,
            workingDirectory,
          };
        },
        // Backs the read-only `list_automations` MCP tool.
        listAutomations: async () => {
          const automations = await getAutomationStore().list();
          return {
            count: automations.length,
            automations: automations.map((a) => ({
              id: a.id,
              name: a.name,
              ...(a.description ? { description: a.description } : {}),
              scheduleSummary:
                a.schedule.type === 'cron'
                  ? `cron ${a.schedule.expression} (${a.schedule.timezone})`
                  : `once at ${new Date(a.schedule.runAt).toISOString()}`,
              enabled: a.enabled && a.active,
              nextRunAt: a.nextFireAt,
              lastRunAt: a.lastFiredAt,
              workingDirectory: a.action.workingDirectory,
            })),
          };
        },
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
