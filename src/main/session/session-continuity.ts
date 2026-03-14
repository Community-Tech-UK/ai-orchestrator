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
import { app, safeStorage } from 'electron';
import { EventEmitter } from 'events';
import type { Instance } from '../../shared/types/instance.types';
import { CLAUDE_MODELS } from '../../shared/types/provider.types';
import { getSettingsManager } from '../core/config/settings-manager';
import { getLogger } from '../logging/logger';
import { SnapshotIndex } from './snapshot-index';

const logger = getLogger('SessionContinuity');

const SCHEMA_VERSION = 1;

/**
 * Session snapshot for point-in-time restoration
 */
export interface SessionSnapshot {
  id: string;
  sessionId: string;
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
 * Complete session state for restoration
 */
export interface SessionState {
  instanceId: string;
  displayName: string;
  agentId: string;
  modelId: string;
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
 * Session continuity configuration
 */
export interface ContinuityConfig {
  autoSaveEnabled: boolean;
  autoSaveIntervalMs: number;
  maxSnapshots: number;
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
}

const DEFAULT_CONFIG: ContinuityConfig = {
  autoSaveEnabled: true,
  autoSaveIntervalMs: 60000, // 1 minute
  maxSnapshots: 50,
  snapshotRetentionDays: 30,
  compressOldSnapshots: true,
  resumeOnStartup: true,
  preserveToolResults: true,
  maxConversationEntries: 1000,
  encryptOnDisk: true,
  persistSessionContent: true,
  redactToolOutputs: true
};

/**
 * Session Continuity Manager
 */
export class SessionContinuityManager extends EventEmitter {
  private continuityDir: string;
  private stateDir: string;
  private snapshotDir: string;
  private quarantineDir: string;
  private config: ContinuityConfig;
  private sessionStates = new Map<string, SessionState>();
  private dirty = new Set<string>();
  private readyPromise: Promise<void>;
  private inFlightSaves = new Set<string>();
  private globalAutoSaveTimer: NodeJS.Timeout | null = null;
  private snapshotIndex: SnapshotIndex;

  constructor(config: Partial<ContinuityConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    const userData = app.getPath('userData');
    this.continuityDir = path.join(userData, 'session-continuity');
    this.stateDir = path.join(this.continuityDir, 'states');
    this.snapshotDir = path.join(this.continuityDir, 'snapshots');
    this.quarantineDir = path.join(this.continuityDir, 'quarantine');

    this.snapshotIndex = new SnapshotIndex();
    this.readyPromise = this.initAsync();
  }

  /**
   * Async initialization — runs in the background after construction.
   */
  private async initAsync(): Promise<void> {
    await this.ensureDirectories();
    await this.loadActiveStates();
    await this.buildSnapshotIndex();
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

  /**
   * Load active session states from disk
   */
  private async loadActiveStates(): Promise<void> {
    try {
      const files = await fs.promises.readdir(this.stateDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(this.stateDir, file);
          const data = await this.readPayload<SessionState>(filePath);
          if (data) {
            this.sessionStates.set(data.instanceId, data);
          }
        }
      }
    } catch (error) {
      logger.error('Failed to load session states', error instanceof Error ? error : undefined);
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
              sessionId: data.sessionId,
              timestamp: data.timestamp,
              messageCount: data.metadata.messageCount,
              schemaVersion: data.schemaVersion ?? SCHEMA_VERSION
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
    if (!this.config.autoSaveEnabled) return;

    this.globalAutoSaveTimer = setInterval(() => {
      for (const instanceId of this.dirty) {
        if (this.inFlightSaves.has(instanceId)) continue;

        // Add random jitter of 0-10s to spread writes
        const jitter = Math.random() * 10000;
        const timer = setTimeout(() => {
          this.saveStateAsync(instanceId).catch((error) => {
            logger.error('Auto-save failed', error instanceof Error ? error : undefined, { instanceId });
          });
        }, jitter);
        // Unref the jitter timer so it doesn't block process exit
        if (timer.unref) timer.unref();
      }
    }, this.config.autoSaveIntervalMs);

    if (this.globalAutoSaveTimer.unref) {
      this.globalAutoSaveTimer.unref();
    }
  }

  /**
   * Start tracking a session for continuity
   */
  async startTracking(instance: Instance): Promise<void> {
    await this.readyPromise;
    const state = this.instanceToState(instance);
    this.sessionStates.set(instance.id, state);
    this.dirty.add(instance.id);

    this.emit('tracking:started', { instanceId: instance.id });
  }

  /**
   * Stop tracking a session
   */
  async stopTracking(instanceId: string, archive = false): Promise<void> {
    await this.readyPromise;

    // Final save before stopping
    if (this.dirty.has(instanceId)) {
      await this.saveStateAsync(instanceId);
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
   * Update session state (call after each significant change)
   */
  async updateState(instanceId: string, updates: Partial<SessionState>): Promise<void> {
    await this.readyPromise;
    const state = this.sessionStates.get(instanceId);
    if (!state) return;

    Object.assign(state, updates);
    this.dirty.add(instanceId);

    this.emit('state:updated', { instanceId, updates });
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

    // Trim if exceeding max entries
    if (state.conversationHistory.length > this.config.maxConversationEntries) {
      // Compact older entries
      const toCompact = state.conversationHistory.splice(
        0,
        state.conversationHistory.length - this.config.maxConversationEntries
      );

      // Create summary entry
      const summaryEntry: ConversationEntry = {
        id: `compacted-${Date.now()}`,
        role: 'system',
        content: `[Compacted ${toCompact.length} earlier messages. Key context preserved in session state.]`,
        timestamp: Date.now(),
        isCompacted: true
      };
      state.conversationHistory.unshift(summaryEntry);
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
    trigger: 'auto' | 'manual' | 'checkpoint' = 'manual'
  ): Promise<SessionSnapshot | null> {
    await this.readyPromise;
    const state = this.sessionStates.get(instanceId);
    if (!state) return null;

    let stateClone: SessionState;
    try {
      stateClone = structuredClone(state);
    } catch {
      stateClone = JSON.parse(JSON.stringify(state)) as SessionState;
    }

    const snapshot: SessionSnapshot = {
      id: `snap-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      sessionId: instanceId,
      timestamp: Date.now(),
      name,
      description,
      schemaVersion: SCHEMA_VERSION,
      state: stateClone,
      metadata: {
        messageCount: state.conversationHistory.length,
        tokensUsed: state.contextUsage.used,
        duration:
          Date.now() - (state.conversationHistory[0]?.timestamp || Date.now()),
        trigger
      }
    };

    // Save snapshot
    const snapshotFile = path.join(this.snapshotDir, `${snapshot.id}.json`);
    await this.writePayload(snapshotFile, snapshot);

    // Update index
    this.snapshotIndex.add({
      id: snapshot.id,
      sessionId: snapshot.sessionId,
      timestamp: snapshot.timestamp,
      messageCount: snapshot.metadata.messageCount,
      schemaVersion: SCHEMA_VERSION
    });

    // Cleanup old snapshots
    await this.cleanupSnapshots(instanceId);

    this.emit('snapshot:created', snapshot);
    return snapshot;
  }

  /**
   * List available snapshots for a session — synchronous, uses index.
   */
  listSnapshots(instanceId?: string): SessionSnapshot[] {
    const metas = instanceId
      ? this.snapshotIndex.listForSession(instanceId)
      : this.snapshotIndex.listAll();

    // Return lightweight objects that satisfy SessionSnapshot shape.
    // Full state is not included since this is just a listing.
    return metas.map((meta) => ({
      id: meta.id,
      sessionId: meta.sessionId,
      timestamp: meta.timestamp,
      schemaVersion: meta.schemaVersion,
      state: {} as SessionState, // not loaded for listing
      metadata: {
        messageCount: meta.messageCount,
        tokensUsed: 0,
        duration: 0,
        trigger: 'auto' as const
      }
    }));
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
    instanceId: string,
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
      state = this.sessionStates.get(instanceId) || null;

      if (!state) {
        // Try loading from disk
        const stateFile = path.join(this.stateDir, `${instanceId}.json`);
        try {
          await fs.promises.access(stateFile);
          const loaded = await this.readPayload<SessionState>(stateFile);
          if (loaded) {
            state = loaded;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
    }

    if (!state) return null;

    // Apply resume options
    const resumedState: SessionState = { ...state };

    if (!options.restoreMessages) {
      resumedState.conversationHistory = [];
    }

    if (!options.restoreContext) {
      resumedState.contextUsage = { used: 0, total: state.contextUsage.total };
    }

    if (!options.restoreTasks) {
      resumedState.pendingTasks = [];
    }

    if (!options.restoreEnvironment) {
      resumedState.environmentVariables = {};
    }

    this.emit('session:resumed', { instanceId, state: resumedState, options });
    return resumedState;
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
        const updatedSnapshot = { ...snapshot, sessionId: instanceId };
        const snapshotFile = path.join(this.snapshotDir, `${snapshot.id}.json`);
        await this.writePayload(snapshotFile, updatedSnapshot);
        this.snapshotIndex.add({
          id: updatedSnapshot.id,
          sessionId: updatedSnapshot.sessionId,
          timestamp: updatedSnapshot.timestamp,
          messageCount: updatedSnapshot.metadata.messageCount,
          schemaVersion: updatedSnapshot.schemaVersion ?? SCHEMA_VERSION
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

    return {
      instanceId: instance.id,
      displayName: instance.displayName,
      agentId: instance.agentId,
      modelId: CLAUDE_MODELS.SONNET, // Default model
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
  }

  /**
   * Async save with atomic write (tmp → fsync → rename → fsync parent)
   */
  private async saveStateAsync(instanceId: string): Promise<void> {
    const state = this.sessionStates.get(instanceId);
    if (!state) return;

    if (this.inFlightSaves.has(instanceId)) return;
    this.inFlightSaves.add(instanceId);

    try {
      const stateFile = path.join(this.stateDir, `${instanceId}.json`);
      await this.writePayload(stateFile, state);
      this.dirty.delete(instanceId);
      this.emit('state:saved', { instanceId });
    } catch (error) {
      logger.error('Failed to save session state', error instanceof Error ? error : undefined, { instanceId });
      this.emit('state:save-error', { instanceId, error });
    } finally {
      this.inFlightSaves.delete(instanceId);
    }
  }

  /**
   * Load a specific snapshot from disk
   */
  private async loadSnapshot(snapshotId: string): Promise<SessionSnapshot | null> {
    const snapshotFile = path.join(this.snapshotDir, `${snapshotId}.json`);

    try {
      await fs.promises.access(snapshotFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    return this.readPayload<SessionSnapshot>(snapshotFile);
  }

  /**
   * Atomic async write: tmp → fsync → rename → fsync parent dir
   */
  private async writePayload(filePath: string, data: unknown): Promise<void> {
    const serialized = this.serializePayload(data);
    const tmpFile = `${filePath}.tmp`;
    const dir = path.dirname(filePath);

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
  }

  /**
   * Async read payload
   */
  private async readPayload<T>(filePath: string): Promise<T | null> {
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      return this.deserializePayload<T>(raw);
    } catch (error) {
      logger.error('Failed to read continuity payload', error instanceof Error ? error : undefined);
      return null;
    }
  }

  private serializePayload(data: unknown): string {
    const json = JSON.stringify(data);
    if (this.config.encryptOnDisk && safeStorage.isEncryptionAvailable()) {
      const encrypted = safeStorage.encryptString(json).toString('base64');
      return JSON.stringify({ encrypted: true, data: encrypted });
    }
    return JSON.stringify({ encrypted: false, data: json });
  }

  private deserializePayload<T>(raw: string): T | null {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
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
      logger.error('Failed to decrypt continuity payload', error instanceof Error ? error : undefined);
      return null;
    }
  }

  /**
   * Cleanup old snapshots — single-pass using index
   */
  private async cleanupSnapshots(instanceId: string): Promise<void> {
    const cutoffTime =
      Date.now() - this.config.snapshotRetentionDays * 24 * 60 * 60 * 1000;

    // Collect IDs to remove: expired by age + excess by count
    const toRemoveIds = new Set<string>();

    // Expired snapshots (all sessions)
    for (const meta of this.snapshotIndex.getExpiredBefore(cutoffTime)) {
      toRemoveIds.add(meta.id);
    }

    // After removing expired, compute excess for this session
    // Build what the session list would look like after removals
    const sessionMetas = this.snapshotIndex
      .listForSession(instanceId)
      .filter((m) => !toRemoveIds.has(m.id));

    if (sessionMetas.length > this.config.maxSnapshots) {
      const excess = sessionMetas.slice(this.config.maxSnapshots);
      for (const meta of excess) {
        toRemoveIds.add(meta.id);
      }
    }

    for (const id of toRemoveIds) {
      const snapshotFile = path.join(this.snapshotDir, `${id}.json`);
      try {
        await fs.promises.unlink(snapshotFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          logger.warn('Failed to delete snapshot', { id, error: error instanceof Error ? error.message : String(error) });
        }
      }
      this.snapshotIndex.remove(id);
    }
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

    // Update global auto-save timer if interval or enabled flag changed
    if (
      config.autoSaveIntervalMs !== undefined ||
      config.autoSaveEnabled !== undefined
    ) {
      if (this.globalAutoSaveTimer !== null) {
        clearInterval(this.globalAutoSaveTimer);
        this.globalAutoSaveTimer = null;
      }
      if (this.config.autoSaveEnabled) {
        this.startGlobalAutoSave();
      }
    }
  }

  /**
   * Cleanup and shutdown — synchronous best-effort save (Electron requirement)
   */
  shutdown(): void {
    // Clear global autosave timer
    if (this.globalAutoSaveTimer !== null) {
      clearInterval(this.globalAutoSaveTimer);
      this.globalAutoSaveTimer = null;
    }

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
