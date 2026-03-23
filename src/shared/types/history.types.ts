/**
 * History Types - Types for conversation history persistence
 */

import type { InstanceProvider, OutputMessage } from './instance.types';

/**
 * Status when the conversation ended
 */
export type ConversationEndStatus = 'completed' | 'error' | 'terminated';
export type HistoryRestoreMode = 'native-resume' | 'replay-fallback';

/**
 * A single entry in the conversation history
 */
export interface ConversationHistoryEntry {
  /** Unique identifier for this history entry */
  id: string;

  /** Display name of the instance when it was terminated */
  displayName: string;

  /** True when the user explicitly renamed this instance */
  isRenamed?: boolean;

  /** Stable app-level thread identity across restore and fallback copies */
  historyThreadId?: string;

  /** When the instance was created */
  createdAt: number;

  /** When the instance was terminated/ended */
  endedAt: number;

  /** When the thread was archived from the primary workspace index */
  archivedAt?: number | null;

  /** Working directory the instance was running in */
  workingDirectory: string;

  /** Total number of messages in the conversation */
  messageCount: number;

  /** First user message (preview, truncated to 150 chars) */
  firstUserMessage: string;

  /** Last user message (preview, truncated to 150 chars) */
  lastUserMessage: string;

  /** Optional VCS diff summary captured for this completed thread */
  changeSummary?: {
    additions: number;
    deletions: number;
  } | null;

  /** How the conversation ended */
  status: ConversationEndStatus;

  /** Original instance ID (for reference) */
  originalInstanceId: string;

  /** Parent instance ID if it was a child instance */
  parentId: string | null;

  /** Session ID from the original instance */
  sessionId: string;

  /** When set, the archived native session handle is known to be non-resumable */
  nativeResumeFailedAt?: number | null;

  /** CLI provider used by the original instance */
  provider?: InstanceProvider;

  /** Model active when the conversation was archived */
  currentModel?: string;
}

/**
 * Full conversation data stored on disk
 */
export interface ConversationData {
  /** Metadata about the conversation */
  entry: ConversationHistoryEntry;

  /** All messages from the conversation */
  messages: OutputMessage[];
}

function normalizeHistoryTitlePart(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}

function inferHistoryProviderFromRestoreId(
  value: string | null | undefined
): Exclude<InstanceProvider, 'auto'> | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized.startsWith('codex-')) return 'codex';
  if (normalized.startsWith('gemini-')) return 'gemini';
  if (normalized.startsWith('copilot-')) return 'copilot';
  if (normalized.startsWith('claude-')) return 'claude';

  return undefined;
}

function inferHistoryProviderFromModel(
  value: string | null | undefined
): Exclude<InstanceProvider, 'auto'> | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized.startsWith('gemini')) return 'gemini';
  if (normalized.startsWith('copilot')) return 'copilot';
  if (
    normalized.startsWith('gpt-')
    || normalized.includes('codex')
    || normalized === 'o3'
  ) {
    return 'codex';
  }
  if (
    normalized.startsWith('claude')
    || normalized === 'opus'
    || normalized === 'sonnet'
    || normalized === 'haiku'
  ) {
    return 'claude';
  }

  return undefined;
}

const HISTORY_PROVIDER_DIRECT_ADDRESS_PATTERNS: ReadonlyArray<{
  provider: Exclude<InstanceProvider, 'auto'>;
  pattern: RegExp;
}> = [
  { provider: 'codex', pattern: /^(?:hey|hi|hello)\s+codex\b/i },
  { provider: 'codex', pattern: /^(?:what(?:'s| is)|which)\s+(?:version|model)[^a-z0-9]+(?:of\s+)?codex\b/i },
  { provider: 'gemini', pattern: /^(?:hey|hi|hello)\s+gemini\b/i },
  { provider: 'gemini', pattern: /^(?:what(?:'s| is)|which)\s+(?:version|model)[^a-z0-9]+(?:of\s+)?gemini\b/i },
  { provider: 'copilot', pattern: /^(?:hey|hi|hello)\s+(?:github\s+)?copilot\b/i },
  { provider: 'copilot', pattern: /^(?:what(?:'s| is)|which)\s+(?:version|model)[^a-z0-9]+(?:of\s+)?(?:github\s+)?copilot\b/i },
  { provider: 'claude', pattern: /^(?:hey|hi|hello)\s+claude\b/i },
  { provider: 'claude', pattern: /^(?:what(?:'s| is)|which)\s+(?:version|model)[^a-z0-9]+(?:of\s+)?claude\b/i },
];

function inferHistoryProviderFromText(
  value: string | null | undefined
): Exclude<InstanceProvider, 'auto'> | undefined {
  const normalized = normalizeHistoryTitlePart(value).replace(/^[^\p{L}\p{N}]+/u, '');
  if (!normalized) {
    return undefined;
  }

  for (const { provider, pattern } of HISTORY_PROVIDER_DIRECT_ADDRESS_PATTERNS) {
    if (pattern.test(normalized)) {
      return provider;
    }
  }

  return undefined;
}

/**
 * Derive a stable thread title for workspace rails and restored sessions.
 *
 * When the user explicitly renamed the instance, honour that title.
 * Otherwise prefer the first user message so titles stay anchored to the
 * original task instead of drifting to short follow-up messages like "hi".
 */
export function getConversationHistoryTitle(
  entry: Pick<ConversationHistoryEntry, 'displayName' | 'isRenamed' | 'firstUserMessage' | 'lastUserMessage'>
): string {
  // User-set title always takes priority
  if (entry.isRenamed) {
    const renamed = normalizeHistoryTitlePart(entry.displayName);
    if (renamed) return renamed;
  }

  const candidates = [
    normalizeHistoryTitlePart(entry.firstUserMessage),
    normalizeHistoryTitlePart(entry.lastUserMessage),
    normalizeHistoryTitlePart(entry.displayName),
  ].filter(Boolean);

  return candidates[0] || 'Untitled thread';
}

/**
 * Infer the original provider for legacy history entries saved before provider
 * metadata was persisted. When we cannot determine it with confidence, fall
 * back to Claude because that was the historic default.
 */
export function inferConversationHistoryProvider(
  entry: Pick<
    ConversationHistoryEntry,
    | 'id'
    | 'displayName'
    | 'firstUserMessage'
    | 'lastUserMessage'
    | 'provider'
    | 'currentModel'
    | 'historyThreadId'
    | 'sessionId'
  >
): Exclude<InstanceProvider, 'auto'> {
  const explicitProvider =
    entry.provider && entry.provider !== 'auto'
      ? (entry.provider as Exclude<InstanceProvider, 'auto'>)
      : undefined;

  return (
    explicitProvider
    || inferHistoryProviderFromModel(entry.currentModel)
    || inferHistoryProviderFromRestoreId(entry.historyThreadId)
    || inferHistoryProviderFromRestoreId(entry.sessionId)
    || inferHistoryProviderFromRestoreId(entry.id)
    || inferHistoryProviderFromText(entry.firstUserMessage)
    || inferHistoryProviderFromText(entry.lastUserMessage)
    || inferHistoryProviderFromText(entry.displayName)
    || 'claude'
  );
}

export function normalizeConversationHistoryEntryProvider<T extends ConversationHistoryEntry>(
  entry: T
): T & { provider: Exclude<InstanceProvider, 'auto'> } {
  const provider = inferConversationHistoryProvider(entry);
  if (entry.provider === provider) {
    return entry as T & { provider: Exclude<InstanceProvider, 'auto'> };
  }

  return {
    ...entry,
    provider,
  };
}

/**
 * History index stored on disk (lightweight metadata only)
 */
export interface HistoryIndex {
  /** Version for future migrations */
  version: number;

  /** When this index was last updated */
  lastUpdated: number;

  /** All history entries (sorted by endedAt descending) */
  entries: ConversationHistoryEntry[];
}

/**
 * Options for loading history
 */
export interface HistoryLoadOptions {
  /** Maximum number of entries to return */
  limit?: number;

  /** Search query to filter entries */
  searchQuery?: string;

  /** Filter by working directory */
  workingDirectory?: string;
}

/**
 * Result of restoring a conversation from history
 */
export interface HistoryRestoreResult {
  /** Whether the restore was successful */
  success: boolean;

  /** The new instance ID if successful */
  instanceId?: string;

  /** Whether the original CLI session resumed or the transcript was replayed into a fresh session */
  restoreMode?: HistoryRestoreMode;

  /** Transcript shown in the restored instance */
  restoredMessages?: OutputMessage[];

  /** Error message if failed */
  error?: string;
}
