/**
 * History Manager - Manages conversation history persistence
 *
 * Archives terminated instances to disk for later restoration.
 * Uses a JSON index file and gzipped JSON for conversation data.
 *
 * KEY DESIGN DECISIONS:
 * - archiveInstance() uses a Set-based lock to prevent concurrent archives of the same instance.
 *   This is critical because the adapter exit handler and terminateInstance() can race.
 * - saveIndex() uses a proper serializing queue (not just a single-promise mutex)
 *   to handle 3+ concurrent callers safely.
 * - On startup, orphaned .gz files (saved but not indexed) are recovered into the index.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { promisify } from 'util';
import { getLogger } from '../logging/logger';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type {
  ConversationHistoryEntry,
  ConversationData,
  HistoryIndex,
  HistoryLoadOptions,
  ConversationEndStatus,
  HistorySearchSource,
} from '../../shared/types/history.types';
import { getTranscriptSnippetService } from './transcript-snippet-service';
import {
  findClaudeJsonlFiles,
  getDefaultClaudeProjectsDir,
  parseClaudeJsonlTranscriptDetailed,
  type ImportedTranscript,
} from './native-claude-importer';
import { projectMemoryKeysEqual } from '../memory/project-memory-key';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const logger = getLogger('HistoryManager');

const HISTORY_INDEX_VERSION = 1;
const MAX_PREVIEW_LENGTH = 150;
const MAX_HISTORY_ENTRIES = 2000; // Keep last 2000 conversations (raised from 1000 to fit native Claude transcript imports)
const RESUME_FAILURE_MESSAGE = /no conversation found|session.*not.*found/i;
const RESTORE_FALLBACK_NOTICE_MESSAGE = /^Previous .+ CLI session could not be restored natively\./;
const HISTORY_BACKED_SOURCES = new Set<HistorySearchSource>([
  'history-transcript',
  'archived_session',
]);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function includesHistoryBackedSource(source: HistorySearchSource | HistorySearchSource[]): boolean {
  const sources = Array.isArray(source) ? source : [source];
  return sources.some(item => HISTORY_BACKED_SOURCES.has(item));
}

function bestSnippetScore(entry: ConversationHistoryEntry, query: string): number {
  let best = 0;
  for (const snippet of entry.snippets ?? []) {
    if (snippet.excerpt.toLowerCase().includes(query)) {
      best = Math.max(best, snippet.score);
    }
  }
  return best;
}

export class HistoryManager {
  private storageDir: string;
  private indexPath: string;
  private index: HistoryIndex;

  // Serializing queue for index saves — properly handles 3+ concurrent callers
  private saveQueue: Promise<void> = Promise.resolve();

  // Lock to prevent concurrent archiveInstance() calls for the same instance
  private archivingInstances = new Set<string>();

  /** Resolves once startup recovery + native transcript import have run. */
  readonly startupTasks: Promise<void>;

  constructor() {
    this.storageDir = path.join(app.getPath('userData'), 'conversation-history');
    this.indexPath = path.join(this.storageDir, 'index.json');
    this.index = this.loadIndex();

    // Recover orphaned .gz files, then import any native Claude transcripts
    // that aren't already in the index. Run sequentially to avoid index races.
    // Auto-import is skipped under Vitest so unrelated test fixtures don't
    // race with the user's real `~/.claude/projects/` on disk; tests that
    // exercise the importer call it explicitly via `importNativeClaudeTranscripts`.
    const skipAutoImport = process.env['VITEST'] === 'true';
    this.startupTasks = this.recoverOrphans()
      .then(() => (skipAutoImport ? undefined : this.importNativeClaudeTranscripts()))
      .catch((err) => {
        logger.error('History startup tasks failed', err instanceof Error ? err : undefined);
      });
  }

  /**
   * Archive an instance to history when it terminates.
   *
   * Uses an instance-level lock to prevent the race condition where
   * both the exit handler and terminateInstance() call this concurrently.
   */
  async archiveInstance(instance: Instance, status: ConversationEndStatus = 'completed'): Promise<void> {
    // Don't archive if no messages
    if (!instance.outputBuffer || instance.outputBuffer.length === 0) {
      logger.info('Skipping archive - no messages', { instanceId: instance.id });
      return;
    }

    // Instance-level lock: prevent concurrent archive calls for the same instance
    if (this.archivingInstances.has(instance.id)) {
      logger.info('Skipping archive - already in progress', { instanceId: instance.id });
      return;
    }

    // Prevent duplicate archives of the same instance (check persisted index)
    const alreadyArchived = this.index.entries.some(e => e.originalInstanceId === instance.id);
    if (alreadyArchived) {
      logger.info('Skipping archive - already archived', { instanceId: instance.id });
      return;
    }

    // Acquire lock
    this.archivingInstances.add(instance.id);

    try {
      // Snapshot the output buffer to avoid issues if it's modified during async operations
      const messages = [...instance.outputBuffer];
      const threadKey = this.getInstanceThreadKey(instance);
      const previousEntries = this.index.entries.filter(
        (existingEntry) => this.getEntryThreadKey(existingEntry) === threadKey
      );
      const entryId = previousEntries[0]?.id ?? crypto.randomUUID();
      const createdAt = previousEntries.reduce(
        (earliest, existingEntry) => Math.min(earliest, existingEntry.createdAt),
        instance.createdAt
      );

      // Find first and last user messages for preview
      const userMessages = messages.filter(m => m.type === 'user');
      const firstUserMessage = userMessages[0]?.content || '';
      const lastUserMessage = userMessages[userMessages.length - 1]?.content || firstUserMessage;

      // When a restore-fallback instance runs locally because the remote node was
      // unavailable, preserve the original remote entry's placement metadata so
      // future restores still target the correct worker node and working directory.
      const previousRemoteEntry = previousEntries.find(
        (e) => e.executionLocation?.type === 'remote'
      );
      const isLocalFallbackOverRemote =
        previousRemoteEntry && instance.executionLocation?.type !== 'remote';
      const executionLocation = isLocalFallbackOverRemote
        ? previousRemoteEntry.executionLocation
        : instance.executionLocation;
      const workingDirectory = isLocalFallbackOverRemote
        ? previousRemoteEntry.workingDirectory
        : instance.workingDirectory;

      if (isLocalFallbackOverRemote) {
        logger.info('Preserving remote placement metadata from previous entry', {
          instanceId: instance.id,
          preservedNodeId: previousRemoteEntry.executionLocation?.type === 'remote'
            ? previousRemoteEntry.executionLocation.nodeId : undefined,
          preservedWorkingDir: previousRemoteEntry.workingDirectory,
        });
      }

      // Create history entry
      const unresolvedNativeResumeFailedAt = this.inferUnresolvedNativeResumeFailure(messages);
      const nativeResumeFailedAt = unresolvedNativeResumeFailedAt ?? undefined;
      const sessionId = this.resolveArchivedSessionId(
        instance,
        messages,
        previousEntries,
        unresolvedNativeResumeFailedAt
      );
      const snippets = getTranscriptSnippetService().extractAtArchiveTime({ messages });
      const entry: ConversationHistoryEntry = {
        id: entryId,
        displayName: instance.displayName,
        isRenamed: instance.isRenamed,
        createdAt,
        endedAt: Date.now(),
        historyThreadId: instance.historyThreadId,
        workingDirectory,
        messageCount: messages.length,
        firstUserMessage: this.truncatePreview(firstUserMessage),
        lastUserMessage: this.truncatePreview(lastUserMessage),
        status,
        originalInstanceId: instance.id,
        parentId: instance.parentId,
        sessionId,
        nativeResumeFailedAt,
        provider: instance.provider,
        currentModel: instance.currentModel,
        executionLocation,
        snippets,
      };

      // Create conversation data
      const conversationData: ConversationData = {
        entry,
        messages,
      };

      // Save conversation to disk
      await this.saveConversation(entry.id, conversationData);

      // Update index (synchronous — safe since JS is single-threaded)
      this.index.entries = [
        entry,
        ...this.index.entries.filter(
          (existingEntry) => this.getEntryThreadKey(existingEntry) !== threadKey
        ),
      ];
      this.index.lastUpdated = Date.now();

      for (const previousEntry of previousEntries) {
        if (previousEntry.id === entry.id) {
          continue;
        }

        try {
          await fs.promises.unlink(this.getConversationPath(previousEntry.id));
        } catch {
          /* intentionally ignored: duplicate conversation files may already be absent */
        }
      }

      // Enforce max entries limit
      await this.enforceLimit();

      // Save index to disk
      await this.saveIndex();

      logger.info('Archived instance', {
        instanceId: instance.id,
        entryId: entry.id,
        messageCount: entry.messageCount,
        replacedEntries: previousEntries.length,
      });
    } finally {
      // Release lock
      this.archivingInstances.delete(instance.id);
    }
  }

  /**
   * Get all history entries (metadata only)
   */
  getEntries(options?: HistoryLoadOptions): ConversationHistoryEntry[] {
    const entries = this.filterEntries(options);

    if (options?.page) {
      const pageSize = clamp(Math.floor(options.page.pageSize), 1, 100);
      const pageNumber = Math.max(1, Math.floor(options.page.pageNumber));
      const start = (pageNumber - 1) * pageSize;
      return entries.slice(start, start + pageSize);
    }

    if (options?.limit && options.limit > 0) {
      return entries.slice(0, options.limit);
    }

    return entries;
  }

  countEntries(options?: HistoryLoadOptions): number {
    return this.filterEntries(options).length;
  }

  /**
   * Load full conversation data for an entry
   */
  async loadConversation(entryId: string): Promise<ConversationData | null> {
    const conversationPath = this.getConversationPath(entryId);

    if (!fs.existsSync(conversationPath)) {
      logger.error('Conversation file not found', undefined, { entryId });
      return null;
    }

    try {
      const compressed = await fs.promises.readFile(conversationPath);
      const data = await gunzip(compressed);
      return JSON.parse(data.toString()) as ConversationData;
    } catch (error) {
      logger.error('Failed to load conversation', error instanceof Error ? error : undefined, { entryId });
      return null;
    }
  }

  /**
   * Delete a history entry
   */
  async deleteEntry(entryId: string): Promise<boolean> {
    const index = this.index.entries.findIndex(e => e.id === entryId);
    if (index === -1) {
      return false;
    }

    // Tombstone the sessionId so the native-transcript importer doesn't
    // resurrect it from `~/.claude/projects/` on next startup.
    const sessionId = this.index.entries[index].sessionId?.trim();
    if (sessionId) {
      const tombstones = new Set(this.index.deletedSessionIds ?? []);
      tombstones.add(sessionId);
      this.index.deletedSessionIds = Array.from(tombstones);
    }

    // Remove from index
    this.index.entries.splice(index, 1);
    this.index.lastUpdated = Date.now();
    await this.saveIndex();

    // Delete conversation file
    const conversationPath = this.getConversationPath(entryId);
    try {
      await fs.promises.unlink(conversationPath);
    } catch {
      /* intentionally ignored: file may not exist if it was never written */
    }

    logger.info('Deleted history entry', { entryId });
    return true;
  }

  /**
   * Archive a history entry from the primary project rail without deleting it.
   */
  async archiveEntry(entryId: string): Promise<boolean> {
    const entry = this.index.entries.find((item) => item.id === entryId);
    if (!entry) {
      return false;
    }

    if (entry.archivedAt) {
      return true;
    }

    entry.archivedAt = Date.now();
    this.index.lastUpdated = Date.now();
    const conversation = await this.loadConversation(entryId);
    if (conversation) {
      conversation.entry.archivedAt = entry.archivedAt;
      await this.saveConversation(entryId, conversation);
    }
    await this.saveIndex();

    logger.info('Archived history entry', { entryId });
    return true;
  }

  /**
   * Mark an archived native session handle as failed so future restores skip
   * doomed native resume attempts and go straight to transcript-backed fallback.
   */
  async markNativeResumeFailed(entryId: string, failedAt = Date.now()): Promise<boolean> {
    const entry = this.index.entries.find((item) => item.id === entryId);
    if (!entry) {
      return false;
    }

    entry.nativeResumeFailedAt = failedAt;
    this.index.lastUpdated = Date.now();

    const conversation = await this.loadConversation(entryId);
    if (conversation) {
      conversation.entry.nativeResumeFailedAt = failedAt;
      await this.saveConversation(entryId, conversation);
    }

    await this.saveIndex();

    logger.info('Marked history entry native resume as failed', { entryId, failedAt });
    return true;
  }

  /**
   * Clear all history
   */
  async clearAll(): Promise<void> {
    await this.createSafetyBackup('clearAll');

    // Delete all conversation files
    for (const entry of this.index.entries) {
      const conversationPath = this.getConversationPath(entry.id);
      try {
        await fs.promises.unlink(conversationPath);
      } catch {
        /* intentionally ignored: file may already be absent during clearAll */
      }
    }

    // Reset index
    this.index = {
      version: HISTORY_INDEX_VERSION,
      lastUpdated: Date.now(),
      entries: [],
    };
    await this.saveIndex();

    logger.info('Cleared all history entries');
  }

  /**
   * Get the number of history entries
   */
  getCount(): number {
    return this.index.entries.length;
  }

  /**
   * Get the storage directory path
   */
  getStoragePath(): string {
    return this.storageDir;
  }

  // ============================================
  // Private Methods
  // ============================================

  private loadIndex(): HistoryIndex {
    this.ensureStorageDir();

    // Clean up any leftover temp file from a previous failed save
    const tempPath = `${this.indexPath}.tmp`;
    if (fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
        logger.info('Cleaned up leftover index temp file');
      } catch {
        /* intentionally ignored: temp file cleanup is best-effort */
      }
    }

    if (fs.existsSync(this.indexPath)) {
      try {
        const data = fs.readFileSync(this.indexPath, 'utf-8');
        const index = JSON.parse(data) as HistoryIndex;

        // Migrate if needed
        if (index.version !== HISTORY_INDEX_VERSION) {
          return this.migrateIndex(index);
        }

        // Deduplicate entries by stable thread identity (clean up legacy duplicates)
        const seen = new Set<string>();
        const deduped: ConversationHistoryEntry[] = [];
        for (const entry of index.entries) {
          const threadKey = this.getEntryThreadKey(entry);
          if (!seen.has(threadKey)) {
            seen.add(threadKey);
            deduped.push(entry);
          }
        }
        if (deduped.length !== index.entries.length) {
          logger.info('Deduplicated history index', {
            before: index.entries.length,
            after: deduped.length,
          });
          index.entries = deduped;
        }

        return index;
      } catch (error) {
        logger.error('Failed to load index, creating new one', error instanceof Error ? error : undefined);
      }
    }

    return {
      version: HISTORY_INDEX_VERSION,
      lastUpdated: Date.now(),
      entries: [],
    };
  }

  private filterEntries(options?: HistoryLoadOptions): ConversationHistoryEntry[] {
    let entries = [...this.index.entries];

    if (options?.source && !includesHistoryBackedSource(options.source)) {
      return [];
    }

    if (options?.searchQuery) {
      const query = options.searchQuery.toLowerCase();
      entries = entries.filter(e =>
        e.displayName.toLowerCase().includes(query) ||
        e.firstUserMessage.toLowerCase().includes(query) ||
        e.lastUserMessage.toLowerCase().includes(query) ||
        e.workingDirectory.toLowerCase().includes(query)
      );
    }

    const projectScope = options?.projectScope ?? (options?.workingDirectory ? 'current' : 'all');
    if (projectScope === 'current' && options?.workingDirectory) {
      entries = entries.filter(e => projectMemoryKeysEqual(e.workingDirectory, options.workingDirectory));
    } else if (projectScope === 'none') {
      entries = entries.filter(e => !e.workingDirectory);
    }

    if (options?.timeRange) {
      const { from, to } = options.timeRange;
      if (from !== undefined) {
        entries = entries.filter(e => e.endedAt >= from);
      }
      if (to !== undefined) {
        entries = entries.filter(e => e.endedAt <= to);
      }
    }

    if (options?.snippetQuery) {
      const query = options.snippetQuery.toLowerCase();
      entries = entries
        .filter(e => (e.snippets ?? []).some(snippet =>
          snippet.excerpt.toLowerCase().includes(query)
        ))
        .sort((a, b) => bestSnippetScore(b, query) - bestSnippetScore(a, query));
    }

    return entries;
  }

  /**
   * Recover orphaned .gz files that were saved but never indexed.
   * This happens when saveConversation succeeds but saveIndex fails.
   */
  private async recoverOrphans(): Promise<void> {
    const files = await fs.promises.readdir(this.storageDir);
    const gzFiles = files.filter(f => f.endsWith('.json.gz'));

    let recovered = 0;
    for (const file of gzFiles) {
      const entryId = file.replace('.json.gz', '');
      // Check current index state (not a stale snapshot) to avoid race
      // with concurrent archiveInstance() calls that modify the index.
      if (this.index.entries.some(e => e.id === entryId)) {
        continue; // Already in index
      }

      // Check file has content
      const filePath = path.join(this.storageDir, file);
      const stat = await fs.promises.stat(filePath);
      if (stat.size === 0) {
        // Remove empty orphaned files
        try {
          await fs.promises.unlink(filePath);
          logger.info('Deleted empty orphaned file', { file });
        } catch {
          /* intentionally ignored: orphaned file cleanup is best-effort */
        }
        continue;
      }

      // Try to read the conversation data and extract the entry metadata
      try {
        const compressed = await fs.promises.readFile(filePath);
        const data = await gunzip(compressed);
        const conversationData = JSON.parse(data.toString()) as ConversationData;

        if (conversationData.entry) {
          // Check it's not a duplicate by stable thread identity
          const isDuplicate = this.index.entries.some(
            e => this.getEntryThreadKey(e) === this.getEntryThreadKey(conversationData.entry)
          );
          if (!isDuplicate) {
            this.index.entries.push(conversationData.entry);
            recovered++;
            logger.info('Recovered orphaned history entry', {
              entryId,
              displayName: conversationData.entry.displayName,
              messageCount: conversationData.entry.messageCount,
            });
          } else {
            // Already have this instance in the index — delete the orphan
            await fs.promises.unlink(filePath);
            logger.info('Deleted duplicate orphaned file', { file });
          }
        }
      } catch (error) {
        logger.warn('Could not recover orphaned file', {
          file,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (recovered > 0) {
      // Sort by endedAt descending
      this.index.entries.sort((a, b) => b.endedAt - a.endedAt);
      this.index.lastUpdated = Date.now();
      await this.enforceLimit();
      await this.saveIndex();
      logger.info('Orphan recovery complete', { recovered });
    }
  }

  /**
   * Import native Claude Code transcripts (`~/.claude/projects/<cwd>/<sessionId>.jsonl`)
   * that aren't already represented in the index. This recovers history that
   * predates the orchestrator archive (or was evicted by the old 100-entry cap).
   *
   * Runs once on startup after `recoverOrphans`. Subsequent runs are cheap because
   * known sessionIds are skipped before parsing.
   */
  private async importNativeClaudeTranscripts(
    projectsDir: string = getDefaultClaudeProjectsDir()
  ): Promise<void> {
    const files = await findClaudeJsonlFiles(projectsDir);
    if (files.length === 0) {
      return;
    }

    const tombstonedSessionIds = new Set(
      (this.index.deletedSessionIds ?? []).map((s) => s.trim()).filter(Boolean)
    );

    const parsedTranscripts: ImportedTranscript[] = [];
    const nonMainSessionIds = new Set<string>();
    let imported = 0;
    let skipped = 0;
    let collapsed = 0;
    let removedNonMain = 0;
    let removedSuperseded = 0;
    let failed = 0;

    for (const filePath of files) {
      const stem = path.basename(filePath, '.jsonl');
      if (tombstonedSessionIds.has(stem)) {
        skipped++;
        continue;
      }

      try {
        const result = await parseClaudeJsonlTranscriptDetailed(filePath);
        const parsed = result.transcript;
        if (!parsed) {
          if (
            result.skipReason === 'non-main-entrypoint'
            && result.sessionId
            && !tombstonedSessionIds.has(result.sessionId)
          ) {
            nonMainSessionIds.add(result.sessionId);
          }
          skipped++;
          continue;
        }
        if (tombstonedSessionIds.has(parsed.sessionId)) {
          skipped++;
          continue;
        }

        parsedTranscripts.push(parsed);
      } catch (error) {
        failed++;
        logger.error(
          'Failed to import native Claude transcript',
          error instanceof Error ? error : undefined,
          { filePath }
        );
      }
    }

    if (nonMainSessionIds.size > 0) {
      removedNonMain = await this.removeNativeImportEntriesBySessionIds(nonMainSessionIds);
    }

    const supersededSessionIds = this.findSupersededNativeTranscriptSessionIds(parsedTranscripts);
    if (supersededSessionIds.size > 0) {
      removedSuperseded = await this.removeNativeImportEntriesBySessionIds(supersededSessionIds);
    }

    const knownSessionIds = new Set<string>();
    for (const entry of this.index.entries) {
      const sid = entry.sessionId?.trim();
      if (sid) knownSessionIds.add(sid);
    }

    for (const parsed of parsedTranscripts) {
      if (supersededSessionIds.has(parsed.sessionId)) {
        collapsed++;
        continue;
      }
      if (knownSessionIds.has(parsed.sessionId)) {
        skipped++;
        continue;
      }

      try {
        const entry = this.buildImportedEntry(parsed);
        const conversationData: ConversationData = {
          entry,
          messages: parsed.messages,
        };

        await this.saveConversation(entry.id, conversationData);
        this.index.entries.push(entry);
        knownSessionIds.add(parsed.sessionId);
        imported++;
      } catch (error) {
        failed++;
        logger.error(
          'Failed to import native Claude transcript',
          error instanceof Error ? error : undefined,
          { sessionId: parsed.sessionId }
        );
      }
    }

    if (imported > 0 || removedNonMain > 0 || removedSuperseded > 0) {
      this.index.entries.sort((a, b) => b.endedAt - a.endedAt);
      this.index.lastUpdated = Date.now();
      if (imported > 0) {
        await this.enforceLimit();
      }
      await this.saveIndex();
    }

    logger.info('Native Claude transcript import complete', {
      imported,
      skipped,
      collapsed,
      removedNonMain,
      removedSuperseded,
      failed,
      total: files.length,
    });
  }

  private findSupersededNativeTranscriptSessionIds(
    transcripts: ImportedTranscript[]
  ): Set<string> {
    const supersededSessionIds = new Set<string>();
    const groups = new Map<string, ImportedTranscript[]>();

    for (const transcript of transcripts) {
      const firstMessage = transcript.messages[0];
      if (!firstMessage?.id.trim()) {
        continue;
      }

      const groupKey = `${transcript.workingDirectory}\0${firstMessage.id}`;
      const group = groups.get(groupKey) ?? [];
      group.push(transcript);
      groups.set(groupKey, group);
    }

    for (const group of groups.values()) {
      const candidates = [...group].sort((left, right) =>
        this.compareNativeTranscriptCoverageCandidates(left, right)
      );
      const retained: ImportedTranscript[] = [];

      for (const candidate of candidates) {
        if (
          retained.some((existing) =>
            this.nativeTranscriptContains(existing, candidate)
          )
        ) {
          supersededSessionIds.add(candidate.sessionId);
          continue;
        }

        retained.push(candidate);
      }
    }

    return supersededSessionIds;
  }

  private compareNativeTranscriptCoverageCandidates(
    left: ImportedTranscript,
    right: ImportedTranscript
  ): number {
    const messageCountDelta = right.messages.length - left.messages.length;
    if (messageCountDelta !== 0) {
      return messageCountDelta;
    }

    const endedAtDelta = right.endedAt - left.endedAt;
    if (endedAtDelta !== 0) {
      return endedAtDelta;
    }

    const createdAtDelta = left.createdAt - right.createdAt;
    if (createdAtDelta !== 0) {
      return createdAtDelta;
    }

    return left.sessionId.localeCompare(right.sessionId);
  }

  private nativeTranscriptContains(
    candidate: ImportedTranscript,
    possiblePrefix: ImportedTranscript
  ): boolean {
    if (candidate.sessionId === possiblePrefix.sessionId) {
      return false;
    }
    if (candidate.messages.length < possiblePrefix.messages.length) {
      return false;
    }

    for (let index = 0; index < possiblePrefix.messages.length; index += 1) {
      const candidateMessage = candidate.messages[index];
      const prefixMessage = possiblePrefix.messages[index];
      if (
        candidateMessage?.id !== prefixMessage?.id ||
        candidateMessage?.type !== prefixMessage?.type ||
        candidateMessage?.content !== prefixMessage?.content
      ) {
        return false;
      }
    }

    return true;
  }

  private async removeNativeImportEntriesBySessionIds(
    sessionIds: ReadonlySet<string>
  ): Promise<number> {
    if (sessionIds.size === 0) {
      return 0;
    }

    const removedEntryIds: string[] = [];
    this.index.entries = this.index.entries.filter((entry) => {
      const sessionId = entry.sessionId.trim();
      if (!sessionIds.has(sessionId)) {
        return true;
      }
      if (!this.isNativeClaudeImportedEntry(entry)) {
        return true;
      }

      removedEntryIds.push(entry.id);
      return false;
    });

    for (const entryId of removedEntryIds) {
      try {
        await fs.promises.unlink(this.getConversationPath(entryId));
      } catch {
        /* intentionally ignored: superseded native import data may already be absent */
      }
    }

    return removedEntryIds.length;
  }

  private isNativeClaudeImportedEntry(
    entry: Pick<
      ConversationHistoryEntry,
      'id' | 'importSource' | 'originalInstanceId' | 'provider' | 'sessionId'
    >
  ): boolean {
    const sessionId = entry.sessionId.trim();
    return (
      entry.importSource === 'native-claude'
      || entry.originalInstanceId === `imported-${sessionId}`
      || (entry.id === sessionId && entry.provider === 'claude' && entry.originalInstanceId.startsWith('imported-'))
    );
  }

  private buildImportedEntry(parsed: ImportedTranscript): ConversationHistoryEntry {
    const projectName = parsed.workingDirectory
      ? path.basename(parsed.workingDirectory) || parsed.workingDirectory
      : 'unknown';
    const summary = parsed.firstUserMessage.replace(/\s+/g, ' ').trim().slice(0, 60)
      || 'Imported session';

    return {
      id: parsed.sessionId,
      displayName: `[${projectName}] ${summary}`,
      createdAt: parsed.createdAt,
      endedAt: parsed.endedAt,
      workingDirectory: parsed.workingDirectory,
      messageCount: parsed.messages.length,
      firstUserMessage: this.truncatePreview(parsed.firstUserMessage),
      lastUserMessage: this.truncatePreview(parsed.lastUserMessage),
      status: 'completed',
      originalInstanceId: `imported-${parsed.sessionId}`,
      parentId: null,
      sessionId: parsed.sessionId,
      provider: 'claude',
      importSource: 'native-claude',
    };
  }

  private migrateIndex(oldIndex: HistoryIndex): HistoryIndex {
    // For now, just update version - add migrations here as needed
    logger.info('Migrating index', { from: oldIndex.version, to: HISTORY_INDEX_VERSION });
    return {
      ...oldIndex,
      version: HISTORY_INDEX_VERSION,
    };
  }

  /**
   * Save the index to disk using a serializing queue.
   *
   * All callers chain onto the same queue, so even with 3+ concurrent callers
   * they execute one at a time. This avoids the bug where the old single-promise
   * mutex allowed concurrent writes when 3+ callers resolved simultaneously.
   */
  private async saveIndex(): Promise<void> {
    // Chain onto the queue — each save waits for ALL previous saves to complete
    const previousQueue = this.saveQueue;
    let resolve: () => void;
    let reject: (err: Error) => void;
    this.saveQueue = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });

    try {
      await previousQueue;
      await this.doSaveIndex();
      resolve!();
    } catch (error) {
      reject!(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Write the index to disk.
   * Uses temp file + rename for atomicity, with fallback to direct write.
   */
  private async doSaveIndex(): Promise<void> {
    // Defensive deduplication: remove any entries with duplicate thread keys
    // that may have crept in due to the recoverOrphans/archiveInstance race.
    const seen = new Set<string>();
    const before = this.index.entries.length;
    this.index.entries = this.index.entries.filter((entry) => {
      const key = this.getEntryThreadKey(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (this.index.entries.length !== before) {
      logger.info('Deduplicated entries at save time', {
        before,
        after: this.index.entries.length,
      });
    }

    const data = JSON.stringify(this.index, null, 2);
    const tempPath = `${this.indexPath}.tmp`;

    try {
      await fs.promises.writeFile(tempPath, data);

      // Verify the temp file was written correctly (not 0 bytes)
      const stat = await fs.promises.stat(tempPath);
      if (stat.size === 0 && data.length > 0) {
        throw new Error('Temp file written as 0 bytes — aborting rename to protect index');
      }

      await fs.promises.rename(tempPath, this.indexPath);
    } catch (error) {
      // Atomic save failed — fall back to direct write
      logger.warn('Atomic save failed, falling back to direct write', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Clean up temp file
      try {
        await fs.promises.unlink(tempPath);
      } catch {
        /* intentionally ignored: temp file may not exist if write never started */
      }

      // Direct write as fallback
      await fs.promises.writeFile(this.indexPath, data);
    }
  }

  private async saveConversation(entryId: string, data: ConversationData): Promise<void> {
    const conversationPath = this.getConversationPath(entryId);
    const jsonData = JSON.stringify(data);
    const compressed = await gzip(jsonData);
    await fs.promises.writeFile(conversationPath, compressed);

    // Verify the file was written (catch 0-byte writes)
    const stat = await fs.promises.stat(conversationPath);
    if (stat.size === 0) {
      throw new Error(`Conversation file written as 0 bytes for ${entryId}`);
    }
  }

  private getConversationPath(entryId: string): string {
    return path.join(this.storageDir, `${entryId}.json.gz`);
  }

  private inferUnresolvedNativeResumeFailure(messages: OutputMessage[]): number | null {
    let failureIndex = -1;

    for (let index = 0; index < messages.length; index += 1) {
      if (this.isNativeResumeFailureMessage(messages[index])) {
        failureIndex = index;
      }
    }

    if (failureIndex === -1) {
      return null;
    }

    const resumedAfterFailure = messages
      .slice(failureIndex + 1)
      .some((message) => this.isSuccessfulConversationOutput(message));

    if (resumedAfterFailure) {
      return null;
    }

    return messages[failureIndex]?.timestamp ?? Date.now();
  }

  private isNativeResumeFailureMessage(message: OutputMessage): boolean {
    const content = message.content.trim();
    if (!content) {
      return false;
    }

    if (this.isRestoreFallbackNoticeMessage(message)) {
      return true;
    }

    if (message.type === 'error' && RESUME_FAILURE_MESSAGE.test(content)) {
      return true;
    }

    if (message.type !== 'system') {
      return false;
    }

    return (
      content === 'Session restarted automatically (resume failed)'
      || content === 'Interrupted — session restarted (resume failed)'
    );
  }

  private isSuccessfulConversationOutput(message: OutputMessage): boolean {
    return (
      message.type === 'assistant'
      || message.type === 'tool_use'
      || message.type === 'tool_result'
    );
  }

  private resolveArchivedSessionId(
    instance: Pick<Instance, 'sessionId'>,
    messages: OutputMessage[],
    previousEntries: ConversationHistoryEntry[],
    unresolvedNativeResumeFailedAt: number | null
  ): string {
    if (unresolvedNativeResumeFailedAt === null) {
      return instance.sessionId;
    }

    return (
      this.getOriginalSessionIdFromRestoreNotice(messages)
      || previousEntries.find((entry) => entry.nativeResumeFailedAt && entry.sessionId.trim())?.sessionId
      || instance.sessionId
    );
  }

  private getOriginalSessionIdFromRestoreNotice(messages: OutputMessage[]): string | undefined {
    for (const message of messages) {
      if (!this.isRestoreFallbackNoticeMessage(message)) {
        continue;
      }

      const originalSessionId = message.metadata?.['originalSessionId'];
      if (typeof originalSessionId === 'string' && originalSessionId.trim()) {
        return originalSessionId.trim();
      }
    }

    return undefined;
  }

  private isRestoreFallbackNoticeMessage(message: OutputMessage): boolean {
    const kind = message.metadata?.['systemMessageKind'];
    return (
      message.type === 'system'
      && (
        message.metadata?.['isRestoreNotice'] === true
        || kind === 'restore-fallback'
        || RESTORE_FALLBACK_NOTICE_MESSAGE.test(message.content.trim())
      )
    );
  }

  private getEntryThreadKey(
    entry: Pick<ConversationHistoryEntry, 'historyThreadId' | 'sessionId' | 'originalInstanceId'>
  ): string {
    const historyThreadId = entry.historyThreadId?.trim();
    if (historyThreadId) {
      return historyThreadId;
    }

    const sessionId = entry.sessionId.trim();
    if (sessionId) {
      return sessionId;
    }

    return entry.originalInstanceId;
  }

  private getInstanceThreadKey(
    instance: Pick<Instance, 'historyThreadId' | 'sessionId' | 'id'>
  ): string {
    const historyThreadId = instance.historyThreadId.trim();
    if (historyThreadId) {
      return historyThreadId;
    }

    const sessionId = instance.sessionId.trim();
    if (sessionId) {
      return sessionId;
    }

    return instance.id;
  }

  private async createSafetyBackup(reason: 'clearAll'): Promise<string | null> {
    const files = await fs.promises.readdir(this.storageDir).catch(() => []);
    const hasConversationFiles = files.some(file => file.endsWith('.json.gz'));

    if (!hasConversationFiles && this.index.entries.length === 0) {
      return null;
    }

    const backupDir = path.join(
      path.dirname(this.storageDir),
      `${path.basename(this.storageDir)}.bak-${this.formatBackupTimestamp(Date.now())}`
    );

    await fs.promises.cp(this.storageDir, backupDir, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });

    logger.info('Created history safety backup', {
      reason,
      backupDir,
      entryCount: this.index.entries.length,
    });

    return backupDir;
  }

  private ensureStorageDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  private formatBackupTimestamp(timestamp: number): string {
    const date = new Date(timestamp);
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');
    const milliseconds = String(date.getMilliseconds()).padStart(3, '0');
    return `${year}${month}${day}-${hours}${minutes}${seconds}-${milliseconds}`;
  }

  private truncatePreview(text: string): string {
    if (!text) return '';

    // Remove newlines and extra whitespace
    const cleaned = text.replace(/\s+/g, ' ').trim();

    if (cleaned.length <= MAX_PREVIEW_LENGTH) {
      return cleaned;
    }

    return cleaned.slice(0, MAX_PREVIEW_LENGTH - 3) + '...';
  }

  private async enforceLimit(): Promise<void> {
    while (this.index.entries.length > MAX_HISTORY_ENTRIES) {
      const oldest = this.index.entries.pop();
      if (oldest) {
        const conversationPath = this.getConversationPath(oldest.id);
        try {
          await fs.promises.unlink(conversationPath);
        } catch {
          /* intentionally ignored: old conversation file may not exist during limit enforcement */
        }
      }
    }
  }

  /**
   * Reset for testing
   */
  static _resetForTesting(): void {
    historyManager = null;
  }
}

// Singleton instance
let historyManager: HistoryManager | null = null;

export function getHistoryManager(): HistoryManager {
  if (!historyManager) {
    historyManager = new HistoryManager();
  }
  return historyManager;
}
