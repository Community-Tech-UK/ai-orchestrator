/**
 * Session Archive - Archive and restore sessions (1.3)
 *
 * Manages archiving old sessions to reduce clutter while preserving history.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';

/**
 * Archived session metadata
 */
export interface ArchivedSessionMeta {
  id: string;
  displayName: string;
  createdAt: number;
  archivedAt: number;
  workingDirectory: string;
  agentId: string;
  messageCount: number;
  totalTokensUsed: number;
  lastActivity: number;
  tags?: string[];
}

/**
 * Full archived session data
 */
export interface ArchivedSession {
  meta: ArchivedSessionMeta;
  messages: OutputMessage[];
  contextUsage: {
    used: number;
    total: number;
    costEstimate?: number;
  };
}

/**
 * Archive filter options
 */
export interface ArchiveFilter {
  beforeDate?: number;
  afterDate?: number;
  tags?: string[];
  searchTerm?: string;
}

/**
 * Session Archive Manager
 */
export class SessionArchiveManager {
  private archiveDir: string;
  private metaIndex: Map<string, ArchivedSessionMeta> = new Map();
  private indexFile: string;

  constructor() {
    this.archiveDir = path.join(app.getPath('userData'), 'archived-sessions');
    this.indexFile = path.join(this.archiveDir, 'index.json');
    this.ensureArchiveDir();
    this.loadIndex();
  }

  /**
   * Ensure archive directory exists
   */
  private ensureArchiveDir(): void {
    if (!fs.existsSync(this.archiveDir)) {
      fs.mkdirSync(this.archiveDir, { recursive: true });
    }
  }

  /**
   * Load the metadata index
   */
  private loadIndex(): void {
    try {
      if (fs.existsSync(this.indexFile)) {
        const data = JSON.parse(fs.readFileSync(this.indexFile, 'utf-8'));
        this.metaIndex = new Map(Object.entries(data));
      }
    } catch (error) {
      console.error('Failed to load archive index:', error);
      this.metaIndex = new Map();
    }
  }

  /**
   * Save the metadata index
   */
  private saveIndex(): void {
    try {
      const data = Object.fromEntries(this.metaIndex);
      fs.writeFileSync(this.indexFile, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Failed to save archive index:', error);
    }
  }

  /**
   * Archive a session
   */
  archiveSession(instance: Instance, tags?: string[]): ArchivedSessionMeta {
    const meta: ArchivedSessionMeta = {
      id: instance.id,
      displayName: instance.displayName,
      createdAt: instance.createdAt,
      archivedAt: Date.now(),
      workingDirectory: instance.workingDirectory,
      agentId: instance.agentId,
      messageCount: instance.outputBuffer.length,
      totalTokensUsed: instance.totalTokensUsed,
      lastActivity: instance.lastActivity,
      tags,
    };

    const archived: ArchivedSession = {
      meta,
      messages: instance.outputBuffer,
      contextUsage: {
        used: instance.contextUsage.used,
        total: instance.contextUsage.total,
        costEstimate: instance.contextUsage.costEstimate,
      },
    };

    // Save to file
    const filePath = path.join(this.archiveDir, `${instance.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(archived, null, 2));

    // Update index
    this.metaIndex.set(instance.id, meta);
    this.saveIndex();

    return meta;
  }

  /**
   * Restore an archived session
   */
  restoreSession(sessionId: string): ArchivedSession | null {
    const filePath = path.join(this.archiveDir, `${sessionId}.json`);

    try {
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return data as ArchivedSession;
      }
    } catch (error) {
      console.error('Failed to restore archived session:', error);
    }

    return null;
  }

  /**
   * Delete an archived session
   */
  deleteArchivedSession(sessionId: string): boolean {
    const filePath = path.join(this.archiveDir, `${sessionId}.json`);

    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      this.metaIndex.delete(sessionId);
      this.saveIndex();
      return true;
    } catch (error) {
      console.error('Failed to delete archived session:', error);
      return false;
    }
  }

  /**
   * List all archived sessions
   */
  listArchivedSessions(filter?: ArchiveFilter): ArchivedSessionMeta[] {
    let sessions = Array.from(this.metaIndex.values());

    if (filter) {
      if (filter.beforeDate) {
        sessions = sessions.filter((s) => s.archivedAt <= filter.beforeDate!);
      }
      if (filter.afterDate) {
        sessions = sessions.filter((s) => s.archivedAt >= filter.afterDate!);
      }
      if (filter.tags && filter.tags.length > 0) {
        sessions = sessions.filter((s) =>
          s.tags?.some((t) => filter.tags!.includes(t))
        );
      }
      if (filter.searchTerm) {
        const term = filter.searchTerm.toLowerCase();
        sessions = sessions.filter((s) =>
          s.displayName.toLowerCase().includes(term) ||
          s.workingDirectory.toLowerCase().includes(term)
        );
      }
    }

    // Sort by archived date, newest first
    sessions.sort((a, b) => b.archivedAt - a.archivedAt);

    return sessions;
  }

  /**
   * Get archived session metadata
   */
  getArchivedSessionMeta(sessionId: string): ArchivedSessionMeta | undefined {
    return this.metaIndex.get(sessionId);
  }

  /**
   * Update tags for an archived session
   */
  updateTags(sessionId: string, tags: string[]): boolean {
    const meta = this.metaIndex.get(sessionId);
    if (!meta) return false;

    meta.tags = tags;
    this.metaIndex.set(sessionId, meta);
    this.saveIndex();

    // Also update the full file
    const archived = this.restoreSession(sessionId);
    if (archived) {
      archived.meta.tags = tags;
      const filePath = path.join(this.archiveDir, `${sessionId}.json`);
      fs.writeFileSync(filePath, JSON.stringify(archived, null, 2));
    }

    return true;
  }

  /**
   * Get archive statistics
   */
  getArchiveStats(): {
    totalSessions: number;
    totalMessages: number;
    totalTokens: number;
    oldestArchive: number | null;
    newestArchive: number | null;
    diskUsageBytes: number;
  } {
    const sessions = Array.from(this.metaIndex.values());

    let totalMessages = 0;
    let totalTokens = 0;
    let oldestArchive: number | null = null;
    let newestArchive: number | null = null;

    for (const session of sessions) {
      totalMessages += session.messageCount;
      totalTokens += session.totalTokensUsed;

      if (oldestArchive === null || session.archivedAt < oldestArchive) {
        oldestArchive = session.archivedAt;
      }
      if (newestArchive === null || session.archivedAt > newestArchive) {
        newestArchive = session.archivedAt;
      }
    }

    // Calculate disk usage
    let diskUsageBytes = 0;
    try {
      const files = fs.readdirSync(this.archiveDir);
      for (const file of files) {
        const stat = fs.statSync(path.join(this.archiveDir, file));
        diskUsageBytes += stat.size;
      }
    } catch (error) {
      console.error('Failed to calculate disk usage:', error);
    }

    return {
      totalSessions: sessions.length,
      totalMessages,
      totalTokens,
      oldestArchive,
      newestArchive,
      diskUsageBytes,
    };
  }

  /**
   * Auto-archive old sessions based on criteria
   */
  getSessionsToAutoArchive(
    activeSessions: Instance[],
    maxAgeDays: number = 30,
    maxIdleDays: number = 7
  ): Instance[] {
    const now = Date.now();
    const maxAgeMs = maxAgeDays * 24 * 60 * 60 * 1000;
    const maxIdleMs = maxIdleDays * 24 * 60 * 60 * 1000;

    return activeSessions.filter((session) => {
      // Don't archive active sessions
      if (session.status === 'busy' || session.status === 'waiting_for_input') {
        return false;
      }

      // Archive if too old
      if (now - session.createdAt > maxAgeMs) {
        return true;
      }

      // Archive if idle for too long
      if (now - session.lastActivity > maxIdleMs) {
        return true;
      }

      return false;
    });
  }

  /**
   * Cleanup old archives
   */
  cleanupOldArchives(maxAgeDays: number): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
    let deleted = 0;

    for (const [id, meta] of this.metaIndex.entries()) {
      if (meta.archivedAt < cutoff) {
        if (this.deleteArchivedSession(id)) {
          deleted++;
        }
      }
    }

    return deleted;
  }
}

// Singleton instance
let archiveManagerInstance: SessionArchiveManager | null = null;

export function getSessionArchiveManager(): SessionArchiveManager {
  if (!archiveManagerInstance) {
    archiveManagerInstance = new SessionArchiveManager();
  }
  return archiveManagerInstance;
}
