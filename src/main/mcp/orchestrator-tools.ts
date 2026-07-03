import { z } from 'zod';
import { ConversationLedgerService } from '../conversation-ledger';
import type { ConversationMessageRecord } from '../../shared/types/conversation-ledger.types';
import type { OperatorRunStatus } from '../../shared/types/operator.types';
import type { SqliteDriver } from '../db/sqlite-driver';
import { ChatStore } from '../chats/chat-store';
import { GitBatchCancelledError, GitBatchService, getGitBatchService } from '../operator/git-batch-service';
import { OperatorRunStore } from '../operator/operator-run-store';
import type { McpServerToolDefinition } from './mcp-server-tools';
import { createAutomationToolDefinitions } from './orchestrator-automation-tools';
import {
  createSettingsToolDefinitions,
  type SettingsChangeBroadcaster,
  type SettingsManagerForTools,
  type UpdateNodeConfigFn,
} from './orchestrator-settings-tools';
import type {
  CreateAutomationFn,
  DeleteAutomationFn,
  ListAutomationsFn,
  PostponeAutomationFn,
  UpdateAutomationFn,
} from './orchestrator-automation-tools';

// The automation MCP tool schemas/types/definitions live in
// ./orchestrator-automation-tools (extracted to keep this file under the LOC
// ceiling). Re-export the public surface here so existing import sites
// (rpc-server, forwarder wiring, the step file) keep resolving them from this
// module.
export {
  CreateAutomationArgsSchema,
  ListAutomationsArgsSchema,
  DeleteAutomationArgsSchema,
  UpdateAutomationArgsSchema,
  PostponeAutomationArgsSchema,
} from './orchestrator-automation-tools';
export type {
  CreateAutomationArgs,
  CreateAutomationResult,
  CreateAutomationFn,
  ListAutomationsArgs,
  AutomationSummaryToolInfo,
  ListAutomationsResult,
  ListAutomationsFn,
  AutomationMutationResult,
  UpdateAutomationResult,
  PostponeAutomationResult,
  DeleteAutomationArgs,
  DeleteAutomationResult,
  DeleteAutomationFn,
  UpdateAutomationArgs,
  UpdateAutomationFn,
  PostponeAutomationArgs,
  PostponeAutomationFn,
} from './orchestrator-automation-tools';

export const GitBatchPullArgsSchema = z.object({
  root: z.string().min(1),
  ignore: z.array(z.string()).optional(),
  concurrency: z.number().int().min(1).max(16).optional(),
});

export type GitBatchPullArgs = z.infer<typeof GitBatchPullArgsSchema>;

export const ListRemoteNodesArgsSchema = z.object({}).strict();

export type ListRemoteNodesArgs = z.infer<typeof ListRemoteNodesArgsSchema>;

export interface RemoteNodeToolInfo {
  id: string;
  name: string;
  status: 'connecting' | 'connected' | 'degraded' | 'disconnected';
  platform: string;
  arch: string;
  supportedClis: string[];
  hasBrowserRuntime: boolean;
  hasBrowserMcp: boolean;
  hasDocker: boolean;
  gpuName?: string;
  gpuMemoryMB?: number;
  activeInstances: number;
  maxConcurrentInstances: number;
  workingDirectories: string[];
  lastHeartbeat?: number;
  latencyMs?: number;
}

export interface ListRemoteNodesResult {
  connectedCount: number;
  totalCount: number;
  nodes: RemoteNodeToolInfo[];
}

export type ListRemoteNodesFn = () => Promise<ListRemoteNodesResult>;

export const REMOTE_NODE_DISCOVERY_HINT =
  'Harness can use connected remote worker nodes, including Windows PCs, other machines, remote machines, and another computer, through list_remote_nodes, run_on_node, read_node_output, and terminate_node_instance. Call list_remote_nodes first when reachability matters. Terminate finished run_on_node instances when you are done with them — idle agents hold a capacity slot on the node until terminated.';

export const RunOnNodeArgsSchema = z.object({
  /**
   * Target worker node by name (e.g. "windows-pc") or node id (UUID). Optional:
   * when omitted and exactly one node is connected, that node is used.
   */
  node: z.string().min(1).optional(),
  /** Natural-language task / instruction for the agent on the node. */
  prompt: z.string().min(1),
  /**
   * Working directory on the node. Optional — when omitted, the node's first
   * advertised working directory is used (project-less spawn), mirroring the
   * `/run-on` channel command.
   */
  workingDirectory: z.string().min(1).optional(),
  /** CLI provider to use on the node (defaults to the node/app default). */
  provider: z.enum(['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor']).optional(),
  /** Optional model override. */
  model: z.string().min(1).optional(),
});

export type RunOnNodeArgs = z.infer<typeof RunOnNodeArgsSchema>;

export interface RunOnNodeResult {
  instanceId: string;
  nodeId: string;
  nodeName: string;
  workingDirectory: string;
  status: string;
}

/**
 * Optional metadata threaded from the MCP tool call into the spawn so the
 * parent process can enforce the recursion-depth guard (claude2_todo #18) and
 * record spawn lineage. `callerInstanceId` is the instance whose agent invoked
 * `run_on_node` (null when the call originates outside a known instance).
 */
export interface SpawnRemoteInstanceMeta {
  callerInstanceId?: string | null;
}

/**
 * Injected by the parent process (see initialization-steps.ts). Resolves the
 * target node, picks a working directory, and spawns an instance on it via the
 * already-deployed `instance.spawn` worker RPC. Kept as an injected function so
 * `orchestrator-tools.ts` never imports the instance manager / remote-node
 * singletons directly (which would couple this module to heavy main-process
 * subsystems).
 *
 * The optional `meta` argument carries the calling instance id so the parent
 * can apply the spawn-depth guard; implementations that don't enforce it may
 * ignore it.
 */
export type SpawnRemoteInstanceFn = (
  args: RunOnNodeArgs,
  meta?: SpawnRemoteInstanceMeta,
) => Promise<RunOnNodeResult>;

export const TerminateNodeInstanceArgsSchema = z
  .object({
    /** Instance id returned by `run_on_node`. Mutually exclusive with allIdle. */
    instanceId: z.string().min(1).optional(),
    /** Optional node filter (name or id) for the allIdle sweep. */
    node: z.string().min(1).optional(),
    /**
     * Terminate every run_on_node-spawned instance that has finished its turn
     * (optionally scoped to `node`). Mutually exclusive with instanceId.
     */
    allIdle: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const single = typeof value.instanceId === 'string';
    const sweep = value.allIdle === true;
    if (single === sweep) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide either instanceId or allIdle: true (not both, not neither)',
      });
    }
    if (single && value.node) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'node can only be combined with allIdle: true',
      });
    }
  });

export type TerminateNodeInstanceArgs = z.infer<typeof TerminateNodeInstanceArgsSchema>;

export interface TerminateNodeInstanceResult {
  /** Instances that were terminated by this call. */
  terminated: { instanceId: string }[];
  /** Instances considered but left alone, with the reason. */
  skipped: { instanceId: string; reason: string }[];
}

/**
 * Injected by the parent process (see orchestrator-tools-step.ts). Terminates
 * run_on_node-spawned instances only — implementations must refuse instances
 * that lack the `spawnDepth` lineage marker so MCP callers can never kill the
 * user's own interactive sessions.
 */
export type TerminateNodeInstancesFn = (
  args: TerminateNodeInstanceArgs,
) => Promise<TerminateNodeInstanceResult>;

export const ReadNodeOutputArgsSchema = z.object({
  /** Instance id returned by `run_on_node`. */
  instanceId: z.string().min(1),
  /** Max number of most-recent messages to return (default 100). */
  limit: z.number().int().min(1).max(500).optional(),
  /**
   * Optionally block up to this many milliseconds, polling until the instance
   * finishes its turn (leaves a "working" state). 0/omitted returns immediately
   * with whatever is buffered so far. Capped well under the RPC timeout.
   */
  waitMs: z.number().int().min(0).max(120_000).optional(),
});

export type ReadNodeOutputArgs = z.infer<typeof ReadNodeOutputArgsSchema>;

export interface NodeOutputMessage {
  type: 'assistant' | 'user' | 'system' | 'tool_use' | 'tool_result' | 'error';
  content: string;
  timestamp: number;
}

export interface ReadNodeOutputResult {
  instanceId: string;
  status: string;
  /** True when the instance is no longer actively working (turn complete). */
  done: boolean;
  /** Total messages in the buffer (before the `limit` slice). */
  messageCount: number;
  /** True when older messages were dropped by `limit` or content was capped. */
  truncated: boolean;
  messages: NodeOutputMessage[];
}

/**
 * Injected by the parent process (see initialization-steps.ts). Reads a
 * remote-spawned instance's output buffer + status. Returns null when the
 * instance id is unknown. Kept injected for the same reason as
 * {@link SpawnRemoteInstanceFn}.
 */
export type ReadInstanceOutputFn = (
  args: ReadNodeOutputArgs,
) => Promise<ReadNodeOutputResult | null>;

export interface OrchestratorToolRuntimeContext {
  db: SqliteDriver;
  instanceId?: string | null;
  ledger?: ConversationLedgerService | null;
  gitBatchService?: GitBatchService;
  listRemoteNodes?: ListRemoteNodesFn | null;
  spawnRemoteInstance?: SpawnRemoteInstanceFn | null;
  readInstanceOutput?: ReadInstanceOutputFn | null;
  terminateNodeInstances?: TerminateNodeInstancesFn | null;
  settingsManager?: SettingsManagerForTools | null;
  broadcastSettingsChange?: SettingsChangeBroadcaster | null;
  updateNodeConfig?: UpdateNodeConfigFn | null;
  createAutomation?: CreateAutomationFn | null;
  listAutomations?: ListAutomationsFn | null;
  deleteAutomation?: DeleteAutomationFn | null;
  updateAutomation?: UpdateAutomationFn | null;
  postponeAutomation?: PostponeAutomationFn | null;
}

const SOURCE_CONTEXT_MESSAGE_LIMIT = 200;

interface SourceContext {
  chatId: string | null;
  threadId: string;
  sourceMessageId: string;
}

export function createOrchestratorToolDefinitions(
  context: OrchestratorToolRuntimeContext,
): McpServerToolDefinition[] {
  const runStore = new OperatorRunStore(context.db);
  const chatStore = new ChatStore(context.db);
  const gitBatchService = context.gitBatchService ?? getGitBatchService();

  return [
    {
      name: 'git_batch_pull',
      description: 'Discover Git repositories below a root path and safely fetch plus fast-forward pull clean tracking branches. Dirty, detached, divergent, no-upstream, and no-remote repositories are skipped with reasons.',
      inputSchema: {
        type: 'object',
        properties: {
          root: {
            type: 'string',
            description: 'Root directory to scan for Git repositories.',
          },
          ignore: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional ignore patterns passed to repository discovery.',
          },
          concurrency: {
            type: 'integer',
            minimum: 1,
            maximum: 16,
            description: 'Maximum repositories to process concurrently. Defaults to 6.',
          },
        },
        required: ['root'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = GitBatchPullArgsSchema.parse(args);
        const source = await resolveSourceContext({
          chatStore,
          ledger: context.ledger ?? null,
          instanceId: context.instanceId ?? null,
        });
        const startedAt = Date.now();
        const run = runStore.createRun({
          threadId: source.threadId,
          sourceMessageId: source.sourceMessageId,
          title: 'git_batch_pull',
          goal: `Pull Git repositories under ${parsed.root}`,
          planJson: {
            tool: 'git_batch_pull',
            chatId: source.chatId,
            instanceId: context.instanceId ?? null,
            messageId: source.sourceMessageId,
          },
        });
        const node = runStore.createNode({
          runId: run.id,
          type: 'git-batch',
          targetPath: parsed.root,
          title: 'git_batch_pull',
          inputJson: {
            root: parsed.root,
            ignore: parsed.ignore ?? [],
            concurrency: parsed.concurrency ?? null,
            chatId: source.chatId,
            instanceId: context.instanceId ?? null,
            messageId: source.sourceMessageId,
          },
        });

        runStore.updateRun(run.id, {
          status: 'running',
          usageJson: { nodesStarted: 1 },
        });
        runStore.updateNode(node.id, { status: 'running' });
        runStore.appendEvent({
          runId: run.id,
          nodeId: node.id,
          kind: 'progress',
          payload: {
            action: 'git-batch-started',
            root: parsed.root,
            chatId: source.chatId,
            instanceId: context.instanceId ?? null,
          },
        });

        try {
          const summary = await gitBatchService.pullAll(parsed.root, {
            concurrency: parsed.concurrency,
            ignorePatterns: parsed.ignore,
            shouldCancel: () => runStore.getRun(run.id)?.status === 'cancelled',
            onShellCommand: (payload) => {
              runStore.appendEvent({
                runId: run.id,
                nodeId: node.id,
                kind: 'shell-command',
                payload,
              });
            },
          });
          const completedAt = Date.now();
          const wallClockMs = completedAt - startedAt;
          runStore.updateNode(node.id, {
            status: 'completed',
            completedAt,
            outputJson: { summary },
          });
          runStore.updateRun(run.id, {
            status: 'completed',
            completedAt,
            usageJson: {
              nodesCompleted: 1,
              wallClockMs,
            },
            resultJson: { summary },
          });
          runStore.appendEvent({
            runId: run.id,
            nodeId: node.id,
            kind: 'progress',
            payload: {
              action: 'git-batch-completed',
              root: summary.rootPath,
              total: summary.total,
              pulled: summary.pulled,
              upToDate: summary.upToDate,
              skipped: summary.skipped,
              failed: summary.failed,
              wallClockMs,
            },
          });
          return {
            runId: run.id,
            nodeId: node.id,
            ...summary,
          };
        } catch (error) {
          const status: OperatorRunStatus = error instanceof GitBatchCancelledError
            || runStore.getRun(run.id)?.status === 'cancelled'
            ? 'cancelled'
            : 'failed';
          const completedAt = Date.now();
          const message = error instanceof Error ? error.message : String(error);
          runStore.updateNode(node.id, {
            status,
            completedAt,
            error: status === 'cancelled' ? 'Cancelled by user' : message,
          });
          runStore.updateRun(run.id, {
            status,
            completedAt,
            error: status === 'cancelled' ? 'Cancelled by user' : message,
            usageJson: {
              wallClockMs: completedAt - startedAt,
            },
          });
          runStore.appendEvent({
            runId: run.id,
            nodeId: node.id,
            kind: 'state-change',
            payload: {
              status,
              error: status === 'cancelled' ? 'Cancelled by user' : message,
            },
          });
          if (status === 'cancelled') {
            return {
              runId: run.id,
              nodeId: node.id,
              status,
              cancelled: true,
            };
          }
          throw error;
        }
      },
    },
    {
      name: 'list_remote_nodes',
      description:
        `${REMOTE_NODE_DISCOVERY_HINT} Lists currently registered remote worker nodes with status, platform, supported CLIs, browser/GPU/Docker capabilities, active capacity, working directories, heartbeat, and latency. Read-only; does not spawn work.`,
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      handler: async (args) => {
        ListRemoteNodesArgsSchema.parse(args);
        if (!context.listRemoteNodes) {
          throw new Error(
            'list_remote_nodes is unavailable: remote node listing is not wired in this process',
          );
        }
        return context.listRemoteNodes();
      },
    },
    {
      name: 'run_on_node',
      description:
        `${REMOTE_NODE_DISCOVERY_HINT} Run a task on a connected remote worker node, such as a Windows PC, other machine, remote machine, or another computer, by spawning an AI agent there with the given prompt. The agent runs project-lessly using the node's default working directory unless one is provided. Returns immediately with the spawned instance id; output streams asynchronously and can be inspected from the app or read with read_node_output.`,
      inputSchema: {
        type: 'object',
        properties: {
          node: {
            type: 'string',
            description:
              'Target worker node by name (e.g. "windows-pc") or node id (UUID). Optional: when omitted and exactly one node is connected, that node is used.',
          },
          prompt: {
            type: 'string',
            description: 'Natural-language task / instruction for the agent on the node.',
          },
          workingDirectory: {
            type: 'string',
            description:
              "Working directory on the node. Optional — defaults to the node's first advertised working directory (project-less spawn).",
          },
          provider: {
            type: 'string',
            enum: ['claude', 'codex', 'gemini', 'antigravity', 'copilot', 'cursor'],
            description: 'CLI provider to use on the node (defaults to the node/app default).',
          },
          model: {
            type: 'string',
            description: 'Optional model override.',
          },
        },
        required: ['prompt'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = RunOnNodeArgsSchema.parse(args);
        if (!context.spawnRemoteInstance) {
          throw new Error(
            'run_on_node is unavailable: remote instance spawning is not wired in this process',
          );
        }
        // Thread the calling instance id so the parent process can enforce the
        // spawn-depth recursion guard and record lineage (claude2_todo #18).
        return context.spawnRemoteInstance(parsed, {
          callerInstanceId: context.instanceId ?? null,
        });
      },
    },
    {
      name: 'read_node_output',
      description:
        'Read the output produced by an instance previously started with run_on_node. Returns the most recent messages (assistant text, tool calls/results, errors), the instance status, and a `done` flag indicating whether the turn has completed. Optionally waits a bounded time for the turn to finish.',
      inputSchema: {
        type: 'object',
        properties: {
          instanceId: {
            type: 'string',
            description: 'Instance id returned by run_on_node.',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 500,
            description: 'Max number of most-recent messages to return (default 100).',
          },
          waitMs: {
            type: 'integer',
            minimum: 0,
            maximum: 120000,
            description:
              'Optionally block up to this many milliseconds, polling until the turn completes. 0/omitted returns immediately.',
          },
        },
        required: ['instanceId'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = ReadNodeOutputArgsSchema.parse(args);
        if (!context.readInstanceOutput) {
          throw new Error(
            'read_node_output is unavailable: remote output reading is not wired in this process',
          );
        }
        const result = await context.readInstanceOutput(parsed);
        if (!result) {
          throw new Error(`Instance not found: ${parsed.instanceId}`);
        }
        return result;
      },
    },
    {
      name: 'terminate_node_instance',
      description:
        'Terminate agent instances previously spawned with run_on_node, freeing the worker node\'s capacity. Two modes: pass instanceId to terminate one specific instance (even if still working), or pass allIdle: true (optionally with node) to clean up every finished run_on_node instance. Idle one-shot agents otherwise stay alive and count against the node\'s maxConcurrentInstances until terminated. Only run_on_node-spawned instances can be terminated; interactive user sessions are never touched.',
      inputSchema: {
        type: 'object',
        properties: {
          instanceId: {
            type: 'string',
            description:
              'Instance id returned by run_on_node. Mutually exclusive with allIdle.',
          },
          node: {
            type: 'string',
            description:
              'Optional node name or id to scope the allIdle sweep to one worker node.',
          },
          allIdle: {
            type: 'boolean',
            description:
              'Terminate every finished run_on_node instance (optionally scoped to node). Mutually exclusive with instanceId.',
          },
        },
        required: [],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = TerminateNodeInstanceArgsSchema.parse(args);
        if (!context.terminateNodeInstances) {
          throw new Error(
            'terminate_node_instance is unavailable: remote instance termination is not wired in this process',
          );
        }
        return context.terminateNodeInstances(parsed);
      },
    },
    ...createSettingsToolDefinitions(context),
    ...createAutomationToolDefinitions(context),
  ];
}

async function resolveSourceContext(input: {
  chatStore: ChatStore;
  ledger: ConversationLedgerService | null;
  instanceId: string | null;
}): Promise<SourceContext> {
  const chat = input.instanceId ? input.chatStore.getByInstanceId(input.instanceId) : null;
  const fallbackMessageId = `mcp-tool:${Date.now()}`;
  if (!chat) {
    return {
      chatId: null,
      threadId: 'mcp-standalone',
      sourceMessageId: fallbackMessageId,
    };
  }

  let sourceMessageId = fallbackMessageId;
  if (input.ledger) {
    try {
      const conversation = await input.ledger.getRecentConversation(
        chat.ledgerThreadId,
        SOURCE_CONTEXT_MESSAGE_LIMIT,
      );
      const latestToolCall = findLatestMessage(conversation.messages, (message) =>
        message.phase === 'tool_call'
        || asRecord(message.rawJson?.['metadata'])?.['kind'] === 'tool_call'
      );
      const latestUser = findLatestMessage(conversation.messages, (message) => message.role === 'user');
      sourceMessageId = latestToolCall?.id ?? latestUser?.id ?? sourceMessageId;
    } catch {
      sourceMessageId = fallbackMessageId;
    }
  }

  return {
    chatId: chat.id,
    threadId: chat.ledgerThreadId,
    sourceMessageId,
  };
}

function findLatestMessage(
  messages: ConversationMessageRecord[],
  predicate: (message: ConversationMessageRecord) => boolean,
): ConversationMessageRecord | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (predicate(messages[index])) {
      return messages[index];
    }
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
