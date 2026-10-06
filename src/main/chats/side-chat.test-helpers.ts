import { EventEmitter } from 'node:events';
import { ConversationLedgerService } from '../conversation-ledger';
import { NativeConversationRegistry } from '../conversation-ledger/native-conversation-registry';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createOperatorTables } from '../operator/operator-schema';
import {
  createInstance,
  type FileAttachment,
  type Instance,
  type InstanceCreateConfig,
  type OutputMessage,
} from '../../shared/types/instance.types';
import type { AgentToolPermissions } from '../../shared/types/agent.types';
import { BUILTIN_AGENTS } from '../../shared/types/agent.types';
import type { ChatEvent } from '../../shared/types/chat.types';
import { BranchSummarizer } from '../context/branch-summarizer';
import { ChatService } from './chat-service';
import type { SideChatArchiveLookup } from './side-chat-parent-resolver';

/** Runtime stand-in recording every spawn, input, preamble and termination. */
export class FakeRuntimeManager extends EventEmitter {
  readonly creates: InstanceCreateConfig[] = [];
  readonly inputs: { instanceId: string; message: string; attachments?: FileAttachment[] }[] = [];
  /** Preamble consumed by each send, aligned with `inputs`. */
  readonly preambles: (string | undefined)[] = [];
  readonly terminations: string[] = [];
  private readonly instances = new Map<string, Instance>();
  private readonly pendingPreambles = new Map<string, string>();

  async createInstance(config: InstanceCreateConfig): Promise<Instance> {
    this.creates.push(config);
    const instance = createInstance(config);
    instance.status = 'idle';
    instance.toolPermissionsOverride = config.toolPermissionsOverride;
    instance.hardened = config.hardened;
    instance.containedExecution = config.containedExecution;
    instance.workerNodeId = config.forceNodeId;
    this.instances.set(instance.id, instance);
    return instance;
  }

  /** Add a standalone (non-chat) session, as the dashboard's instance list shows. */
  addSession(input: {
    historyThreadId: string;
    workingDirectory: string;
    displayName: string;
    agentId?: string;
    yoloMode?: boolean;
    workerNodeId?: string;
    transcript?: Array<{ type: 'user' | 'assistant'; content: string }>;
  }): Instance {
    const instance = createInstance({
      workingDirectory: input.workingDirectory,
      displayName: input.displayName,
      historyThreadId: input.historyThreadId,
      agentId: input.agentId,
      yoloMode: input.yoloMode ?? true,
    });
    instance.status = 'busy';
    instance.workerNodeId = input.workerNodeId;
    instance.outputBuffer = (input.transcript ?? []).map((turn, index): OutputMessage => ({
      id: `${input.historyThreadId}-${index}`,
      type: turn.type,
      content: turn.content,
      timestamp: 1_000 + index,
    }));
    this.instances.set(instance.id, instance);
    return instance;
  }

  getInstance(instanceId: string): Instance | undefined {
    return this.instances.get(instanceId);
  }

  getAllInstances(): Instance[] {
    return [...this.instances.values()];
  }

  queueContinuityPreamble(instanceId: string, preamble: string): void {
    this.pendingPreambles.set(instanceId, preamble);
  }

  async sendInput(instanceId: string, message: string, attachments?: FileAttachment[]): Promise<void> {
    this.preambles.push(this.pendingPreambles.get(instanceId));
    this.pendingPreambles.delete(instanceId);
    this.inputs.push({ instanceId, message, attachments });
    const instance = this.instances.get(instanceId);
    if (instance) instance.status = 'busy';
  }

  async terminateInstance(instanceId: string): Promise<void> {
    this.terminations.push(instanceId);
    const instance = this.instances.get(instanceId);
    if (instance) instance.status = 'terminated';
  }

  /** Move a runtime to a new status and emit the manager's state-change event. */
  setStatus(instanceId: string, status: Instance['status']): void {
    const instance = this.instances.get(instanceId);
    if (!instance) throw new Error(`No instance ${instanceId}`);
    const previousStatus = instance.status;
    instance.status = status;
    this.emit('instance:state-changed', { instanceId, status, previousStatus, timestamp: Date.now(), instance });
  }

  inputsFor(instanceId: string): string[] {
    return this.inputs.filter((input) => input.instanceId === instanceId).map((input) => input.message);
  }
}

export interface SideChatHarness {
  db: SqliteDriver;
  ledger: ConversationLedgerService;
  runtimes: FakeRuntimeManager;
  service: ChatService;
  events: ChatEvent[];
  /** Agent id → permissions served to the authority resolver; edit to change a parent's policy. */
  agentPermissions: Map<string, AgentToolPermissions>;
  archive: { entries: Map<string, { title: string; workspacePath: string; messages: OutputMessage[] }> };
  /** Simulate an app restart: a fresh service and runtime manager over the same stores. */
  restart(): SideChatHarness;
  dispose(): Promise<void>;
}

export function createSideChatHarness(shared?: {
  db: SqliteDriver;
  ledger: ConversationLedgerService;
  agentPermissions: Map<string, AgentToolPermissions>;
  archive: SideChatHarness['archive'];
}): SideChatHarness {
  const db = shared?.db ?? defaultDriverFactory(':memory:');
  if (!shared) createOperatorTables(db);
  const ledger = shared?.ledger ?? new ConversationLedgerService({
    dbPath: ':memory:',
    enableWAL: false,
    registry: new NativeConversationRegistry(),
  });
  const agentPermissions = shared?.agentPermissions ?? new Map<string, AgentToolPermissions>(
    BUILTIN_AGENTS.map((agent) => [agent.id, { ...agent.permissions }]),
  );
  const archive = shared?.archive ?? { entries: new Map() };
  const archiveLookup: SideChatArchiveLookup = {
    find: (historyThreadId) => {
      const entry = archive.entries.get(historyThreadId);
      return entry
        ? { entryId: historyThreadId, title: entry.title, workspacePath: entry.workspacePath, originNodeId: null }
        : null;
    },
    loadMessages: async (entryId) => archive.entries.get(entryId)?.messages ?? null,
  };
  const runtimes = new FakeRuntimeManager();
  const eventBus = new EventEmitter();
  const events: ChatEvent[] = [];
  eventBus.on('chat:event', (event: ChatEvent) => events.push(event));
  const service = new ChatService({
    db,
    ledger,
    instanceManager: runtimes as never,
    eventBus,
    branchSummarizer: new BranchSummarizer(),
    evidenceDeletion: {
      revokeConversation: async (conversationId) => ledger.softDeleteConversationWithEvidence({
        conversationId,
        deletedAt: new Date(100).toISOString(),
        graceDeadline: 100 + 10 * 60 * 1000,
      }),
    },
    drainEvidenceCapture: async () => undefined,
    resolveAgentPermissions: async (_cwd, agentId) => {
      const permissions = agentPermissions.get(agentId ?? 'build') ?? agentPermissions.get('build');
      return { ...permissions! };
    },
    sideChatArchive: archiveLookup,
  });
  service.initialize();
  const harness: SideChatHarness = {
    db,
    ledger,
    runtimes,
    service,
    events,
    agentPermissions,
    archive,
    restart: () => {
      service.dispose();
      return createSideChatHarness({ db, ledger, agentPermissions, archive });
    },
    dispose: async () => {
      service.dispose();
      if (!shared) {
        await ledger.close();
        db.close();
      }
    },
  };
  return harness;
}

/** Permissions of the built-in read-only `plan` agent: writes denied, shell asks. */
export const PLAN_PERMISSIONS: AgentToolPermissions = {
  read: 'allow', write: 'deny', bash: 'ask', web: 'allow', task: 'allow',
};
