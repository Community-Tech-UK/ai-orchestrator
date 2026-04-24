/**
 * Session Continuity Manager
 *
 * Provides seamless session resumption capabilities:
 * - Auto-save session state at configurable intervals
 * - Quick resume from last session state
 * - Session snapshots for point-in-time restoration
 * - Cross-session context preservation
 * - Conversation transcript storage
 */

import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';
import { registerCleanup } from '../util/cleanup-registry';
import { withLock } from '../util/file-lock';
import type { Instance, InstanceProvider } from '../../shared/types/instance.types';
import { CLAUDE_MODELS } from '../../shared/types/provider.types';
import { getSettingsManager } from '../core/config/settings-manager';
import { getLogger } from '../logging/logger';
import { SnapshotIndex } from './snapshot-index';
import { TerminationGateManager, type SessionTerminationGate, type TerminationGateResult } from './termination-gate-manager';
import { SnapshotManager } from './snapshot-manager';
import { cleanupOrphanedTmpFiles, quarantineFile, repairFile, validateTranscript } from './session-repair';
import { getSessionMutex } from './session-mutex';
import { measureAsync } from '../util/slow-operations';
import { getResumeHintManager } from './resume-hint';
import { getSafeStorage } from './safe-storage-accessor';
import { ConversationHistoryCompactor, SessionCompactionPolicy } from './compaction-policy';
import { getProjectStoragePaths } from '../storage/project-storage-paths';
import { SessionAutoSaveCoordinator } from './autosave-coordinator';

const logger = getLogger('SessionContinuity');

const CURRENT_SCHEMA_VERSION = 2;

interface SessionMigration {
  fromVersion: number;
  toVersion: number;
  description: string;
  migrate: (state: Record<string, unknown>) => Record<string, unknown>;
}

const SESSION_MIGRATIONS: SessionMigration[] = [
  {
    fromVersion: 1,
    toVersion: 2,
    description: 'Add schemaVersion field to session state',
    migrate: (state) => ({ ...state, schemaVersion: 2 }),
  },
];

function migrateSessionState(state: Record<string, unknown>): Record<string, unknown> {
  let version = (state['schemaVersion'] as number) || 1;
  let current = { ...state };

  for (const migration of SESSION_MIGRATIONS) {
    if (version === migration.fromVersion) {
      logger.info('Running session migration', {
        from: migration.fromVersion,
        to: migration.toVersion,
        description: migration.description,
      });
      current = migration.migrate(current);
      version = migration.toVersion;
    }
  }

  if (version !== CURRENT_SCHEMA_VERSION) {
    logger.warn('Session state version mismatch after migration', {
      expected: CURRENT_SCHEMA_VERSION,
      actual: version,
    });
  }

  return current;
}

const DEFAULT_RESUME_AUTOSAVE_GRACE_MS = 60_000;

/**
 * Session snapshot for point-in-time restoration
 */
export interface SessionSnapshot {
  id: string;
  instanceId: string;
  sessionId?: string;
  historyThreadId?: string;
  timestamp: number;
  name?: string;
  description?: string;
  state: SessionState;
  schemaVersion?: number;
  metadata: {
    messageCount: number;
    tokensUsed: number;
    duration: number;
    trigger: 'auto' | 'manual' | 'checkpoint';
  };
}

/**
 * Persisted cursor for crash-resilient session resumption
 */
export interface ResumeCursor {
  /** Provider type that owns this thread */
  provider: string;
  /** Provider-specific thread/session ID for resume */
  threadId: string;
  /** Workspace path for filesystem-based discovery fallback */
  workspacePath: string;
  /** Epoch ms when cursor was captured — used for staleness check */
  capturedAt: number;
  /** How this cursor was obtained */
  scanSource: 'native' | 'jsonl-scan' | 'replay';
}

/**
 * Complete session state for restoration
 */
export interface SessionState {
  instanceId: string;
  sessionId?: string;
  historyThreadId?: string;
  nativeResumeFailedAt?: number | null;
  displayName: string;
  isRenamed?: boolean;
  agentId: string;
  modelId: string;
  provider?: InstanceProvider;
  workingDirectory: string;
  systemPrompt?: string;
  temperature?: number;
  maxTokens?: number;
  conversationHistory: ConversationEntry[];
  contextUsage: {
    used: number;
    total: number;
    costEstimate?: number;
  };
  pendingTasks: PendingTask[];
  environmentVariables: Record<string, string>;
  activeFiles: string[];
  gitBranch?: string;
  customInstructions?: string;
  skillsLoaded: string[];
  hooksActive: string[];
  lastWriteTimestamp?: number;
  lastWriteSource?: string;
  /** Persisted resume cursor for crash-resilient session restore */
  resumeCursor?: ResumeCursor | null;
}

/**
 * Conversation entry with full metadata
 */
export interface ConversationEntry {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  tokens?: number;
  toolUse?: {
    toolName: string;
    input: unknown;
    output?: string;
  };
  thinking?: string;
  isCompacted?: boolean;
}

/**
 * Pending task that needs to resume
 */
export interface PendingTask {
  id: string;
  type: 'completion' | 'tool_execution' | 'approval_required';
  description: string;
  createdAt: number;
  context?: unknown;
}

/**
 * Pre-termination validation gate result.
 * Inspired by codex-plugin-cc's stop-review-gate-hook pattern.
 */
// Re-exported from termination-gate-manager.ts for backward compatibility.
export type { TerminationGateResult, SessionTerminationGate } from './termination-gate-manager';

/**
 * Session continuity configuration
 */
export interface ContinuityConfig {
  autoSaveEnabled: boolean;
  autoSaveIntervalMs: number;
  maxSnapshots: number;
  /** Global cap across ALL sessions. Oldest snapshots pruned first. */
  maxTotalSnapshots: number;
  snapshotRetentionDays: number;
  compressOldSnapshots: boolean;
  resumeOnStartup: boolean;
  preserveToolResults: boolean;
  maxConversationEntries: number;
  encryptOnDisk: boolean;
  persistSessionContent: boolean;
  redactToolOutputs: boolean;
}

/**
 * Resume options
 */
export interface ResumeOptions {
  restoreMessages?: boolean;
  restoreContext?: boolean;
  restoreTasks?: boolean;
  restoreEnvironment?: boolean;
  fromSnapshot?: string;

  /**
   * When true, validates that all parallel tool results are present in the
   * conversation history before completing resume. Logs warnings for any
   * tool_result entries that appear to have placeholders or missing content.
   * Inspired by Claude Code 2.1.80 fix for --resume dropping parallel tool results.
   */
  validateParallelToolResults?: boolean;
}

const DEFAULT_CONFIG: ContinuityConfig = {
  autoSaveEnabled: true,
  autoSaveIntervalMs: 60000, // 1 minute
  maxSnapshots: 50,
  maxTotalSnapshots: 500,
  snapshotRetentionDays: 30,
  compressOldSnapshots: true,
  resumeOnStartup: true,
  preserveToolResults: true,
  maxConversationEntries: 1000,
  encryptOnDisk: false,
  persistSessionContent: true,
  redactToolOutputs: true
};

/**
 * Session Continuity Manager
 */
// Minimal slice of InstanceManager that captureResumeCursor needs. Avoids a
// hard import of InstanceManager (circular at module-load time).
interface InstanceManagerForContinuity {
  getAdapter(instanceId: string): unknown;
}

export class SessionContinuityManager extends EventEmitter {
  private continuityDir: string;
  private stateDir: string;
  private snapshotDir: string;
  private quarantineDir: string;
  private config: ContinuityConfig;
  private sessionStates = new Map<string, SessionState>();
  private dirty = new Set<string>();
  private readyPromise: Promise<void>;
  private readonly autoSave: SessionAutoSaveCoordinator;
  private snapshotIndex: SnapshotIndex;
  /** Extracted termination gate orchestration. */
  readonly gateManager: TerminationGateManager;
  /** Extracted snapshot persistence and retention. */
  readonly snapshots: SnapshotManager;
  private instanceManager: InstanceManagerForContinuity | null = null;
  private readonly storagePaths = getProjectStoragePaths();
  private readonly compactionPolicy = new SessionCompactionPolicy();
  private readonly compactor = new ConversationHistoryCompactor<ConversationEntry>();
  private readonly lastCompactionAt = new Map<string, number>();

  constructor(config: Partial<ContinuityConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    this.continuityDir = this.storagePaths.getGlobalDomainRoot('session-continuity');
    this.stateDir = path.join(this.continuityDir, 'states');
    this.snapshotDir = path.join(this.continuityDir, 'snapshots');
    this.quarantineDir = path.join(this.continuityDir, 'quarantine');

    this.snapshotIndex = new SnapshotIndex();
    this.gateManager = new TerminationGateManager();
    // Forward gate events up to the continuity manager's event bus
    this.gateManager.on('gate:blocked', (data) => this.emit('gate:blocked', data));
    this.snapshots = new SnapshotManager(
      this.snapshotDir,
      this.snapshotIndex,
      {
        writePayload: (filePath, data) => this.writePayload(filePath, data),
        readPayload: <T>(filePath: string) => this.readPayload<T>(filePath),
        migrateSessionState: (raw) => migrateSessionState(raw) as unknown as Record<string, unknown>,
      },
      {
        maxSnapshots: this.config.maxSnapshots,
        maxTotalSnapshots: this.config.maxTotalSnapshots,
        snapshotRetentionDays: this.config.snapshotRetentionDays,
      },
    );
    // Forward snapshot events
    this.snapshots.on('snapshot:created', (snapshot) => this.emit('snapshot:created', snapshot));
    this.autoSave = new SessionAutoSaveCoordinator({
      getDirtyIds: () => this.dirty,
      hasDirty: (instanceId) => this.dirty.has(instanceId),
      isLocked: (instanceId) => getSessionMutex().isLocked(instanceId),
      saveState: (instanceId) => this.saveStateAsync(instanceId),
      onSaveError: (instanceId, error) => {
        logger.error('Auto-save failed', error instanceof Error ? error : undefined, { instanceId });
      },
    });
    this.readyPromise = this.initAsync();
    registerCleanup(() => this.shutdown());
  }

  /**
   * Async initialization — runs in the background after construction.
   */
  private async initAsync(): Promise<void> {
    await this.ensureDirectories();

    // Layer 3: Clean up orphaned tmp files before loading states
    const stateTmp = await cleanupOrphanedTmpFiles(this.stateDir);
    const snapTmp = await cleanupOrphanedTmpFiles(this.snapshotDir);
    if (stateTmp.recovered.length || snapTmp.recovered.length) {
      logger.info('Recovered orphaned tmp files on startup', {
        states: stateTmp.recovered.length,
        snapshots: snapTmp.recovered.length,
      });
    }

    await this.loadActiveStates();
    await this.buildSnapshotIndex();
    await this.pruneOnStartup();
    this.startGlobalAutoSave();
  }

  /**
   * Ensure required directories exist
   */
  private async ensureDirectories(): Promise<void> {
    for (const dir of [this.continuityDir, this.stateDir, this.snapshotDir, this.quarantineDir]) {
      await fs.promises.mkdir(dir, { recursive: true });
    }
  }

  private normalizeLookupIdentifier(value: string | null | undefined): string | null {
    const normalized = value?.trim();
    return normalized ? normalized : null;
  }

  private getStateLookupKeys(
    state: Pick<SessionState, 'instanceId' | 'historyThreadId' | 'sessionId'>
  ): string[] {
    const keys = new Set<string>();
    const addKey = (value: string | null | undefined): void => {
      const normalized = this.normalizeLookupIdentifier(value);
      if (normalized) {
        keys.add(normalized);
      }
    };

    addKey(state.instanceId);
    addKey(state.historyThreadId);
    addKey(state.sessionId);

    return Array.from(keys);
  }

  private findTrackedStateByIdentifier(identifier: string): {
    instanceId: string;
    state: SessionState;
  } | null {
    const normalized = this.normalizeLookupIdentifier(identifier);
    if (!normalized) {
      return null;
    }

    const exact = this.sessionStates.get(normalized);
    if (exact) {
      return {
        instanceId: normalized,
        state: exact,
      };
    }

    for (const [instanceId, state] of this.sessionStates.entries()) {
      if (this.getStateLookupKeys(state).includes(normalized)) {
        return { instanceId, state };
      }
    }

    return null;
  }

  private async loadStateFromDiskByIdentifier(identifier: string): Promise<SessionState | null> {
    const normalized = this.normalizeLookupIdentifier(identifier);
    if (!normalized) {
      return null;
    }

    const directStateFile = path.join(this.stateDir, `${normalized}.json`);
    const direct = await this.readPayload<SessionState>(directStateFile);
    if (direct) {
      return direct;
    }

    let files: string[] = [];
    try {
      files = await fs.promises.readdir(this.stateDir);
    } catch (error) {
      logger.error('Failed to scan session state directory for identifier lookup', error instanceof Error ? error : undefined, {
        stateDir: this.stateDir,
        identifier: normalized,
      });
      return null;
    }

    for (const file of files) {
      if (!file.endsWith('.json') || file === `${normalized}.json`) {
        continue;
      }

      const state: SessionState | null = await this.readPayload<SessionState>(path.join(this.stateDir, file));
      if (state && this.getStateLookupKeys(state).includes(normalized)) {
        return state;
      }
    }

    return null;
  }

  /**
   * Load active session states from disk
   */
  private async loadActiveStates(): Promise<void> {
    let files: string[];
    try {
      files = await fs.promises.readdir(this.stateDir);
    } catch (error) {
      logger.error('Failed to read session state directory', error instanceof Error ? error : undefined, {
        stateDir: this.stateDir,
      });
      return;
    }

    let loaded = 0;
    let failed = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(this.stateDir, file);
      const data = await this.readPayload<SessionState>(filePath);
      if (data) {
        this.sessionStates.set(data.instanceId, data);
        loaded++;

        // Diagnostic: warn if last write was very recent (possible crash during save)
        if (data.lastWriteTimestamp && Date.now() - data.lastWriteTimestamp < 5000) {
          logger.warn('Session state has very recent write timestamp — possible crash during save', {
            instanceId: data.instanceId,
            lastWriteSource: data.lastWriteSource,
            ageMs: Date.now() - data.lastWriteTimestamp,
          });
        }
      } else {
        failed++;
        logger.warn('Skipped unloadable session state file', { file, filePath });
      }
    }

    if (loaded > 0 || failed > 0) {
      logger.info('Session states loaded', { loaded, failed, total: loaded + failed });
    }
  }

  /**
   * Build the in-memory snapshot index from disk
   */
  private async buildSnapshotIndex(): Promise<void> {
    try {
      const files = await fs.promises.readdir(this.snapshotDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(this.snapshotDir, file);
        try {
          const data = await this.readPayload<SessionSnapshot>(filePath);
          if (data) {
            this.snapshotIndex.add({
              id: data.id,
              instanceId: data.instanceId || data.state.instanceId,
              sessionId: data.sessionId,
              historyThreadId: data.historyThreadId || data.state.historyThreadId,
              timestamp: data.timestamp,
              messageCount: data.metadata.messageCount,
              schemaVersion: data.schemaVersion ?? CURRENT_SCHEMA_VERSION
            });
          }
        } catch (error) {
          logger.warn('Failed to index snapshot file', { file, error: error instanceof Error ? error.message : String(error) });
        }
      }
    } catch (error) {
      logger.error('Failed to build snapshot index', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Start the global auto-save timer
   */
  private startGlobalAutoSave(): void {
    this.autoSave.start(this.config);
  }

  /**
   * Start tracking a session for continuity
   */
  async startTracking(instance: Instance): Promise<void> {
    await this.readyPromise;
    const state = this.instanceToState(instance);
    this.sessionStates.set(instance.id, state);
    this.dirty.add(instance.id);
    await this.appendSessionEvent(instance.id, 'tracking_started', {
      workingDirectory: state.workingDirectory,
      provider: state.provider ?? 'unknown',
    });

    this.emit('tracking:started', { instanceId: instance.id });
  }

  /**
   * Register a pre-termination validation gate.
   *
   * Gates are evaluated (in order) when `stopTracking()` is called.
   * If any gate returns `{ pass: false }`, a `'gate:blocked'` event is emitted
   * but termination proceeds (gates are advisory — we never hang shutdown).
   *
   * Wire multi-verification, debate, or code-review as gates to get
   * visibility into whether changes pass quality checks before teardown.
   */
  registerTerminationGate(gate: SessionTerminationGate): void {
    this.gateManager.registerGate(gate);
  }

  unregisterTerminationGate(name: string): void {
    this.gateManager.unregisterGate(name);
  }

  private async runTerminationGates(state: SessionState): Promise<TerminationGateResult[]> {
    return this.gateManager.runGates(state);
  }

  /**
   * Stop tracking a session.
   *
   * Runs registered termination gates before finalising teardown.
   * Gates are advisory (fail-open) — they emit events but never block shutdown.
   */
  async stopTracking(instanceId: string, archive = false): Promise<void> {
    await this.readyPromise;
    this.autoSave.clearPendingAutoSaveTimer(instanceId);

    // Run termination gates before teardown
    const state = this.sessionStates.get(instanceId);
    if (state && this.gateManager.hasGates) {
      const gateResults = await this.runTerminationGates(state);
      const blocked = gateResults.filter((r) => !r.pass);
      if (blocked.length > 0) {
        this.emit('gate:summary', {
          instanceId,
          totalGates: gateResults.length,
          blocked: blocked.length,
          reasons: blocked.map((r) => r.reason).filter(Boolean),
        });
      }
    }

    // Final save before stopping
    if (this.dirty.has(instanceId)) {
      await this.saveStateAsync(instanceId);
    }

    if (state) {
      await this.appendSessionEvent(instanceId, 'tracking_stopped', {
        archived: archive,
      });
    }

    if (!archive) {
      // Remove state file
      const stateFile = path.join(this.stateDir, `${instanceId}.json`);
      try {
        await fs.promises.access(stateFile);
        await fs.promises.unlink(stateFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      this.sessionStates.delete(instanceId);
    }

    this.emit('tracking:stopped', { instanceId, archived: archive });
  }

  /**
   * Terminate all instances belonging to a logical session.
   *
   * Inspired by codex-plugin-cc's session lifecycle hook which tags every job
   * with a sessionId and cleans up only matching jobs on session end.
   *
   * @param sessionId  The logical session identifier (e.g. CLI session or Codex thread group)
   * @param options    Control archival and parallelism
   * @returns The instance IDs that were stopped
   */
  async terminateSession(
    sessionId: string,
    options: { archive?: boolean } = {},
  ): Promise<string[]> {
    await this.readyPromise;
    const { archive = true } = options;

    // Find all instances belonging to this session
    const instanceIds: string[] = [];
    for (const [instanceId, state] of this.sessionStates.entries()) {
      if (state.sessionId === sessionId) {
        instanceIds.push(instanceId);
      }
    }

    if (instanceIds.length === 0) {
      logger.debug('No instances found for session', { sessionId });
      return [];
    }

    logger.info('Terminating session', {
      sessionId,
      instanceCount: instanceIds.length,
      archive,
    });

    // Stop tracking in parallel — gates run for each instance
    const results = await Promise.allSettled(
      instanceIds.map((id) => this.stopTracking(id, archive)),
    );

    // Log any failures (but don't block — fail-open)
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.status === 'rejected') {
        logger.warn('Failed to stop tracking instance during session termination', {
          instanceId: instanceIds[i],
          sessionId,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }

    this.emit('session:terminated', {
      sessionId,
      instanceIds,
      failedCount: results.filter((r) => r.status === 'rejected').length,
    });

    return instanceIds;
  }

  /**
   * Update session state (call after each significant change)
   */
  async updateState(instanceId: string, updates: Partial<SessionState>): Promise<void> {
    await this.readyPromise;
    const state = this.sessionStates.get(instanceId);
    if (!state) return;

    const normalizedUpdates: Partial<SessionState> = { ...updates };
    const nextSessionId = this.normalizeLookupIdentifier(normalizedUpdates.sessionId);
    if (normalizedUpdates.sessionId !== undefined) {
      normalizedUpdates.sessionId = nextSessionId ?? undefined;
      const currentSessionId = this.normalizeLookupIdentifier(state.sessionId);
      if (
        nextSessionId
        && nextSessionId !== currentSessionId
        && normalizedUpdates.nativeResumeFailedAt === undefined
      ) {
        state.nativeResumeFailedAt = null;
      }
    }

    if (normalizedUpdates.historyThreadId !== undefined) {
      normalizedUpdates.historyThreadId =
        this.normalizeLookupIdentifier(normalizedUpdates.historyThreadId) ?? undefined;
    }

    Object.assign(state, normalizedUpdates);
    this.dirty.add(instanceId);
    await this.appendSessionEvent(instanceId, 'state_updated', normalizedUpdates as Record<string, unknown>);

    this.emit('state:updated', { instanceId, updates: normalizedUpdates });
  }

  handleSystemSuspend(): void {
    logger.info('Session auto-save timer noted system suspend', {
      dirtyCount: this.dirty.size,
      pendingTimers: this.autoSave.pendingCount,
    });
  }

  handleSystemResume(graceMs = DEFAULT_RESUME_AUTOSAVE_GRACE_MS): void {
    const normalizedGraceMs = Math.max(0, graceMs);
    const deferredUntil = this.autoSave.defer(normalizedGraceMs);

    logger.info('Session auto-save deferred after system resume', {
      graceMs: normalizedGraceMs,
      deferredUntil,
      dirtyCount: this.dirty.size,
      pendingTimers: this.autoSave.pendingCount,
    });
  }

  /**
   * Add a conversation entry
   */
  async addConversationEntry(instanceId: string, entry: ConversationEntry): Promise<void> {
    await this.readyPromise;
    if (!this.config.persistSessionContent) return;
    const state = this.sessionStates.get(instanceId);
    if (!state) return;

    state.conversationHistory.push(entry);
    await this.appendSessionEvent(instanceId, 'conversation_entry', {
      role: entry.role,
      timestamp: entry.timestamp,
    });

    const decision = this.compactionPolicy.evaluate({
      messageCount: state.conversationHistory.length,
      maxConversationEntries: this.config.maxConversationEntries,
      contextUsagePercent:
        state.contextUsage.total > 0
          ? Math.round((state.contextUsage.used / state.contextUsage.total) * 100)
          : 0,
      lastCompactedAt: this.lastCompactionAt.get(instanceId),
    });

    if (decision.shouldCompact) {
      const messageCountBeforeCompaction = state.conversationHistory.length;
      const result = this.compactor.compact(state.conversationHistory, decision);
      if (result.compactedCount > 0) {
        state.conversationHistory = result.entries;
        this.lastCompactionAt.set(instanceId, Date.now());
        await this.appendSessionEvent(instanceId, 'compaction_applied', {
          compactedCount: result.compactedCount,
          reason: decision.reason,
        });
        this.emit('session:compacting', {
          instanceId,
          messageCount: messageCountBeforeCompaction,
          tokenCount: state.contextUsage.used,
        });
      }
    }

    this.dirty.add(instanceId);
  }

  /**
   * Create a named snapshot
   */
  async createSnapshot(
    instanceId: string,
    name?: string,
    description?: string,
    trigger: 'auto' | 'manual' | 'checkpoint' = 'manual',
  ): Promise<SessionSnapshot | null> {
    await this.readyPromise;
    const state = this.sessionStates.get(instanceId);
    if (!state) return null;
    const snapshot = await this.snapshots.createSnapshot(
      state, instanceId, name, description, trigger,
      (v) => this.normalizeLookupIdentifier(v),
    );
    if (snapshot) {
      await this.appendSessionEvent(instanceId, 'snapshot_created', {
        snapshotId: snapshot.id,
        trigger,
      });
    }
    return snapshot;
  }

  /**
   * List available snapshots for a session — synchronous, uses index.
   */
  listSnapshots(identifier?: string): SessionSnapshot[] {
    return this.snapshots.listSnapshots(identifier);
  }

  /**
   * Get resumable sessions (sessions with saved state)
   */
  async getResumableSessions(): Promise<SessionState[]> {
    await this.readyPromise;
    return Array.from(this.sessionStates.values()).sort(
      (a, b) =>
        (b.conversationHistory[b.conversationHistory.length - 1]?.timestamp ||
          0) -
        (a.conversationHistory[a.conversationHistory.length - 1]?.timestamp ||
          0)
    );
  }

  /**
   * Resume a session from saved state
   */
  async resumeSession(
    identifier: string,
    options: ResumeOptions = {}
  ): Promise<SessionState | null> {
    await this.readyPromise;
    let state: SessionState | null = null;

    // Load from specific snapshot if specified
    if (options.fromSnapshot) {
      const snapshot = await this.loadSnapshot(options.fromSnapshot);
      if (snapshot) {
        state = snapshot.state;
      }
    } else {
      // Load from current state
      state = this.findTrackedStateByIdentifier(identifier)?.state || null;

      if (!state) {
        const loaded = await this.loadStateFromDiskByIdentifier(identifier);
        if (loaded) {
          state = loaded;
          this.sessionStates.set(loaded.instanceId, loaded);
        }
      }
    }

    if (!state) return null;

    // Layer 2: Validate transcript integrity
    if (state.conversationHistory.length > 0) {
      const repairResult = validateTranscript(state.conversationHistory);
      if (repairResult.status === 'repaired') {
        state.conversationHistory = repairResult.entries;
        logger.info('Transcript repaired during resume', {
          identifier,
          repairs: repairResult.repairs,
        });
      }
    }

    // Apply resume options
    const resumedState: SessionState = { ...state };

    if (options.restoreMessages === false) {
      resumedState.conversationHistory = [];
    }

    if (options.restoreContext === false) {
      resumedState.contextUsage = { used: 0, total: state.contextUsage.total };
    }

    if (options.restoreTasks === false) {
      resumedState.pendingTasks = [];
    }

    if (options.restoreEnvironment === false) {
      resumedState.environmentVariables = {};
    }

    // If persisted cursor exists and is fresh (< 7 days), use it for native resume
    const CURSOR_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
    if (state.resumeCursor
        && state.resumeCursor.capturedAt > Date.now() - CURSOR_MAX_AGE_MS) {
      // Pass cursor threadId as the sessionId for the adapter
      resumedState.sessionId = state.resumeCursor.threadId;
      logger.info('Using persisted resume cursor', {
        threadId: state.resumeCursor.threadId,
        scanSource: state.resumeCursor.scanSource,
        age: Date.now() - state.resumeCursor.capturedAt,
      });
    }

    this.emit('session:resumed', { identifier, state: resumedState, options });
    return resumedState;
  }

  async markNativeResumeFailed(identifier: string, failedAt = Date.now()): Promise<boolean> {
    await this.readyPromise;
    const tracked = this.findTrackedStateByIdentifier(identifier);
    if (!tracked) {
      const loaded = await this.loadStateFromDiskByIdentifier(identifier);
      if (!loaded) {
        return false;
      }
      this.sessionStates.set(loaded.instanceId, loaded);
      loaded.nativeResumeFailedAt = failedAt;
      this.dirty.add(loaded.instanceId);
      await this.saveStateAsync(loaded.instanceId);
      return true;
    }

    tracked.state.nativeResumeFailedAt = failedAt;
    this.dirty.add(tracked.instanceId);
    await this.saveStateAsync(tracked.instanceId);
    return true;
  }

  /**
   * Get transcript for a session
   */
  async getTranscript(
    instanceId: string,
    format: 'json' | 'markdown' | 'text' = 'markdown'
  ): Promise<string> {
    await this.readyPromise;
    const state = this.sessionStates.get(instanceId);
    if (!state) return '';

    switch (format) {
      case 'json':
        return JSON.stringify(state.conversationHistory, null, 2);

      case 'markdown':
        return state.conversationHistory
          .map((entry) => {
            const roleLabel =
              entry.role === 'user'
                ? '**User**'
                : entry.role === 'assistant'
                  ? '**Assistant**'
                  : entry.role === 'system'
                    ? '*System*'
                    : '*Tool*';
            const timestamp = new Date(entry.timestamp).toLocaleString();
            let content = `### ${roleLabel} (${timestamp})\n\n${entry.content}`;

            if (entry.thinking) {
              content += `\n\n<details>\n<summary>Thinking</summary>\n\n${entry.thinking}\n\n</details>`;
            }

            if (entry.toolUse) {
              content += `\n\n**Tool:** ${entry.toolUse.toolName}\n\`\`\`json\n${JSON.stringify(entry.toolUse.input, null, 2)}\n\`\`\``;
              if (entry.toolUse.output) {
                content += `\n\n**Output:**\n\`\`\`\n${entry.toolUse.output}\n\`\`\``;
              }
            }

            return content;
          })
          .join('\n\n---\n\n');

      case 'text':
      default:
        return state.conversationHistory
          .map((entry) => {
            const role = entry.role.toUpperCase();
            const time = new Date(entry.timestamp).toLocaleString();
            return `[${time}] ${role}:\n${entry.content}`;
          })
          .join('\n\n');
    }
  }

  /**
   * Export session for external storage/sharing
   */
  async exportSession(
    instanceId: string
  ): Promise<{ state: SessionState; snapshots: SessionSnapshot[] } | null> {
    await this.readyPromise;
    const state = this.sessionStates.get(instanceId);
    if (!state) return null;

    let stateClone: SessionState;
    try {
      stateClone = structuredClone(state);
    } catch {
      stateClone = JSON.parse(JSON.stringify(state)) as SessionState;
    }

    const snapshots = this.listSnapshots(instanceId);

    return {
      state: stateClone,
      snapshots
    };
  }

  /**
   * Import a session from exported data
   */
  async importSession(
    data: { state: SessionState; snapshots?: SessionSnapshot[] },
    newInstanceId?: string
  ): Promise<string> {
    await this.readyPromise;
    const instanceId = newInstanceId || data.state.instanceId;
    const state = { ...data.state, instanceId };

    this.sessionStates.set(instanceId, state);
    await this.saveStateAsync(instanceId);

    // Import snapshots if provided
    if (data.snapshots) {
      for (const snapshot of data.snapshots) {
        const updatedSnapshot: SessionSnapshot = {
          ...snapshot,
          instanceId,
          historyThreadId: snapshot.historyThreadId || state.historyThreadId,
          sessionId: snapshot.sessionId || state.sessionId,
        };
        const snapshotFile = path.join(this.snapshotDir, `${snapshot.id}.json`);
        await this.writePayload(snapshotFile, updatedSnapshot);
        this.snapshotIndex.add({
          id: updatedSnapshot.id,
          instanceId: updatedSnapshot.instanceId,
          sessionId: updatedSnapshot.sessionId,
          historyThreadId: updatedSnapshot.historyThreadId,
          timestamp: updatedSnapshot.timestamp,
          messageCount: updatedSnapshot.metadata.messageCount,
          schemaVersion: updatedSnapshot.schemaVersion ?? CURRENT_SCHEMA_VERSION
        });
      }
    }

    this.emit('session:imported', { instanceId });
    return instanceId;
  }

  /**
   * Convert Instance to SessionState
   */
  private instanceToState(instance: Instance): SessionState {
    const persistContent = this.config.persistSessionContent;
    const redactToolOutputs = this.config.redactToolOutputs;

    const state: SessionState = {
      instanceId: instance.id,
      sessionId: instance.sessionId,
      historyThreadId: instance.historyThreadId,
      nativeResumeFailedAt: null,
      displayName: instance.displayName,
      isRenamed: instance.isRenamed,
      agentId: instance.agentId,
      modelId: instance.currentModel || CLAUDE_MODELS.SONNET,
      provider: instance.provider,
      workingDirectory: instance.workingDirectory,
      systemPrompt: undefined,
      temperature: undefined,
      maxTokens: undefined,
      conversationHistory: persistContent
        ? instance.outputBuffer.map((msg, idx) => ({
            id: `msg-${idx}`,
            role:
              msg.type === 'user'
                ? ('user' as const)
                : msg.type === 'assistant'
                  ? ('assistant' as const)
                  : msg.type === 'tool_use' || msg.type === 'tool_result'
                    ? ('tool' as const)
                    : ('system' as const),
            content:
              redactToolOutputs && msg.type === 'tool_result'
                ? '[REDACTED TOOL OUTPUT]'
                : msg.content,
            timestamp: msg.timestamp,
            tokens: undefined
          }))
        : [],
      contextUsage: {
        used: instance.contextUsage.used,
        total: instance.contextUsage.total,
        costEstimate: instance.contextUsage.costEstimate
      },
      pendingTasks: [],
      environmentVariables: {},
      activeFiles: [],
      gitBranch: undefined,
      customInstructions: undefined,
      skillsLoaded: [],
      hooksActive: []
    };

    return state;
  }

  /**
   * Async save with atomic write (tmp → fsync → rename → fsync parent)
   */
  private async saveStateAsync(instanceId: string): Promise<void> {
    const state = this.sessionStates.get(instanceId);
    if (!state) return;

    const mutex = getSessionMutex();
    const release = await mutex.acquire(instanceId, 'auto-save');
    try {
      // Capture resume cursor from adapter if available
      this.captureResumeCursor(instanceId, state);
      state.lastWriteTimestamp = Date.now();
      state.lastWriteSource = 'auto-save';

      const stateFile = path.join(this.stateDir, `${instanceId}.json`);
      await measureAsync('session.save', () => this.writePayload(stateFile, state));
      this.dirty.delete(instanceId);
      await this.appendSessionEvent(instanceId, 'state_saved', {
        source: state.lastWriteSource ?? 'unknown',
        timestamp: state.lastWriteTimestamp ?? Date.now(),
      });
      this.emit('state:saved', { instanceId });
    } catch (error) {
      logger.error('Failed to save session state', error instanceof Error ? error : undefined, { instanceId });
      this.emit('state:save-error', { instanceId, error });
    } finally {
      release();
    }
  }

  /**
   * Load a specific snapshot from disk
   */
  private async loadSnapshot(snapshotId: string): Promise<SessionSnapshot | null> {
    return this.snapshots.loadSnapshot(snapshotId);
  }

  /**
   * Atomic async write: tmp → fsync → rename → fsync parent dir
   */
  private async writePayload(filePath: string, data: unknown): Promise<void> {
    const serialized = this.serializePayload(data);
    const tmpFile = `${filePath}.tmp`;
    const dir = path.dirname(filePath);
    const lockPath = `${filePath}.lock`;

    await withLock(lockPath, async () => {
      const fh = await fs.promises.open(tmpFile, 'w');
      try {
        await fh.writeFile(serialized);
        await fh.sync();
      } finally {
        await fh.close();
      }

      await fs.promises.rename(tmpFile, filePath);

      // Best-effort fsync on parent directory
      try {
        const dirFh = await fs.promises.open(dir, 'r');
        try {
          await dirFh.sync();
        } finally {
          await dirFh.close();
        }
      } catch {
        // Directory fsync is not supported on all platforms (e.g. Windows)
      }
    }, { purpose: `snapshot-${path.basename(filePath, '.json')}` });
  }

  /**
   * Async read payload
   */
  private async readPayload<T>(filePath: string): Promise<T | null> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf-8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        logger.debug('Continuity file not found', { path: filePath });
      } else {
        logger.error('Failed to read continuity file', error instanceof Error ? error : undefined, {
          path: filePath,
          errorCode: code,
        });
      }
      return null;
    }

    const result = this.deserializePayload<T>(raw, filePath);
    if (result) return result;

    // Specific case: the envelope is structurally valid but decryption failed.
    // This happens after reinstall / keychain rotation when safeStorage can
    // no longer decrypt data written by a previous install (e.g. because of
    // the `use-mock-keychain` switch or Keychain permission changes).
    // repairFile() can't detect this — the file parses as valid JSON with
    // a well-formed { encrypted: true, data: "<base64>" } envelope — so it
    // would otherwise stay in states/ and re-throw the same decrypt error on
    // every subsequent startup. Quarantine it so future startups stay clean.
    try {
      const parsedEnvelope = JSON.parse(raw) as Record<string, unknown>;
      if (
        parsedEnvelope &&
        typeof parsedEnvelope === 'object' &&
        parsedEnvelope['encrypted'] === true &&
        typeof parsedEnvelope['data'] === 'string'
      ) {
        try {
          const quarantinedPath = quarantineFile(filePath, this.quarantineDir);
          logger.warn(
            'Quarantined undecryptable session state file (likely post-reinstall safeStorage key change)',
            { original: filePath, dest: quarantinedPath },
          );
        } catch (quarantineError) {
          logger.error(
            'Failed to quarantine undecryptable session state file',
            quarantineError instanceof Error ? quarantineError : undefined,
            { path: filePath },
          );
        }
        return null;
      }
    } catch {
      // raw isn't parseable as JSON — fall through to normal repair pathway
    }

    // Deserialization failed — attempt repair (Layer 1).
    // If the repair rewrites the file, re-read it once; otherwise treat it as unrecoverable.
    try {
      const repair = repairFile(filePath, this.quarantineDir);
      if (repair.status === 'repaired') {
        logger.info('File repaired during load', { path: filePath, repairs: repair.repairs });
        const reRaw = await fs.promises.readFile(filePath, 'utf-8');
        return this.deserializePayload<T>(reRaw, filePath);
      }

      logger.warn('Session file unrecoverable', { path: filePath, status: repair.status });
    } catch (repairError) {
      logger.error('File repair itself failed', repairError instanceof Error ? repairError : undefined, {
        path: filePath,
      });
    }

    return null;
  }

  private serializePayload(data: unknown): string {
    const json = JSON.stringify(data);
    if (this.config.encryptOnDisk) {
      // Lazy access to avoid triggering Keychain usage on startup.
      // See safe-storage-accessor.ts for the why behind the indirection.
      const safeStorage = getSafeStorage();
      if (safeStorage.isEncryptionAvailable()) {
        const encrypted = safeStorage.encryptString(json).toString('base64');
        return JSON.stringify({ encrypted: true, data: encrypted });
      }
    }
    return JSON.stringify({ encrypted: false, data: json });
  }

  private deserializePayload<T>(raw: string, filePath?: string): T | null {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      logger.error('Session file contains invalid JSON', error instanceof Error ? error : undefined, {
        filePath,
        rawLength: raw.length,
        rawPreview: raw.substring(0, 100),
      });
      return null;
    }

    try {
      if (
        parsed &&
        typeof parsed === 'object' &&
        'encrypted' in parsed &&
        'data' in parsed
      ) {
        if (
          parsed['encrypted'] === true &&
          typeof parsed['data'] === 'string'
        ) {
          // Lazy access to avoid triggering Keychain usage on startup.
          // See safe-storage-accessor.ts for the why behind the indirection.
          const safeStorage = getSafeStorage();
          const decrypted = safeStorage.decryptString(
            Buffer.from(parsed['data'], 'base64')
          );
          return JSON.parse(decrypted) as T;
        }
        if (
          parsed['encrypted'] === false &&
          typeof parsed['data'] === 'string'
        ) {
          return JSON.parse(parsed['data']) as T;
        }
      }

      // Fallback to legacy plain JSON
      return parsed as unknown as T;
    } catch (error) {
      logger.error('Failed to decrypt/parse session payload', error instanceof Error ? error : undefined, {
        filePath,
        encrypted: parsed['encrypted'],
        dataType: typeof parsed['data'],
      });
      return null;
    }
  }

  /**
   * Cleanup old snapshots — single-pass using index.
   *
   * Three pruning strategies (in order):
   *   1. Age-based: Remove snapshots older than snapshotRetentionDays
   *   2. Per-session: Cap each session at maxSnapshots (default 50)
   *   3. Global cap: Keep total snapshot count under maxTotalSnapshots (default 500)
   *
   * Inspired by the codex-plugin-cc state pruning pattern (MAX_JOBS = 50).
   */
  private async cleanupSnapshots(instanceId: string): Promise<void> {
    return this.snapshots.cleanupSnapshots(instanceId);
  }

  private async pruneOnStartup(): Promise<void> {
    return this.snapshots.pruneOnStartup();
  }

  /**
   * Get continuity statistics
   */
  async getStats(): Promise<{
    activeSessions: number;
    totalSnapshots: number;
    diskUsageBytes: number;
    oldestSession: number | null;
    newestSession: number | null;
  }> {
    await this.readyPromise;
    let diskUsageBytes = 0;
    let oldestSession: number | null = null;
    let newestSession: number | null = null;

    // Calculate disk usage
    for (const dir of [this.stateDir, this.snapshotDir]) {
      try {
        const files = await fs.promises.readdir(dir);
        for (const file of files) {
          try {
            const stat = await fs.promises.stat(path.join(dir, file));
            diskUsageBytes += stat.size;
          } catch {
            // File may have been deleted between readdir and stat
          }
        }
      } catch (error) {
        logger.warn('Failed to calculate disk usage for session directory', { dir, error: error instanceof Error ? error.message : String(error) });
      }
    }

    // Find oldest and newest sessions
    for (const state of this.sessionStates.values()) {
      const firstTimestamp = state.conversationHistory[0]?.timestamp;
      const lastTimestamp =
        state.conversationHistory[state.conversationHistory.length - 1]
          ?.timestamp;

      if (firstTimestamp) {
        if (oldestSession === null || firstTimestamp < oldestSession) {
          oldestSession = firstTimestamp;
        }
      }

      if (lastTimestamp) {
        if (newestSession === null || lastTimestamp > newestSession) {
          newestSession = lastTimestamp;
        }
      }
    }

    return {
      activeSessions: this.sessionStates.size,
      totalSnapshots: this.snapshotIndex.size,
      diskUsageBytes,
      oldestSession,
      newestSession
    };
  }

  /**
   * Configure the manager
   */
  configure(config: Partial<ContinuityConfig>): void {
    this.config = { ...this.config, ...config };
    this.snapshots.updateRetentionConfig({
      maxSnapshots: this.config.maxSnapshots,
      maxTotalSnapshots: this.config.maxTotalSnapshots,
      snapshotRetentionDays: this.config.snapshotRetentionDays,
    });

    // Update global auto-save timer if interval or enabled flag changed
    if (
      config.autoSaveIntervalMs !== undefined ||
      config.autoSaveEnabled !== undefined
    ) {
      this.autoSave.reconfigure(this.config);
    }
  }

  /**
   * Cleanup and shutdown — synchronous best-effort save (Electron requirement)
   */
  shutdown(): void {
    this.autoSave.stop();

    // Best-effort synchronous save of all dirty states
    for (const instanceId of this.dirty) {
      const state = this.sessionStates.get(instanceId);
      if (!state) continue;
      try {
        const stateFile = path.join(this.stateDir, `${instanceId}.json`);
        const serialized = this.serializePayload(state);
        fs.writeFileSync(stateFile, serialized);
      } catch (error) {
        logger.error('Failed to save session state during shutdown', error instanceof Error ? error : undefined, { instanceId });
      }
    }

    // Persist resume hint for quick restart on next launch
    try {
      const states = [...this.sessionStates.values()];
      const mostRecent = states.sort((a, b) => (b.lastWriteTimestamp ?? 0) - (a.lastWriteTimestamp ?? 0))[0];
      if (mostRecent) {
        getResumeHintManager().saveHint({
          sessionId: mostRecent.sessionId ?? mostRecent.instanceId,
          instanceId: mostRecent.instanceId,
          displayName: mostRecent.displayName,
          timestamp: Date.now(),
          workingDirectory: mostRecent.workingDirectory,
          instanceCount: this.sessionStates.size,
          provider: mostRecent.provider ?? 'claude',
          model: mostRecent.modelId,
        });
      }
    } catch {
      // Best effort — never block shutdown
    }
  }

  /**
   * Inject the InstanceManager. Called from main process startup so that
   * captureResumeCursor() can reach the adapter without a global lookup.
   */
  setInstanceManager(im: InstanceManagerForContinuity): void {
    this.instanceManager = im;
  }

  /**
   * Capture resume cursor from the adapter (if it exposes one) into the session state.
   * Called during auto-save so the cursor is persisted to disk without the Instance
   * needing to expose its adapter property.
   */
  private captureResumeCursor(instanceId: string, state: SessionState): void {
    if (!this.instanceManager) return; // Not wired yet — best effort only
    try {
      const adapter = this.instanceManager.getAdapter(instanceId);
      if (adapter && typeof (adapter as { getResumeCursor?: () => unknown }).getResumeCursor === 'function') {
        state.resumeCursor = ((adapter as { getResumeCursor: () => unknown }).getResumeCursor() ?? null) as SessionState['resumeCursor'];
      }
    } catch {
      // Best effort — don't let cursor capture fail the save
    }
  }

  private async appendSessionEvent(
    instanceId: string,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const state = this.sessionStates.get(instanceId);
    if (!state) {
      return;
    }

    const logPath = this.storagePaths.getSessionEventLogPath(state.workingDirectory, instanceId);
    try {
      await fs.promises.mkdir(path.dirname(logPath), { recursive: true });
      await fs.promises.appendFile(
        logPath,
        JSON.stringify({
          type,
          instanceId,
          timestamp: Date.now(),
          payload,
        }) + '\n',
        'utf-8',
      );
    } catch (error) {
      logger.warn('Failed to append session event log entry', {
        instanceId,
        type,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// Singleton instance
let continuityManagerInstance: SessionContinuityManager | null = null;

export function getSessionContinuityManager(): SessionContinuityManager {
  if (!continuityManagerInstance) {
    const settings = getSettingsManager();
    continuityManagerInstance = new SessionContinuityManager({
      persistSessionContent: settings.get('persistSessionContent')
    });
  }
  return continuityManagerInstance;
}

export function getSessionContinuityManagerIfInitialized(): SessionContinuityManager | null {
  return continuityManagerInstance;
}
