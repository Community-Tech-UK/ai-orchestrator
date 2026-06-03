import { z } from 'zod';
import { ConversationLedgerService } from '../conversation-ledger';
import type { ConversationMessageRecord } from '../../shared/types/conversation-ledger.types';
import type { OperatorRunStatus } from '../../shared/types/operator.types';
import type { SqliteDriver } from '../db/sqlite-driver';
import { ChatStore } from '../chats/chat-store';
import { GitBatchCancelledError, GitBatchService, getGitBatchService } from '../operator/git-batch-service';
import { OperatorRunStore } from '../operator/operator-run-store';
import type { McpServerToolDefinition } from './mcp-server-tools';

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
  'AIO can use connected remote worker nodes, including Windows PCs, other machines, remote machines, and another computer, through list_remote_nodes, run_on_node, and read_node_output. Call list_remote_nodes first when reachability matters.';

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
  provider: z.enum(['claude', 'codex', 'gemini', 'copilot', 'cursor']).optional(),
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

export const CreateAutomationArgsSchema = z
  .object({
    /** Short title for the automation (e.g. "Daily PR review"). */
    name: z.string().min(1).max(200),
    /** The instruction the scheduled agent runs each time it fires. */
    prompt: z.string().min(1).max(100_000),
    /**
     * Standard 5-field cron expression (minute hour day-of-month month
     * day-of-week) for a recurring automation. Provide this OR `runAt`.
     * Examples: daily at 8pm = "0 20 * * *"; weekdays at 9am = "0 9 * * 1-5".
     */
    cron: z.string().min(1).max(200).optional(),
    /** ISO-8601 timestamp for a one-time automation. Provide this OR `cron`. */
    runAt: z.string().min(1).max(100).optional(),
    /** IANA timezone (e.g. "America/New_York"). Defaults to the app's timezone. */
    timezone: z.string().min(1).max(100).optional(),
    /**
     * Absolute working directory the automation runs in. Optional — defaults to
     * the calling chat's project folder.
     */
    workingDirectory: z.string().min(1).max(10_000).optional(),
    /** Optional human-readable description. */
    description: z.string().max(2000).optional(),
    /** CLI provider to run with (defaults to the app default). */
    provider: z.enum(['claude', 'codex', 'gemini', 'copilot', 'cursor']).optional(),
    /** Whether the automation is active immediately. Defaults to true. */
    enabled: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.cron?.trim() && !value.runAt?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cron'],
        message: 'Provide either "cron" (recurring) or "runAt" (one-time ISO-8601 timestamp).',
      });
    }
  });

export type CreateAutomationArgs = z.infer<typeof CreateAutomationArgsSchema>;

export interface CreateAutomationResult {
  id: string;
  name: string;
  /** Human-readable schedule summary, e.g. "cron 0 20 * * * (UTC)". */
  scheduleSummary: string;
  /** Epoch ms of the next scheduled run, or null when disabled/none. */
  nextRunAt: number | null;
  enabled: boolean;
  workingDirectory: string;
}

/**
 * Injected by the parent process (see initialization-steps.ts). Creates a
 * scheduled automation via the shared create+schedule service. Kept injected so
 * `orchestrator-tools.ts` never imports the automation store/scheduler
 * singletons directly (consistent with {@link SpawnRemoteInstanceFn}).
 */
export type CreateAutomationFn = (
  args: CreateAutomationArgs,
  meta?: SpawnRemoteInstanceMeta,
) => Promise<CreateAutomationResult>;

export const ListAutomationsArgsSchema = z.object({}).strict();

export type ListAutomationsArgs = z.infer<typeof ListAutomationsArgsSchema>;

export interface AutomationSummaryToolInfo {
  id: string;
  name: string;
  description?: string;
  scheduleSummary: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  workingDirectory: string;
}

export interface ListAutomationsResult {
  count: number;
  automations: AutomationSummaryToolInfo[];
}

export type ListAutomationsFn = () => Promise<ListAutomationsResult>;

export interface OrchestratorToolRuntimeContext {
  db: SqliteDriver;
  instanceId?: string | null;
  ledger?: ConversationLedgerService | null;
  gitBatchService?: GitBatchService;
  listRemoteNodes?: ListRemoteNodesFn | null;
  spawnRemoteInstance?: SpawnRemoteInstanceFn | null;
  readInstanceOutput?: ReadInstanceOutputFn | null;
  createAutomation?: CreateAutomationFn | null;
  listAutomations?: ListAutomationsFn | null;
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
            enum: ['claude', 'codex', 'gemini', 'copilot', 'cursor'],
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
      name: 'create_automation',
      description:
        'Create a scheduled automation in AIO: a recurring (cron) or one-time prompt that runs an autonomous agent on a schedule. This is the ONLY correct way to schedule or automate anything inside AI Orchestrator — use it whenever the user asks to "set up an automation", "run this every day/week", "schedule this", "check X every hour", or "remind me to…". Do NOT use a host CLI scheduling skill (e.g. Claude Code\'s /schedule or CronCreate): those create cloud remote agents that run in an isolated sandbox with NO browser and no access to the user\'s logged-in sessions, and the user cannot see or manage them in AIO. AIO automations are different: they run LOCALLY on this machine, and each scheduled run spawns a fresh local agent that inherits the SAME tools as this chat — including the browser gateway to the user\'s real, authenticated Chrome (real cookies). That means an automation CAN read pages/sites the user is logged into, as long as the app and the user\'s browser are running when it fires. Provide a 5-field cron expression for recurring schedules, or an ISO-8601 runAt for a one-time run. The working directory defaults to the current chat\'s project. Returns the created automation\'s id, schedule summary, and next run time.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Short title for the automation.' },
          prompt: {
            type: 'string',
            description: 'The instruction the scheduled agent runs each time it fires.',
          },
          cron: {
            type: 'string',
            description:
              'Standard 5-field cron expression for a recurring schedule (minute hour day-of-month month day-of-week). Provide this OR runAt. E.g. daily at 8pm = "0 20 * * *"; weekdays at 9am = "0 9 * * 1-5".',
          },
          runAt: {
            type: 'string',
            description: 'ISO-8601 timestamp for a one-time automation. Provide this OR cron.',
          },
          timezone: {
            type: 'string',
            description: 'IANA timezone (e.g. "America/New_York"). Defaults to the app timezone.',
          },
          workingDirectory: {
            type: 'string',
            description:
              "Absolute working directory the automation runs in. Optional — defaults to the calling chat's project folder.",
          },
          description: { type: 'string', description: 'Optional human-readable description.' },
          provider: {
            type: 'string',
            enum: ['claude', 'codex', 'gemini', 'copilot', 'cursor'],
            description: 'CLI provider to run with (defaults to the app default).',
          },
          enabled: {
            type: 'boolean',
            description: 'Whether the automation is active immediately. Defaults to true.',
          },
        },
        required: ['name', 'prompt'],
        additionalProperties: false,
      },
      handler: async (args) => {
        const parsed = CreateAutomationArgsSchema.parse(args);
        if (!context.createAutomation) {
          throw new Error(
            'create_automation is unavailable: automation creation is not wired in this process',
          );
        }
        return context.createAutomation(parsed, {
          callerInstanceId: context.instanceId ?? null,
        });
      },
    },
    {
      name: 'list_automations',
      description:
        'List the scheduled automations configured in AIO, with their schedule, enabled state, next/last run times, and working directory. Read-only. Use this to check what automations already exist before creating or describing them.',
      inputSchema: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      handler: async (args) => {
        ListAutomationsArgsSchema.parse(args);
        if (!context.listAutomations) {
          throw new Error(
            'list_automations is unavailable: automation listing is not wired in this process',
          );
        }
        return context.listAutomations();
      },
    },
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
