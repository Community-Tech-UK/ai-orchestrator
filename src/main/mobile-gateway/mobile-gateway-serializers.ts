import { crossPlatformBasename } from '../../shared/utils/cross-platform-path';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type {
  MobileHistorySessionDto,
  MobileInstanceDto,
  MobileMessageDto,
  MobileProjectDto,
} from '../../shared/types/mobile-gateway.types';

const NO_WORKSPACE_KEY = '__no_workspace__';

/** Statuses that count as "actively working" for the project rollup. */
export const WORKING_STATUSES = new Set<string>([
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

/** Statuses where an instance is blocked waiting on the user. */
export const WAITING_STATUSES = new Set<string>(['waiting_for_permission', 'waiting_for_input']);

/** One persisted chat as the history source exposes it (structural view of ChatRecord). */
export interface GatewayHistoryChat {
  id: string;
  name: string;
  provider: string | null;
  model: string | null;
  currentCwd: string | null;
  createdAt: number;
  lastActiveAt: number;
  archivedAt: number | null;
  currentInstanceId: string | null;
}

/** One persisted transcript message (structural view of ConversationMessageRecord). */
export interface GatewayHistoryMessage {
  id: string;
  role: string;
  content: string;
  createdAt: number;
}

/**
 * Minimal persistent-history surface the gateway uses (structural view of
 * ChatService). Kept structural so the gateway doesn't import ChatService
 * directly (avoids a heavy/circular import); the real ChatService satisfies it.
 */
export interface GatewayChatHistorySource {
  listChats(options: { includeArchived?: boolean }): GatewayHistoryChat[];
  getChat(chatId: string): Promise<{ conversation: { messages: GatewayHistoryMessage[] } }>;
}

/** One archived instance session as the history manager exposes it (structural view of ConversationHistoryEntry). */
export interface GatewayInstanceHistoryEntry {
  id: string;
  displayName: string;
  aiTitle?: string;
  firstUserMessage?: string;
  provider?: string;
  currentModel?: string;
  workingDirectory: string;
  createdAt: number;
  endedAt: number;
}

/**
 * Minimal persistent instance-history surface (structural view of HistoryManager).
 * This is the archive of *closed* live agent sessions — the work you actually
 * ran as instances — which the ChatService store does not cover. Kept structural
 * so the gateway doesn't import HistoryManager directly.
 */
export interface GatewayInstanceHistorySource {
  getEntries(options?: { limit?: number }): GatewayInstanceHistoryEntry[];
  loadConversation(entryId: string): Promise<{ messages: OutputMessage[] } | null>;
}

export function serializeInstance(instance: Instance): MobileInstanceDto {
  const workingDirectory = instance.workingDirectory || '';
  return {
    id: instance.id,
    displayName: instance.displayName,
    status: instance.status,
    provider: instance.provider,
    model: instance.currentModel,
    workingDirectory,
    projectName: workingDirectory
      ? crossPlatformBasename(workingDirectory) || workingDirectory
      : 'No workspace',
    createdAt: instance.createdAt,
    lastActivity: instance.lastActivity,
    parentId: instance.parentId ?? undefined,
    // Status heuristic; the snapshot overrides this with the real prompt count.
    pendingApprovalCount: WAITING_STATUSES.has(instance.status) ? 1 : 0,
    hasUnreadCompletion: false,
    contextPercentage: instance.contextUsage?.percentage,
  };
}

export function serializeMessage(message: OutputMessage, seq?: number): MobileMessageDto {
  return {
    id: message.id,
    timestamp: message.timestamp,
    type: message.type,
    content: message.content,
    metadata: message.metadata,
    hasAttachments: Boolean(message.attachments?.length),
    ...(seq !== undefined ? { seq } : {}),
  };
}

export function buildProjects(instances: MobileInstanceDto[]): MobileProjectDto[] {
  const map = new Map<string, MobileProjectDto>();
  for (const inst of instances) {
    const key = inst.workingDirectory || NO_WORKSPACE_KEY;
    let proj = map.get(key);
    if (!proj) {
      proj = {
        key,
        path: inst.workingDirectory,
        name: inst.workingDirectory ? inst.projectName : 'No workspace',
        sessionCount: 0,
        busyCount: 0,
        pendingApprovalCount: 0,
        lastActivity: 0,
      };
      map.set(key, proj);
    }
    proj.sessionCount += 1;
    if (WORKING_STATUSES.has(inst.status)) proj.busyCount += 1;
    proj.pendingApprovalCount += inst.pendingApprovalCount;
    proj.lastActivity = Math.max(proj.lastActivity, inst.lastActivity);
  }
  return [...map.values()].sort((a, b) => b.lastActivity - a.lastActivity);
}

/** Map a persisted ledger message role onto the phone's message type. */
function mapHistoryRole(role: string): MobileMessageDto['type'] {
  switch (role) {
    case 'assistant':
      return 'assistant';
    case 'user':
      return 'user';
    case 'tool':
      return 'tool_result';
    default:
      // 'system', 'event', or anything unknown renders as a system line.
      return 'system';
  }
}

export function serializeHistorySession(chat: GatewayHistoryChat): MobileHistorySessionDto {
  const workingDirectory = chat.currentCwd || '';
  return {
    id: chat.id,
    name: chat.name,
    provider: chat.provider,
    model: chat.model,
    workingDirectory,
    projectName: workingDirectory
      ? crossPlatformBasename(workingDirectory) || workingDirectory
      : 'No workspace',
    createdAt: chat.createdAt,
    lastActiveAt: chat.lastActiveAt,
    archived: chat.archivedAt != null,
    live: chat.currentInstanceId != null,
    instanceId: chat.currentInstanceId ?? undefined,
  };
}

export function serializeHistoryMessage(message: GatewayHistoryMessage): MobileMessageDto {
  return {
    id: message.id,
    timestamp: message.createdAt,
    type: mapHistoryRole(message.role),
    content: message.content,
    hasAttachments: false,
  };
}

/** Map an archived instance-history entry onto the phone's history DTO. */
export function serializeInstanceHistorySession(
  entry: GatewayInstanceHistoryEntry,
): MobileHistorySessionDto {
  const workingDirectory = entry.workingDirectory || '';
  const name =
    entry.aiTitle?.trim() ||
    entry.displayName?.trim() ||
    entry.firstUserMessage?.trim() ||
    'Session';
  return {
    id: entry.id,
    name,
    provider: entry.provider ?? null,
    model: entry.currentModel ?? null,
    workingDirectory,
    projectName: workingDirectory
      ? crossPlatformBasename(workingDirectory) || workingDirectory
      : 'No workspace',
    createdAt: entry.createdAt,
    lastActiveAt: entry.endedAt,
    archived: true,
    live: false,
  };
}
