import { existsSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { getLogger } from '../../logging/logger';
import {
  connectToAppServer,
  type CodexAppServerClientInstance,
  SERVICE_NAME,
} from '../../cli/adapters/codex/app-server-client';
import type {
  ThreadInfo,
  ThreadItem,
  ThreadSourceKind,
  Turn,
  UserInput,
} from '../../cli/adapters/codex/app-server-types';
import type {
  ConversationDiscoveryScope,
  ConversationMessageUpsertInput,
  NativeConversationCapabilities,
  NativeConversationHandle,
  NativeConversationRef,
  NativeConversationSnapshot,
  NativeConversationThread,
  NativeThreadStartRequest,
  NativeTurnRequest,
  NativeTurnResult,
  ReconciliationResult,
} from '../../../shared/types/conversation-ledger.types';
import type { NativeConversationAdapter } from '../native-conversation-adapter';
import { NativeConversationError } from '../native-conversation-adapter';
import { parseCodexRolloutFile } from './codex-rollout-parser';

const logger = getLogger('CodexNativeConversationAdapter');

type AppServerClientFactory = (cwd: string) => Promise<CodexAppServerClientInstance>;

const DEFAULT_DISCOVERY_SOURCES: ThreadSourceKind[] = ['cli', 'vscode', 'appServer'];
const CHILD_DISCOVERY_SOURCES: ThreadSourceKind[] = [
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
];

export interface CodexNativeConversationAdapterDeps {
  appServerClientFactory?: AppServerClientFactory;
  sessionsDir?: string;
  clock?: () => number;
}

export class CodexNativeConversationAdapter implements NativeConversationAdapter {
  readonly provider = 'codex' as const;
  private readonly clientFactory: AppServerClientFactory;
  private readonly sessionsDir: string;
  private readonly clock: () => number;

  constructor(deps: CodexNativeConversationAdapterDeps = {}) {
    this.clientFactory = deps.appServerClientFactory ?? ((cwd) => connectToAppServer(cwd));
    this.sessionsDir = deps.sessionsDir ?? join(homedir(), '.codex', 'sessions');
    this.clock = deps.clock ?? (() => Date.now());
  }

  getCapabilities(): NativeConversationCapabilities {
    return {
      provider: 'codex',
      canDiscover: true,
      canRead: true,
      canCreate: true,
      canResume: true,
      canSendTurns: true,
      canReconcile: true,
      durableByDefault: true,
      nativeVisibilityMode: 'app-server-durable',
    };
  }

  async discover(scope: ConversationDiscoveryScope): Promise<NativeConversationThread[]> {
    const discovered = new Map<string, NativeConversationThread>();
    const cwd = scope.workspacePath ?? process.cwd();
    const sourceKinds = this.discoverySourceKinds(scope);

    try {
      await this.withClient(cwd, async (client) => {
        const result = await client.request('thread/list', {
          limit: scope.limit ?? 50,
          cwd: scope.workspacePath ?? null,
          sourceKinds,
          archived: false,
        });
        for (const thread of result.data) {
          const mapped = this.mapThreadInfo(thread);
          if (!scope.workspacePath || mapped.workspacePath === scope.workspacePath) {
            discovered.set(mapped.nativeThreadId, mapped);
          }
        }
      });
    } catch (error) {
      logger.warn('Codex app-server discovery failed; falling back to rollout scan', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    for (const filePath of this.collectRolloutFiles()) {
      try {
        const snapshot = parseCodexRolloutFile(filePath);
        if (scope.workspacePath && snapshot.thread.workspacePath !== scope.workspacePath) continue;
        if (!scope.includeChildThreads && isChildSource(snapshot.thread.nativeSourceKind)) continue;
        discovered.set(snapshot.thread.nativeThreadId, snapshot.thread);
      } catch (error) {
        logger.debug('Skipping unreadable Codex rollout during discovery', {
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return Array.from(discovered.values())
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      .slice(0, scope.limit ?? 100);
  }

  async readThread(ref: NativeConversationRef): Promise<NativeConversationSnapshot> {
    try {
      return await this.withClient(ref.workspacePath ?? process.cwd(), async (client) => {
        const response = await client.request('thread/read', {
          threadId: ref.nativeThreadId,
          includeTurns: true,
        });
        return this.snapshotFromThreadInfo(response.thread, ref.sourcePath ?? null);
      });
    } catch (error) {
      if (ref.sourcePath && existsSync(ref.sourcePath)) {
        return parseCodexRolloutFile(ref.sourcePath);
      }
      throw new NativeConversationError(
        `Unable to read Codex thread ${ref.nativeThreadId}`,
        'CODEX_READ_FAILED',
        'codex',
        error,
      );
    }
  }

  async startThread(request: NativeThreadStartRequest): Promise<NativeConversationHandle> {
    const cwd = request.workspacePath;
    if (!cwd) {
      throw new NativeConversationError('Codex conversations require a workspace path', 'CODEX_WORKSPACE_REQUIRED', 'codex');
    }
    return this.withClient(cwd, async (client) => {
      const response = await client.request('thread/start', {
        cwd,
        model: request.model ?? null,
        approvalPolicy: normalizeApprovalPolicy(request.approvalPolicy) ?? 'never',
        sandbox: request.sandbox === 'danger-full-access' ? 'danger-full-access' : 'workspace-write',
        serviceName: SERVICE_NAME,
        ephemeral: request.ephemeral ?? false,
        reasoningEffort: normalizeReasoningEffort(request.reasoningEffort),
        effort: normalizeReasoningEffort(request.reasoningEffort),
        personality: request.personality ?? null,
      });
      const thread = response.thread;
      const nativeThreadId = response.threadId || thread?.id;
      if (!nativeThreadId) {
        throw new NativeConversationError('Codex did not return a thread id', 'CODEX_START_FAILED', 'codex');
      }
      return {
        provider: 'codex',
        nativeThreadId,
        nativeSessionId: nativeThreadId,
        workspacePath: cwd,
        title: request.title ?? thread?.name ?? null,
        metadata: { ephemeral: request.ephemeral ?? false },
      };
    });
  }

  async resumeThread(ref: NativeConversationRef): Promise<NativeConversationHandle> {
    return this.withClient(ref.workspacePath ?? process.cwd(), async (client) => {
      const response = await client.request('thread/resume', {
        threadId: ref.nativeThreadId,
        cwd: ref.workspacePath ?? null,
      });
      return {
        provider: 'codex',
        nativeThreadId: response.threadId || ref.nativeThreadId,
        nativeSessionId: response.threadId || ref.nativeThreadId,
        workspacePath: ref.workspacePath ?? null,
        title: response.thread?.name ?? null,
      };
    });
  }

  async sendTurn(ref: NativeConversationRef, request: NativeTurnRequest): Promise<NativeTurnResult> {
    return this.withClient(ref.workspacePath ?? process.cwd(), async (client) => {
      const response = await client.request('turn/start', {
        threadId: ref.nativeThreadId,
        input: request.inputItems?.length ? request.inputItems.map(inputItemToCodex) : [{
          type: 'text',
          text: request.text,
          text_elements: [],
        }],
        cwd: ref.workspacePath ?? null,
        model: request.model ?? null,
        approvalPolicy: normalizeApprovalPolicy(request.approvalPolicy),
        effort: normalizeReasoningEffort(request.reasoningEffort),
        reasoningEffort: normalizeReasoningEffort(request.reasoningEffort),
      });
      const turn = response.turn;
      const messages = turn?.items?.flatMap((item, index) =>
        this.threadItemToMessages(item, turn.id, this.clock(), index + 1)
      ) ?? [{
        nativeTurnId: turn?.id ?? null,
        role: 'user' as const,
        content: request.text,
        createdAt: this.clock(),
        sequence: 1,
      }];
      return {
        provider: 'codex',
        nativeThreadId: ref.nativeThreadId,
        nativeTurnId: turn?.id ?? null,
        messages,
        metadata: { status: turn?.status ?? null },
      };
    });
  }

  async reconcile(ref: NativeConversationRef): Promise<ReconciliationResult> {
    const snapshot = await this.readThread(ref);
    return {
      threadId: ref.threadId,
      provider: 'codex',
      nativeThreadId: ref.nativeThreadId,
      addedMessages: snapshot.messages.length,
      updatedMessages: 0,
      deletedMessages: 0,
      cursor: snapshot.cursor,
      syncStatus: 'synced',
      conflictStatus: 'none',
      warnings: snapshot.warnings,
      metadata: { sourcePath: snapshot.thread.sourcePath },
    };
  }

  private async withClient<T>(cwd: string, fn: (client: CodexAppServerClientInstance) => Promise<T>): Promise<T> {
    const client = await this.clientFactory(cwd);
    try {
      return await fn(client);
    } finally {
      await client.close().catch(() => {
        // Best-effort cleanup.
      });
    }
  }

  private snapshotFromThreadInfo(thread: ThreadInfo, sourcePath: string | null): NativeConversationSnapshot {
    const mapped = this.mapThreadInfo(thread);
    let sequence = 0;
    const messages: ConversationMessageUpsertInput[] = [];
    for (const turn of thread.turns ?? []) {
      for (const item of turn.items ?? []) {
        const itemMessages = this.threadItemToMessages(item, turn.id, toMs(turn.startedAt) ?? mapped.updatedAt ?? this.clock(), sequence + 1);
        for (const message of itemMessages) {
          sequence += 1;
          messages.push({ ...message, sequence });
        }
      }
    }
    return {
      thread: { ...mapped, sourcePath: sourcePath ?? mapped.sourcePath ?? null },
      messages,
      cursor: {
        threadId: '',
        provider: 'codex',
        cursorKind: 'codex-app-server-read',
        cursorValue: String(messages.length),
        sourcePath,
        updatedAt: this.clock(),
      },
      warnings: [],
      rawRefs: [],
    };
  }

  private mapThreadInfo(thread: ThreadInfo): NativeConversationThread {
    const sourceKind = normalizeThreadSource(thread.source);
    return {
      provider: 'codex',
      nativeThreadId: thread.id,
      nativeSessionId: thread.id,
      nativeSourceKind: sourceKind,
      sourcePath: verifiedThreadPath(thread.path, thread.id),
      workspacePath: typeof thread.cwd === 'string' ? thread.cwd : null,
      title: thread.name ?? thread.preview ?? null,
      createdAt: toMs(thread.createdAt),
      updatedAt: toMs(thread.updatedAt),
      writable: true,
      nativeVisibilityMode: 'app-server-durable',
      metadata: {
        modelProvider: thread.modelProvider,
        status: thread.status,
        ephemeral: thread.ephemeral,
      },
    };
  }

  private threadItemToMessages(
    item: ThreadItem,
    turnId: string | null,
    createdAt: number,
    sequence: number
  ): ConversationMessageUpsertInput[] {
    switch (item.type) {
      case 'userMessage':
        const content = (item as { content?: unknown }).content;
        return [{
          nativeMessageId: item.id,
          nativeTurnId: turnId,
          role: 'user',
          content: Array.isArray(content) ? userInputToText(content as UserInput[]) : String(content ?? ''),
          createdAt,
          rawJson: item,
          sequence,
        }];
      case 'agentMessage':
        return [{
          nativeMessageId: item.id,
          nativeTurnId: turnId,
          role: 'assistant',
          phase: typeof item.phase === 'string' ? item.phase : null,
          content: item.text ?? '',
          createdAt,
          rawJson: item,
          sequence,
        }];
      case 'reasoning':
        return [{
          nativeMessageId: item.id,
          nativeTurnId: turnId,
          role: 'event',
          phase: 'reasoning',
          content: stringifyTextArray(item.summary) || stringifyTextArray(item.content) || '',
          createdAt,
          rawJson: item,
          sequence,
        }];
      case 'commandExecution':
        return [{
          nativeMessageId: item.id,
          nativeTurnId: turnId,
          role: 'tool',
          content: `${item.command ?? 'command'}${item['aggregatedOutput'] ? `\n${item['aggregatedOutput']}` : ''}`,
          createdAt,
          rawJson: item,
          sequence,
        }];
      default:
        return [];
    }
  }

  private collectRolloutFiles(): string[] {
    const files: { path: string; mtime: number }[] = [];
    const walk = (dir: string, depth: number): void => {
      if (depth > 5) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry);
        try {
          const stat = statSync(full);
          if (stat.isDirectory()) {
            walk(full, depth + 1);
          } else if (entry.startsWith('rollout-') && entry.endsWith('.jsonl')) {
            files.push({ path: full, mtime: stat.mtimeMs });
          }
        } catch {
          // Ignore inaccessible files.
        }
      }
    };
    walk(this.sessionsDir, 0);
    return files.sort((a, b) => b.mtime - a.mtime).map(file => file.path);
  }

  private discoverySourceKinds(scope: ConversationDiscoveryScope): ThreadSourceKind[] {
    const explicit = scope.sourceKinds?.filter(isThreadSourceKind) ?? [];
    if (explicit.length) return explicit;
    return scope.includeChildThreads
      ? [...DEFAULT_DISCOVERY_SOURCES, ...CHILD_DISCOVERY_SOURCES]
      : DEFAULT_DISCOVERY_SOURCES;
  }
}

function inputItemToCodex(item: NonNullable<NativeTurnRequest['inputItems']>[number]): UserInput {
  if (item.type === 'text') return { type: 'text', text: item.text ?? '', text_elements: [] };
  if (item.type === 'image') return { type: 'image', url: item.url ?? '' };
  if (item.type === 'localImage') return { type: 'localImage', path: item.path ?? '' };
  if (item.type === 'skill') return { type: 'skill', name: item.name ?? '', path: item.path ?? '' };
  return { type: 'mention', name: item.name ?? '', path: item.path ?? '' };
}

function userInputToText(input: UserInput[]): string {
  return input.map(item => {
    if (item.type === 'text') return item.text;
    if (item.type === 'image') return item.url;
    if (item.type === 'localImage') return item.path;
    return item.name;
  }).filter(Boolean).join('\n');
}

function normalizeReasoningEffort(value: string | null | undefined) {
  return value === 'none' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh'
    ? value
    : null;
}

function normalizeApprovalPolicy(value: string | null | undefined) {
  return value === 'never'
    || value === 'always'
    || value === 'unless-allow-listed'
    || value === 'untrusted'
    || value === 'on-failure'
    || value === 'on-request'
    ? value
    : null;
}

function normalizeThreadSource(source: unknown): string {
  if (typeof source === 'string') return source;
  if (source && typeof source === 'object') {
    if ('subAgent' in source) return 'subAgent';
    if ('custom' in source && typeof (source as { custom?: unknown }).custom === 'string') {
      return (source as { custom: string }).custom;
    }
  }
  return 'unknown';
}

function isChildSource(source: string | null | undefined): boolean {
  return !!source && CHILD_DISCOVERY_SOURCES.includes(source as ThreadSourceKind);
}

function isThreadSourceKind(value: string): value is ThreadSourceKind {
  return [...DEFAULT_DISCOVERY_SOURCES, 'exec', ...CHILD_DISCOVERY_SOURCES, 'unknown'].includes(value as ThreadSourceKind);
}

function verifiedThreadPath(path: unknown, threadId: string): string | null {
  if (typeof path !== 'string' || !existsSync(path)) return null;
  return path.includes(threadId) ? path : null;
}

function toMs(value: unknown): number | undefined {
  if (typeof value === 'number') return value < 10_000_000_000 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringifyTextArray(value: unknown): string {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string').join('\n') : '';
}
