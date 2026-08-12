import { isOccupancyPressureReading } from '../../shared/utils/context-occupancy';
import { crossPlatformBasename } from '../../shared/utils/cross-platform-path';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type {
  MobileHistorySessionDto,
  MobileInstanceDto,
  MobileMessageDto,
  MobileProjectDto,
} from '../../shared/types/mobile-gateway.types';
import { ALL_INSTANCE_STATUSES, attentionLevelForInstanceStatus } from '../../shared/attention/attention-level';

const NO_WORKSPACE_KEY = '__no_workspace__';

/** Statuses that count as "actively working" for the project rollup. WS-C2:
 *  derived from the shared attention scale (`working` level) rather than a
 *  hand-maintained duplicate — this is exactly the same 9-status set
 *  Workboard's `working` lane uses. */
export const WORKING_STATUSES = new Set<string>(
  ALL_INSTANCE_STATUSES.filter((status) => attentionLevelForInstanceStatus(status) === 'working'),
);

/** Statuses where an instance is blocked waiting on the user (a live,
 *  answerable prompt). WS-C2: derived from the shared attention scale's
 *  `blocked` level — the same 2-status set as before this refactor
 *  (`waiting_for_permission` / `waiting_for_input`); intentionally narrower
 *  than "needs you" (see `needsAttentionCount` in `buildProjects`), since
 *  this set specifically gates clearing a stale pending-prompt entry. */
export const WAITING_STATUSES = new Set<string>(
  ALL_INSTANCE_STATUSES.filter((status) => attentionLevelForInstanceStatus(status) === 'blocked'),
);

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

export interface SerializeInstanceOptions {
  isLooping?: boolean;
}

export function serializeInstance(
  instance: Instance,
  options: SerializeInstanceOptions = {},
): MobileInstanceDto {
  const workingDirectory = instance.workingDirectory || '';
  return {
    id: instance.id,
    displayName: instance.displayName,
    status: instance.status,
    attentionLevel: attentionLevelForInstanceStatus(instance.status),
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
    isLooping: options.isLooping === true,
    // LT-018: the DTO documents this as "when known", and omitting it is how the
    // phone client is told there is nothing to show. `contextUsage` is seeded at
    // create, so sending it unconditionally shipped a confident `0` for every
    // session that had not reported yet — the desktop defect, on mobile.
    // LT-034: and omit it for aggregate-only providers too. `contextPercentage`
    // is defined as context-window occupancy; sending cumulative spend under
    // that name reproduces the desktop defect on a client that has no field to
    // tell the difference. Omission is the DTO's own "nothing to show" signal.
    contextPercentage: isOccupancyPressureReading(instance.contextUsage)
      ? instance.contextUsage?.percentage
      : undefined,
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
        needsAttentionCount: 0,
        lastActivity: 0,
      };
      map.set(key, proj);
    }
    proj.sessionCount += 1;
    if (inst.isLooping === true || WORKING_STATUSES.has(inst.status)) proj.busyCount += 1;
    proj.pendingApprovalCount += inst.pendingApprovalCount;
    // WS-C2: `blocked` or `failed` — the same "needs you" bucket Workboard's
    // needs-you lane uses, minus `review` (no instance-level equivalent).
    if (inst.attentionLevel === 'blocked' || inst.attentionLevel === 'failed') {
      proj.needsAttentionCount += 1;
    }
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
