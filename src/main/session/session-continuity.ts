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

const logger = getLogger('SessionContinuity');

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
  private config: ContinuityConfig;
  private autoSaveTimers = new Map<string, NodeJS.Timeout>();
  private sessionStates = new Map<string, SessionState>();
  private dirty = new Set<string>();

  constructor(config: Partial<ContinuityConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };

    const userData = app.getPath('userData');
    this.continuityDir = path.join(userData, 'session-continuity');
    this.stateDir = path.join(this.continuityDir, 'states');
    this.snapshotDir = path.join(this.continuityDir, 'snapshots');

    this.ensureDirectories();
    this.loadActiveStates();
  }

  /**
   * Ensure required directories exist
   */
  private ensureDirectories(): void {
    for (const dir of [this.continuityDir, this.stateDir, this.snapshotDir]) {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
  }

  /**
   * Load active session states from disk
   */
  private loadActiveStates(): void {
    try {
      const files = fs.readdirSync(this.stateDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(this.stateDir, file);
          const data = this.readPayload<SessionState>(filePath);
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
   * Start tracking a session for continuity
   */
  startTracking(instance: Instance): void {
    const state = this.instanceToState(instance);
    this.sessionStates.set(instance.id, state);
    this.dirty.add(instance.id);

    // Set up auto-save if enabled
    if (this.config.autoSaveEnabled) {
      this.setupAutoSave(instance.id);
    }

    this.emit('tracking:started', { instanceId: instance.id });
  }

  /**
   * Stop tracking a session
   */
  stopTracking(instanceId: string, archive = false): void {
    // Clear auto-save timer
    const timer = this.autoSaveTimers.get(instanceId);
    if (timer) {
      clearInterval(timer);
      this.autoSaveTimers.delete(instanceId);
    }

    // Final save before stopping
    if (this.dirty.has(instanceId)) {
      this.saveState(instanceId);
    }

    if (!archive) {
      // Remove state file
      const stateFile = path.join(this.stateDir, `${instanceId}.json`);
      if (fs.existsSync(stateFile)) {
        fs.unlinkSync(stateFile);
      }
      this.sessionStates.delete(instanceId);
    }

    this.emit('tracking:stopped', { instanceId, archived: archive });
  }

  /**
   * Update session state (call after each significant change)
   */
  updateState(instanceId: string, updates: Partial<SessionState>): void {
    const state = this.sessionStates.get(instanceId);
    if (!state) return;

    Object.assign(state, updates);
    this.dirty.add(instanceId);

    this.emit('state:updated', { instanceId, updates });
  }

  /**
   * Add a conversation entry
   */
  addConversationEntry(instanceId: string, entry: ConversationEntry): void {
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
  createSnapshot(
    instanceId: string,
    name?: string,
    description?: string,
    trigger: 'auto' | 'manual' | 'checkpoint' = 'manual'
  ): SessionSnapshot | null {
    const state = this.sessionStates.get(instanceId);
    if (!state) return null;

    const snapshot: SessionSnapshot = {
      id: `snap-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      sessionId: instanceId,
      timestamp: Date.now(),
      name,
      description,
      state: JSON.parse(JSON.stringify(state)), // Deep clone
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
    this.writePayload(snapshotFile, snapshot);

    // Cleanup old snapshots
    this.cleanupSnapshots(instanceId);

    this.emit('snapshot:created', snapshot);
    return snapshot;
  }

  /**
   * List available snapshots for a session
   */
  listSnapshots(instanceId?: string): SessionSnapshot[] {
    const snapshots: SessionSnapshot[] = [];

    try {
      const files = fs.readdirSync(this.snapshotDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(this.snapshotDir, file);
          const data = this.readPayload<SessionSnapshot>(filePath);
          if (data && (!instanceId || data.sessionId === instanceId)) {
            snapshots.push(data);
          }
        }
      }
    } catch (error) {
      logger.error('Failed to list snapshots', error instanceof Error ? error : undefined);
    }

    return snapshots.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Get resumable sessions (sessions with saved state)
   */
  getResumableSessions(): SessionState[] {
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
    let state: SessionState | null = null;

    // Load from specific snapshot if specified
    if (options.fromSnapshot) {
      const snapshot = this.loadSnapshot(options.fromSnapshot);
      if (snapshot) {
        state = snapshot.state;
      }
    } else {
      // Load from current state
      state = this.sessionStates.get(instanceId) || null;

      if (!state) {
        // Try loading from disk
        const stateFile = path.join(this.stateDir, `${instanceId}.json`);
        if (fs.existsSync(stateFile)) {
          const loaded = this.readPayload<SessionState>(stateFile);
          if (loaded) {
            state = loaded;
          }
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
  getTranscript(
    instanceId: string,
    format: 'json' | 'markdown' | 'text' = 'markdown'
  ): string {
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
  exportSession(
    instanceId: string
  ): { state: SessionState; snapshots: SessionSnapshot[] } | null {
    const state = this.sessionStates.get(instanceId);
    if (!state) return null;

    const snapshots = this.listSnapshots(instanceId);

    return {
      state: JSON.parse(JSON.stringify(state)),
      snapshots
    };
  }

  /**
   * Import a session from exported data
   */
  importSession(
    data: { state: SessionState; snapshots?: SessionSnapshot[] },
    newInstanceId?: string
  ): string {
    const instanceId = newInstanceId || data.state.instanceId;
    const state = { ...data.state, instanceId };

    this.sessionStates.set(instanceId, state);
    this.saveState(instanceId);

    // Import snapshots if provided
    if (data.snapshots) {
      for (const snapshot of data.snapshots) {
        const updatedSnapshot = { ...snapshot, sessionId: instanceId };
        const snapshotFile = path.join(this.snapshotDir, `${snapshot.id}.json`);
        this.writePayload(snapshotFile, updatedSnapshot);
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
   * Set up auto-save for a session
   */
  private setupAutoSave(instanceId: string): void {
    const timer = setInterval(() => {
      if (this.dirty.has(instanceId)) {
        this.saveState(instanceId);
        this.dirty.delete(instanceId);

        // Create auto-checkpoint every 10 saves
        const state = this.sessionStates.get(instanceId);
        if (state && state.conversationHistory.length % 50 === 0) {
          this.createSnapshot(instanceId, undefined, 'Auto-checkpoint', 'auto');
        }
      }
    }, this.config.autoSaveIntervalMs);

    this.autoSaveTimers.set(instanceId, timer);
  }

  /**
   * Save session state to disk
   */
  private saveState(instanceId: string): void {
    const state = this.sessionStates.get(instanceId);
    if (!state) return;

    try {
      const stateFile = path.join(this.stateDir, `${instanceId}.json`);
      this.writePayload(stateFile, state);
      this.emit('state:saved', { instanceId });
    } catch (error) {
      logger.error('Failed to save session state', error instanceof Error ? error : undefined, { instanceId });
      this.emit('state:save-error', { instanceId, error });
    }
  }

  /**
   * Load a specific snapshot
   */
  private loadSnapshot(snapshotId: string): SessionSnapshot | null {
    const snapshotFile = path.join(this.snapshotDir, `${snapshotId}.json`);

    if (!fs.existsSync(snapshotFile)) return null;

    return this.readPayload<SessionSnapshot>(snapshotFile);
  }

  private writePayload(filePath: string, data: unknown): void {
    const serialized = this.serializePayload(data);
    fs.writeFileSync(filePath, serialized);
  }

  private readPayload<T>(filePath: string): T | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return this.deserializePayload<T>(raw);
    } catch (error) {
      logger.error('Failed to read continuity payload', error instanceof Error ? error : undefined);
      return null;
    }
  }

  private serializePayload(data: unknown): string {
    const json = JSON.stringify(data, null, 2);
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
   * Cleanup old snapshots
   */
  private cleanupSnapshots(instanceId: string): void {
    const snapshots = this.listSnapshots(instanceId);
    const cutoffTime =
      Date.now() - this.config.snapshotRetentionDays * 24 * 60 * 60 * 1000;

    // Remove old snapshots
    for (const snapshot of snapshots) {
      if (snapshot.timestamp < cutoffTime) {
        const snapshotFile = path.join(this.snapshotDir, `${snapshot.id}.json`);
        if (fs.existsSync(snapshotFile)) {
          fs.unlinkSync(snapshotFile);
        }
      }
    }

    // Remove excess snapshots
    const remaining = this.listSnapshots(instanceId);
    if (remaining.length > this.config.maxSnapshots) {
      const toRemove = remaining.slice(this.config.maxSnapshots);
      for (const snapshot of toRemove) {
        const snapshotFile = path.join(this.snapshotDir, `${snapshot.id}.json`);
        if (fs.existsSync(snapshotFile)) {
          fs.unlinkSync(snapshotFile);
        }
      }
    }
  }

  /**
   * Get continuity statistics
   */
  getStats(): {
    activeSessions: number;
    totalSnapshots: number;
    diskUsageBytes: number;
    oldestSession: number | null;
    newestSession: number | null;
  } {
    let diskUsageBytes = 0;
    let oldestSession: number | null = null;
    let newestSession: number | null = null;

    // Calculate disk usage
    for (const dir of [this.stateDir, this.snapshotDir]) {
      try {
        const files = fs.readdirSync(dir);
        for (const file of files) {
          const stat = fs.statSync(path.join(dir, file));
          diskUsageBytes += stat.size;
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
      totalSnapshots: this.listSnapshots().length,
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

    // Update auto-save timers if interval changed
    if (
      config.autoSaveIntervalMs !== undefined ||
      config.autoSaveEnabled !== undefined
    ) {
      for (const [instanceId, timer] of this.autoSaveTimers) {
        clearInterval(timer);
        if (this.config.autoSaveEnabled) {
          this.setupAutoSave(instanceId);
        }
      }
    }
  }

  /**
   * Cleanup and shutdown
   */
  shutdown(): void {
    // Save all dirty states
    for (const instanceId of this.dirty) {
      this.saveState(instanceId);
    }

    // Clear all timers
    for (const timer of this.autoSaveTimers.values()) {
      clearInterval(timer);
    }
    this.autoSaveTimers.clear();
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
