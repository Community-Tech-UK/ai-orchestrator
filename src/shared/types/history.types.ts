/**
 * History Types - Types for conversation history persistence
 */

import type { BrowserToolsMode, InstanceProvider, OutputMessage } from './instance.types';
import type { CopilotRouteSource } from './copilot-account.types';
import type { AccountRouteSource } from './provider-account.types';
import type { InstanceRuntimeSummary } from './local-model-runtime.types';
import type { SessionRecallResult } from './session-recall.types';
import { isGenuineUserPrompt } from '../utils/prompt-retention';
import {
  deriveRailTitle,
  frontLoadTitle,
  isBareIdentifierLine,
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

  /**
   * Claude/Codex account-pool profile the conversation last ran on. A native
   * resume restores on it (the provider session lives in that account's
   * store); a replay restore routes normally.
   */
  accountProfileId?: string;
  accountRoutingSource?: AccountRouteSource;

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

const UNTITLED_THREAD_TITLE = 'Untitled thread';

function normalizeGeneratedHistoryTitlePart(value: string | null | undefined): string {
  // Resolver path: the input may already be a rail-truncated title, so its
  // trailing `...` is a truncation marker to keep, not punctuation to strip.
  const cleaned = sanitizeGeneratedTitle(value, {
    preserveTruncationMarker: true, rejectInvalidPresentation: true,
  });
  // Generated titles are capped at the rail budget. A model that ignores the
  // "3-6 words" instruction — or leaks its reasoning into the answer — must not
  // be able to push a 190-character paragraph into a 60-character rail.
  const title = cleaned ? truncateForRail(cleaned) : '';
  // Old names may carry lead-ins that expose invalid structure when removed.
  // Check that form too, while returning useful established names unchanged.
  const plainTitle = sanitizeGeneratedTitle(frontLoadTitle(title), { rejectInvalidPresentation: true });
  // These cannot identify an automatic title even as the last fallback. Keep
  // ordinary filler words eligible below to preserve established names when
  // no useful alternative exists; explicit user renames bypass this helper.
  return title && plainTitle && /\p{L}/u.test(title) && !isBareIdentifierLine(title) ? title : '';
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
 *   2. The stored `displayName` — the name the session actually showed while
 *      it was live. Once a session has a name, it keeps it.
 *   3. The cheap-AI title (`aiTitle`, e.g. Claude Haiku) — used when there is
 *      no usable stored name.
 *   4. The first user message, front-loaded so the distinctive part of the task
 *      lands in the first ~30 chars instead of generic lead-ins ("Please …",
 *      "review this PR", a bare URL). Stays anchored to the original task
 *      rather than drifting to short follow-ups like "hi".
 */
export function getConversationHistoryTitle(
  entry: Pick<ConversationHistoryEntry, 'displayName' | 'isRenamed' | 'aiTitle' | 'firstUserMessage' | 'lastUserMessage'>,
  options: { allowLastMessageFallback?: boolean } = {},
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
  // A known generic opener still anchors the task. The last preview is only
  // evidence of the original request when that request is entirely unknown.
  const derivedLast = !(entry.firstUserMessage ?? '').trim() && options.allowLastMessageFallback !== false
    ? normalizeGeneratedHistoryTitlePart(deriveRailTitle(entry.lastUserMessage))
    : '';

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
  // The low-signal candidate valve matters more than it looks. A restored
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
  //
  // `stored` also outranks `aiTitle`. The two disagree far more often than
  // expected — 471 of 1,568 non-renamed entries carrying both in the live
  // history index (2026-10) — because `aiTitle` can be written after the user last saw the
  // session: by the history backfill for threads whose live AI upgrade never
  // landed, or carried over from an earlier archive. Ranking it first renamed
  // those sessions the moment they were archived, and the restore path then
  // made the new name permanent.
  //
  // Prefer the first useful candidate in the existing priority order. If all
  // remaining candidates are filler words, preserve that order: swapping
  // "work" for "hi" would create churn with no gain. Bare numbers and opaque
  // identifiers were excluded during normalization and cannot be a fallback.
  const candidates = [
    stored,
    normalizeGeneratedHistoryTitlePart(entry.aiTitle),
    derivedFirst,
    derivedLast,
  ].filter(Boolean);

  // Preserve established priority among useful names; stale AI numbers/filler
  // must not outrank a real stored title or a meaningful message preview. When
  // every candidate is filler, retain the existing name to avoid pointless churn.
  return candidates.find((candidate) => !isLowSignalTitle(candidate))
    || candidates[0]
    || UNTITLED_THREAD_TITLE;
}

/**
 * Resolve the effective display title for a live instance, shared by both the
 * workspace rail (sidebar list) and the detail header. Keeping a single
 * resolver ensures the two views never drift out of sync.
 *
 * Priority:
 *   1. The live `instance.displayName` when it has meaningful content. Manual
 *      renames win verbatim; generated titles are sanitized before display.
 *   2. A useful matching history title or the earliest genuine opening request,
 *      including prompts retained after buffer eviction, for bad automatic names.
 *   3. The existing filler title, or `'Untitled thread'` when no title is usable.
 */
export function resolveEffectiveInstanceTitle(
  instance: {
    displayName: string;
    isRenamed?: boolean;
    outputBuffer?: readonly OutputMessage[];
    retainedPrompts?: readonly OutputMessage[];
  },
  matchingHistoryEntry?: Pick<
    ConversationHistoryEntry,
    'displayName' | 'isRenamed' | 'aiTitle' | 'firstUserMessage' | 'lastUserMessage'
  >
): string {
  if (instance.isRenamed && instance.displayName.trim()) return instance.displayName;

  // Useful live titles remain stable. Only invalid/low-signal automatic names
  // consult fallbacks, so transcript updates cannot rewrite established names.
  const generatedTitle = normalizeGeneratedHistoryTitlePart(instance.displayName);
  if (generatedTitle && !isLowSignalTitle(generatedTitle)) return generatedTitle;

  // Both buffers are chronological. Retained prompts usually precede the live
  // window, but scroll-loaded history can contain an even earlier opener.
  // Select the first genuine request before assessing its title: a generic
  // opener must not let a later follow-up become the session's task subject.
  const retainedOpening = instance.retainedPrompts?.find(isGenuineUserPrompt);
  const bufferedOpening = instance.outputBuffer?.find(isGenuineUserPrompt);
  const openingMessage = retainedOpening && bufferedOpening
    ? (bufferedOpening.timestamp < retainedOpening.timestamp ? bufferedOpening : retainedOpening)
    : retainedOpening ?? bufferedOpening;
  // Matching history must not reintroduce a follow-up excluded by the live
  // opener policy, even when its own first-message preview is missing.
  const historyTitle = matchingHistoryEntry
    ? getConversationHistoryTitle(matchingHistoryEntry, { allowLastMessageFallback: !openingMessage })
    : '';
  const hasManualHistoryTitle = matchingHistoryEntry?.isRenamed
    && Boolean(matchingHistoryEntry.displayName.trim());
  // An absence label is not positive history evidence. Only an actual manual
  // name may deliberately use it; an empty rename field does not qualify.
  if (historyTitle && (hasManualHistoryTitle
    || (historyTitle !== UNTITLED_THREAD_TITLE && !isLowSignalTitle(historyTitle)))) {
    return historyTitle;
  }
  const openingTitle = openingMessage
    ? normalizeGeneratedHistoryTitlePart(deriveRailTitle(
      openingMessage.content,
      openingMessage.attachments?.map((attachment) => attachment.name),
    ))
    : '';
  if (openingTitle && !isLowSignalTitle(openingTitle)) return openingTitle;

  return generatedTitle || (!openingMessage ? historyTitle : '') || UNTITLED_THREAD_TITLE;
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
