/**
 * History Types - Types for conversation history persistence
 */

import type { BrowserToolsMode, InstanceProvider, OutputMessage } from './instance.types';
import type { CopilotRouteSource } from './copilot-account.types';
import type { InstanceRuntimeSummary } from './local-model-runtime.types';
import type { SessionRecallResult } from './session-recall.types';
import {
  deriveRailTitle,
  isLowSignalTitle,
  normalizeHistoryTitlePart,
  sanitizeGeneratedTitle,
  truncateForRail,
} from './title-derivation';

// Re-exported so the many existing importers of these two keep working; they
// live in `title-derivation.ts` with the rest of the title logic.
export { deriveRailTitle, frontLoadTitle } from './title-derivation';
import type { ExecutionLocation } from './worker-node.types';

/**
 * Status when the conversation ended
 */
export type ConversationEndStatus = 'completed' | 'error' | 'terminated';
export type HistoryRestoreMode = 'native-resume' | 'resume-unconfirmed' | 'replay-fallback';

/**
 * A precomputed transcript snippet attached to a `ConversationHistoryEntry`.
 * `position` is the buffer index of the source message. `excerpt` is capped
 * by the extractor, and `score` captures archive/search relevance.
 */
export interface HistorySnippet {
  position: number;
  excerpt: string;
  score: number;
}

export type HistoryImportSource = 'native-claude';

export type HistorySearchSource =
  | 'history-transcript'
  | 'child_result'
  | 'child_diagnostic'
  | 'automation_run'
  | 'agent_tree'
  | 'archived_session';

export interface HistoryTimeRange {
  /** ms epoch (inclusive). */
  from?: number;
  /** ms epoch (inclusive). */
  to?: number;
}

export type HistoryProjectScope = 'current' | 'all' | 'none';

export interface HistoryPageRequest {
  /** Clamped to [1, 100] by handlers. */
  pageSize: number;
  /** 1-indexed. */
  pageNumber: number;
}

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

  /**
   * Short, cheap-AI-generated thread title (e.g. Claude Haiku) that summarizes
   * the task. When present and the user hasn't manually renamed the thread,
   * this is preferred over the raw first message so the rail is recognizable
   * within its first ~30 characters. Absent on older entries and whenever AI
   * titling didn't run — callers fall back to a front-loaded first message.
   */
  aiTitle?: string;

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

  /** User-facing runtime label captured at archive time, e.g. local model + worker node. */
  runtimeSummary?: InstanceRuntimeSummary;

  /**
   * WS9 per-instance browser tool surface captured at archive time, so a
   * restored session keeps its override (undefined = global setting decides).
   */
  browserToolsMode?: BrowserToolsMode;

  /** WS13 hardened (Seatbelt) flag captured at archive time so a restored session keeps its jail. */
  hardened?: boolean;

  /**
   * GitHub Copilot account profile the conversation ran under.
   *
   * Restoring a thread must resume under the SAME account it was created with
   * — a native Copilot session belongs to one identity, and resuming it under
   * another is a cross-account leak, not a convenience. Absent on threads
   * archived before this field existed; those resolve to the migration-created
   * legacy profile and are then stamped.
   */
  copilotAccountProfileId?: string;

  /** How that profile was chosen, for display in history. */
  copilotRoutingSource?: CopilotRouteSource;

  /** Where the instance ran (local or remote node) */
  executionLocation?: ExecutionLocation;

  /** Precomputed transcript snippets for advanced search. Capped at 5 per entry. */
  snippets?: HistorySnippet[];

  /** External transcript source, when this row was imported rather than archived by Orchestrator. */
  importSource?: HistoryImportSource;

  /**
   * True when the originating instance was spawned by a scheduled automation
   * (carried over from `instance.metadata.automationId` at archive time). Drives
   * the clock indicator in the project rail so automation-born threads are
   * recognizable at a glance. Absent on manual and legacy threads.
   */
  isAutomation?: boolean;

  /**
   * True when the originating automation was marked hidden *and* its run
   * finished cleanly. The project rail omits these threads unless the operator
   * turns on "Show hidden automation runs" — see `Automation.hidden`.
   *
   * Set at archive time only when the runner positively recorded success, so
   * any other ending (failed, cancelled, killed mid-run at app shutdown) leaves
   * the flag absent and the thread visible. The archived `status` cannot be
   * used for this: termination maps every non-`error` instance status to
   * `completed`.
   *
   * Distinct from `hideFromProjectRail`, which is unconditional. A hidden
   * automation is quiet, not invisible.
   */
  isHiddenAutomation?: boolean;

  /**
   * Internal worker/probe sessions can be retained for restore/search/debugging
   * without cluttering the project rail's primary workspace folders.
   */
  hideFromProjectRail?: boolean;
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

function normalizeGeneratedHistoryTitlePart(value: string | null | undefined): string {
  // Resolver path: the input may already be a rail-truncated title, so its
  // trailing `...` is a truncation marker to keep, not punctuation to strip.
  const cleaned = sanitizeGeneratedTitle(value, { preserveTruncationMarker: true });
  // Generated titles are capped at the rail budget. A model that ignores the
  // "3-6 words" instruction — or leaks its reasoning into the answer — must not
  // be able to push a 190-character paragraph into a 60-character rail.
  return cleaned ? truncateForRail(cleaned) : '';
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
  if (normalized.startsWith('u-')) return 'cursor';

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

const HISTORY_PROVIDER_DIRECT_ADDRESS_PATTERNS: readonly {
  provider: Exclude<InstanceProvider, 'auto'>;
  pattern: RegExp;
}[] = [
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
 * Priority:
 *   1. A user-set title (explicit rename) — always wins.
 *   2. The cheap-AI title (`aiTitle`, e.g. Claude Haiku) — a real summary that
 *      reads well in the narrow rail.
 *   3. The first user message, front-loaded so the distinctive part of the task
 *      lands in the first ~30 chars instead of generic lead-ins ("Please …",
 *      "review this PR", a bare URL). Stays anchored to the original task
 *      rather than drifting to short follow-ups like "hi".
 */
export function getConversationHistoryTitle(
  entry: Pick<ConversationHistoryEntry, 'displayName' | 'isRenamed' | 'aiTitle' | 'firstUserMessage' | 'lastUserMessage'>
): string {
  // User-set title always takes priority
  if (entry.isRenamed) {
    const renamed = normalizeHistoryTitlePart(entry.displayName);
    if (renamed) return renamed;
  }

  // Every non-rename candidate goes through the same display normalization the
  // live resolver applies, so the two surfaces cannot differ by so much as a
  // trailing full stop.
  const stored = normalizeGeneratedHistoryTitlePart(entry.displayName);
  const derivedFirst = normalizeGeneratedHistoryTitlePart(deriveRailTitle(entry.firstUserMessage));
  const derivedLast = normalizeGeneratedHistoryTitlePart(deriveRailTitle(entry.lastUserMessage));

  // `stored` outranks re-derivation, and that is deliberate (LT-534b).
  //
  // It IS the title the live rail showed: `AutoTitleService` derived it from the
  // complete first message, with its line structure and the names of any attached
  // files. What we can re-derive here comes from `firstUserMessage`, a 150-char
  // preview that `truncatePreview` has already whitespace-collapsed — so the line
  // structure `deriveRailTitle` needs is gone, and attachment names were never
  // there. Re-deriving therefore cannot agree with the live rail in general, and
  // a session appeared to rename itself the moment it stopped being live.
  //
  // This reverses the original "prefer the first user message" ordering, whose
  // stated purpose was to stay anchored to the original task rather than drift to
  // short follow-ups. That intent is preserved — `stored` is derived from the
  // original first message too — and the risk that motivated it, a generic
  // placeholder like "Claude 3" winning, was measured against the live history
  // before this change: 0 of 1930 non-renamed entries had one.
  //
  // Re-derivation remains the fallback for entries with no usable stored title.
  //
  // The `isLowSignalTitle(stored)` valve matters more than it looks. A restored
  // session takes its `displayName` from this function once
  // (`history-restore-coordinator.ts`), never re-runs auto-titling (restore sets
  // neither an initial prompt nor attachments, and `markFirstMessageReceived`
  // suppresses the send path), and writes that name back on re-archival. So
  // whatever wins here is a FIXED POINT for that thread. Without a valve, a
  // stored title that is pure filler ("Fix", "Implement this") would be locked
  // in permanently and no future improvement to `deriveRailTitle` could ever
  // reach it. Letting re-derivation win when the stored title identifies nothing
  // keeps that escape hatch open, while a stored title with real content still
  // wins and the session keeps its name.
  // Both halves are required. Overriding whenever the stored title is filler
  // would swap "work" for "hi" — churn with no gain — so re-derivation only wins
  // when it actually offers content the stored title lacks.
  const rederivationBeatsStored =
    Boolean(stored)
    && isLowSignalTitle(stored)
    && Boolean(derivedFirst)
    && !isLowSignalTitle(derivedFirst);

  const candidates = [
    normalizeGeneratedHistoryTitlePart(entry.aiTitle),
    rederivationBeatsStored ? '' : stored,
    derivedFirst,
    derivedLast,
    stored,
  ].filter(Boolean);

  return candidates[0] || 'Untitled thread';
}

/**
 * Resolve the effective display title for a live instance, shared by both the
 * workspace rail (sidebar list) and the detail header. Keeping a single
 * resolver ensures the two views never drift out of sync.
 *
 * Priority:
 *   1. The live `instance.displayName` when it has meaningful content. Manual
 *      renames win verbatim; generated titles are sanitized before display.
 *   2. The matching history entry's derived title — only used as a fallback
 *      when the live `displayName` is empty/whitespace, so the rail still
 *      shows something sensible.
 *   3. `'Untitled thread'` as a last-resort fallback.
 */
export function resolveEffectiveInstanceTitle(
  instance: { displayName: string; isRenamed?: boolean },
  matchingHistoryEntry?: Pick<
    ConversationHistoryEntry,
    'displayName' | 'isRenamed' | 'aiTitle' | 'firstUserMessage' | 'lastUserMessage'
  >
): string {
  // Live displayName wins whenever it has content. Manual renames are user text;
  // generated names are cleaned before display so stale reasoning tags cannot
  // leak into the rail/header.
  if (instance.displayName.trim()) {
    if (instance.isRenamed) {
      return instance.displayName;
    }

    // Capped exactly as the history resolver caps its generated candidates, so
    // a title cannot change length the moment a session stops being live.
    const generatedTitle = normalizeGeneratedHistoryTitlePart(instance.displayName);
    if (generatedTitle) {
      return generatedTitle;
    }
  }

  if (matchingHistoryEntry) {
    return getConversationHistoryTitle(matchingHistoryEntry);
  }

  return 'Untitled thread';
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

  /**
   * Tombstones of sessionIds the user has explicitly deleted.
   * The native-Claude transcript importer skips these on subsequent startups,
   * preventing deleted entries from being silently re-imported from
   * `~/.claude/projects/<cwd>/<sessionId>.jsonl`.
   */
  deletedSessionIds?: string[];
}

/**
 * Options for loading history
 */
export interface HistoryLoadOptions {
  /** Maximum number of entries to return. Ignored when `page` is set. */
  limit?: number;

  /** Search query (metadata: displayName, first/last user message, working directory). */
  searchQuery?: string;

  /** Filter by working directory. */
  workingDirectory?: string;

  /** Plain-text query against transcript snippets. */
  snippetQuery?: string;

  /** Wall-clock filter applied to `endedAt`. */
  timeRange?: HistoryTimeRange;

  /** Restrict by source. Defaults to all when omitted. */
  source?: HistorySearchSource | HistorySearchSource[];

  /** Project scope filter. Defaults to `current` when `workingDirectory` is set, else `all`. */
  projectScope?: HistoryProjectScope;

  /** Pagination request. When omitted, `limit` semantics apply. */
  page?: HistoryPageRequest;
}

export interface AdvancedHistorySearchInput {
  searchQuery?: string;
  snippetQuery?: string;
  workingDirectory?: string;
  projectScope?: HistoryProjectScope;
  source?: HistorySearchSource | HistorySearchSource[];
  timeRange?: HistoryTimeRange;
  page?: HistoryPageRequest;
}

export interface AdvancedHistorySearchResult {
  entries: ConversationHistoryEntry[];
  recallResults: SessionRecallResult[];
  page: {
    pageNumber: number;
    pageSize: number;
    totalCount: number;
    totalPages: number;
  };
}

/**
 * Result of restoring a conversation from history
 */
export interface HistoryRestoreResult {
  /** Whether the restore was successful */
  success: boolean;

  /** The new instance ID if successful */
  instanceId?: string;

  /** Provider/app session id for the restored or forked live instance */
  sessionId?: string;

  /** App-level history thread id for the restored or forked live instance */
  historyThreadId?: string;

  /** Whether the original CLI session resumed or the transcript was replayed into a fresh session */
  restoreMode?: HistoryRestoreMode;

  /** Transcript shown in the restored instance */
  restoredMessages?: OutputMessage[];

  /** Error message if failed */
  error?: string;
}
