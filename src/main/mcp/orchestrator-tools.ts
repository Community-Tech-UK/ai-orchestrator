import { z } from 'zod';
import { NativeConversationRegistry } from '../conversation-ledger/native-conversation-registry';
import { ConversationLedgerService } from '../conversation-ledger';
import type { ConversationMessageRecord } from '../../shared/types/conversation-ledger.types';
import type { OperatorRunStatus } from '../../shared/types/operator.types';
import type { SqliteDriver } from '../db/sqlite-driver';
import { ChatStore } from '../chats/chat-store';
import { GitBatchCancelledError, GitBatchService, getGitBatchService } from '../operator/git-batch-service';
import { OperatorRunStore } from '../operator/operator-run-store';
import type { McpServerToolDefinition } from './mcp-server-tools';

const GitBatchPullArgsSchema = z.object({
  root: z.string().min(1),
  ignore: z.array(z.string()).optional(),
  concurrency: z.number().int().min(1).max(16).optional(),
});

export interface OrchestratorToolRuntimeContext {
  db: SqliteDriver;
  instanceId?: string | null;
  ledger?: ConversationLedgerService | null;
  gitBatchService?: GitBatchService;
}

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
        const source = resolveSourceContext({
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
  ];
}

export function createLedgerForOrchestratorTools(dbPath: string): ConversationLedgerService {
  return new ConversationLedgerService({
    dbPath,
    enableWAL: false,
    registry: new NativeConversationRegistry(),
  });
}

function resolveSourceContext(input: {
  chatStore: ChatStore;
  ledger: ConversationLedgerService | null;
  instanceId: string | null;
}): SourceContext {
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
      const conversation = input.ledger.getConversation(chat.ledgerThreadId);
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
