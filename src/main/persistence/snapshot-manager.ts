/**
 * File Snapshot Manager - Track and revert file modifications
 *
 * Provides the ability to:
 * - Take snapshots before file modifications
 * - Store snapshots efficiently with content-based deduplication
 * - Revert individual files or entire sessions
 * - View file modification history
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { app } from 'electron';
import { getLogger } from '../logging/logger';

const logger = getLogger('SnapshotManager');

// ============================================
// Types
// ============================================

export interface FileSnapshot {
  id: string;
  filePath: string;
  contentHash: string;
  size: number;
  timestamp: number;
  instanceId: string;
  sessionId?: string;
  action: 'create' | 'modify' | 'delete';
  previousSnapshotId?: string;  // Link to previous version
}

export interface SnapshotSession {
  id: string;
  instanceId: string;
  startedAt: number;
  endedAt?: number;
  snapshots: string[];  // Snapshot IDs
  fileCount: number;
  description?: string;
}

export interface RevertResult {
  success: boolean;
  filesReverted: string[];
  filesSkipped: string[];
  errors: Array<{ file: string; error: string }>;
}

// ============================================
// Snapshot Manager Class
// ============================================

export class SnapshotManager {
  private dataDir: string;
  private snapshotsDir: string;
  private contentDir: string;
  private indexFile: string;

  private snapshots: Map<string, FileSnapshot> = new Map();
  private sessions: Map<string, SnapshotSession> = new Map();
  private contentHashes: Map<string, number> = new Map();  // hash -> refcount

  constructor() {
    this.dataDir = path.join(app.getPath('userData'), 'snapshots');
    this.snapshotsDir = path.join(this.dataDir, 'metadata');
    this.contentDir = path.join(this.dataDir, 'content');
    this.indexFile = path.join(this.dataDir, 'index.json');

    this.ensureDirectories();
    this.loadIndex();
  }

  /**
   * Ensure required directories exist
   */
  private ensureDirectories(): void {
    [this.dataDir, this.snapshotsDir, this.contentDir].forEach(dir => {
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    });
  }

  /**
   * Load snapshot index from disk
   */
  private loadIndex(): void {
    try {
      if (fs.existsSync(this.indexFile)) {
        const data = JSON.parse(fs.readFileSync(this.indexFile, 'utf-8'));

        // Load snapshots
        if (data.snapshots) {
          for (const snapshot of data.snapshots) {
            this.snapshots.set(snapshot.id, snapshot);
          }
        }

        // Load sessions
        if (data.sessions) {
          for (const session of data.sessions) {
            this.sessions.set(session.id, session);
          }
        }

        // Rebuild content hash refcounts
        for (const snapshot of this.snapshots.values()) {
          const count = this.contentHashes.get(snapshot.contentHash) || 0;
          this.contentHashes.set(snapshot.contentHash, count + 1);
        }
      }
    } catch (error) {
      logger.error('Failed to load snapshot index', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Save snapshot index to disk
   */
  private saveIndex(): void {
    try {
      const data = {
        snapshots: Array.from(this.snapshots.values()),
        sessions: Array.from(this.sessions.values()),
        lastUpdated: Date.now(),
      };
      fs.writeFileSync(this.indexFile, JSON.stringify(data, null, 2));
    } catch (error) {
      logger.error('Failed to save snapshot index', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Calculate content hash for deduplication
   */
  private calculateHash(content: string | Buffer): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Get content file path from hash
   */
  private getContentPath(hash: string): string {
    // Use first 2 chars as subdirectory for better filesystem performance
    const subdir = hash.substring(0, 2);
    return path.join(this.contentDir, subdir, hash);
  }

  /**
   * Store content with deduplication
   */
  private storeContent(content: string | Buffer, hash: string): void {
    const contentPath = this.getContentPath(hash);
    const dir = path.dirname(contentPath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    if (!fs.existsSync(contentPath)) {
      fs.writeFileSync(contentPath, content);
    }

    // Increment refcount
    const count = this.contentHashes.get(hash) || 0;
    this.contentHashes.set(hash, count + 1);
  }

  /**
   * Retrieve content by hash
   */
  private retrieveContent(hash: string): string | null {
    const contentPath = this.getContentPath(hash);
    if (fs.existsSync(contentPath)) {
      return fs.readFileSync(contentPath, 'utf-8');
    }
    return null;
  }

  /**
   * Delete content if no longer referenced
   */
  private deleteContentIfUnused(hash: string): void {
    const count = this.contentHashes.get(hash) || 0;
    if (count <= 1) {
      this.contentHashes.delete(hash);
      const contentPath = this.getContentPath(hash);
      if (fs.existsSync(contentPath)) {
        fs.unlinkSync(contentPath);
      }
    } else {
      this.contentHashes.set(hash, count - 1);
    }
  }

  // ============================================
  // Public API
  // ============================================

  /**
   * Take a snapshot of a file before modification
   * Returns the snapshot ID
   */
  takeSnapshot(
    filePath: string,
    instanceId: string,
    sessionId?: string,
    action: 'create' | 'modify' | 'delete' = 'modify'
  ): string | null {
    try {
      const absolutePath = path.resolve(filePath);
      let content = '';
      let size = 0;

      // For create/modify, the snapshot stores the PREVIOUS state
      // For delete, it stores the content that will be deleted
      if (action === 'create') {
        // File doesn't exist yet, store empty marker
        content = '';
        size = 0;
      } else if (fs.existsSync(absolutePath)) {
        content = fs.readFileSync(absolutePath, 'utf-8');
        size = Buffer.byteLength(content, 'utf-8');
      } else if (action === 'delete') {
        // File doesn't exist, nothing to snapshot
        return null;
      } else {
        // modify on non-existent file - treat as create
        content = '';
        size = 0;
        action = 'create';
      }

      const contentHash = this.calculateHash(content);
      const id = `snap_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Find previous snapshot for this file
      let previousSnapshotId: string | undefined;
      for (const snap of this.snapshots.values()) {
        if (snap.filePath === absolutePath && snap.instanceId === instanceId) {
          if (!previousSnapshotId || snap.timestamp > this.snapshots.get(previousSnapshotId)!.timestamp) {
            previousSnapshotId = snap.id;
          }
        }
      }

      const snapshot: FileSnapshot = {
        id,
        filePath: absolutePath,
        contentHash,
        size,
        timestamp: Date.now(),
        instanceId,
        sessionId,
        action,
        previousSnapshotId,
      };

      // Store content
      this.storeContent(content, contentHash);

      // Store snapshot metadata
      this.snapshots.set(id, snapshot);
      this.saveIndex();

      // Add to session if exists
      if (sessionId) {
        const session = this.sessions.get(sessionId);
        if (session) {
          session.snapshots.push(id);
          session.fileCount = new Set(
            session.snapshots.map(sid => this.snapshots.get(sid)?.filePath).filter(Boolean)
          ).size;
        }
      }

      return id;
    } catch (error) {
      logger.error('Failed to take snapshot', error instanceof Error ? error : undefined);
      return null;
    }
  }

  /**
   * Start a new snapshot session
   */
  startSession(instanceId: string, description?: string): string {
    const id = `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const session: SnapshotSession = {
      id,
      instanceId,
      startedAt: Date.now(),
      snapshots: [],
      fileCount: 0,
      description,
    };

    this.sessions.set(id, session);
    this.saveIndex();

    return id;
  }

  /**
   * End a snapshot session
   */
  endSession(sessionId: string): SnapshotSession | null {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.endedAt = Date.now();
      this.saveIndex();
    }
    return session || null;
  }

  /**
   * Get all snapshots for an instance
   */
  getSnapshotsForInstance(instanceId: string): FileSnapshot[] {
    const snapshots: FileSnapshot[] = [];
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.instanceId === instanceId) {
        snapshots.push(snapshot);
      }
    }
    return snapshots.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Get all snapshots for a file
   */
  getSnapshotsForFile(filePath: string): FileSnapshot[] {
    const absolutePath = path.resolve(filePath);
    const snapshots: FileSnapshot[] = [];
    for (const snapshot of this.snapshots.values()) {
      if (snapshot.filePath === absolutePath) {
        snapshots.push(snapshot);
      }
    }
    return snapshots.sort((a, b) => b.timestamp - a.timestamp);
  }

  /**
   * Get all sessions for an instance
   */
  getSessionsForInstance(instanceId: string): SnapshotSession[] {
    const sessions: SnapshotSession[] = [];
    for (const session of this.sessions.values()) {
      if (session.instanceId === instanceId) {
        sessions.push(session);
      }
    }
    return sessions.sort((a, b) => b.startedAt - a.startedAt);
  }

  /**
   * Get content from a snapshot
   */
  getSnapshotContent(snapshotId: string): string | null {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) return null;
    return this.retrieveContent(snapshot.contentHash);
  }

  /**
   * Revert a single file to a specific snapshot
   */
  revertFile(snapshotId: string): RevertResult {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) {
      return {
        success: false,
        filesReverted: [],
        filesSkipped: [],
        errors: [{ file: 'unknown', error: 'Snapshot not found' }],
      };
    }

    try {
      const content = this.retrieveContent(snapshot.contentHash);
      if (content === null) {
        return {
          success: false,
          filesReverted: [],
          filesSkipped: [snapshot.filePath],
          errors: [{ file: snapshot.filePath, error: 'Content not found' }],
        };
      }

      // Handle different actions
      if (snapshot.action === 'create') {
        // Reverting a create means deleting the file
        if (fs.existsSync(snapshot.filePath)) {
          fs.unlinkSync(snapshot.filePath);
        }
      } else if (content === '') {
        // Empty content means file didn't exist
        if (fs.existsSync(snapshot.filePath)) {
          fs.unlinkSync(snapshot.filePath);
        }
      } else {
        // Restore content
        const dir = path.dirname(snapshot.filePath);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(snapshot.filePath, content, 'utf-8');
      }

      return {
        success: true,
        filesReverted: [snapshot.filePath],
        filesSkipped: [],
        errors: [],
      };
    } catch (error) {
      return {
        success: false,
        filesReverted: [],
        filesSkipped: [],
        errors: [{ file: snapshot.filePath, error: (error as Error).message }],
      };
    }
  }

  /**
   * Revert all files in a session to their state before the session started
   */
  revertSession(sessionId: string): RevertResult {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return {
        success: false,
        filesReverted: [],
        filesSkipped: [],
        errors: [{ file: 'session', error: 'Session not found' }],
      };
    }

    const result: RevertResult = {
      success: true,
      filesReverted: [],
      filesSkipped: [],
      errors: [],
    };

    // Get first snapshot for each file (the original state)
    const fileFirstSnapshots = new Map<string, FileSnapshot>();

    for (const snapshotId of session.snapshots) {
      const snapshot = this.snapshots.get(snapshotId);
      if (!snapshot) continue;

      if (!fileFirstSnapshots.has(snapshot.filePath)) {
        fileFirstSnapshots.set(snapshot.filePath, snapshot);
      } else {
        const existing = fileFirstSnapshots.get(snapshot.filePath)!;
        if (snapshot.timestamp < existing.timestamp) {
          fileFirstSnapshots.set(snapshot.filePath, snapshot);
        }
      }
    }

    // Revert each file
    for (const snapshot of fileFirstSnapshots.values()) {
      const fileResult = this.revertFile(snapshot.id);
      result.filesReverted.push(...fileResult.filesReverted);
      result.filesSkipped.push(...fileResult.filesSkipped);
      result.errors.push(...fileResult.errors);
    }

    result.success = result.errors.length === 0;
    return result;
  }

  /**
   * Get diff between snapshot and current file
   */
  getSnapshotDiff(snapshotId: string): { snapshot: string; current: string } | null {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) return null;

    const snapshotContent = this.retrieveContent(snapshot.contentHash) || '';
    let currentContent = '';

    if (fs.existsSync(snapshot.filePath)) {
      currentContent = fs.readFileSync(snapshot.filePath, 'utf-8');
    }

    return {
      snapshot: snapshotContent,
      current: currentContent,
    };
  }

  /**
   * Delete a snapshot (and content if unused)
   */
  deleteSnapshot(snapshotId: string): boolean {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) return false;

    // Remove from any sessions
    for (const session of this.sessions.values()) {
      const idx = session.snapshots.indexOf(snapshotId);
      if (idx !== -1) {
        session.snapshots.splice(idx, 1);
      }
    }

    // Delete content if no longer needed
    this.deleteContentIfUnused(snapshot.contentHash);

    // Remove snapshot
    this.snapshots.delete(snapshotId);
    this.saveIndex();

    return true;
  }

  /**
   * Delete all snapshots for an instance
   */
  deleteSnapshotsForInstance(instanceId: string): number {
    let deleted = 0;
    const toDelete: string[] = [];

    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.instanceId === instanceId) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      if (this.deleteSnapshot(id)) {
        deleted++;
      }
    }

    // Also delete sessions
    for (const [id, session] of this.sessions) {
      if (session.instanceId === instanceId) {
        this.sessions.delete(id);
      }
    }

    this.saveIndex();
    return deleted;
  }

  /**
   * Clean up old snapshots (older than specified days)
   */
  cleanupOldSnapshots(maxAgeDays: number = 30): number {
    const cutoff = Date.now() - (maxAgeDays * 24 * 60 * 60 * 1000);
    let deleted = 0;
    const toDelete: string[] = [];

    for (const [id, snapshot] of this.snapshots) {
      if (snapshot.timestamp < cutoff) {
        toDelete.push(id);
      }
    }

    for (const id of toDelete) {
      if (this.deleteSnapshot(id)) {
        deleted++;
      }
    }

    // Also clean up old sessions
    for (const [id, session] of this.sessions) {
      if (session.startedAt < cutoff) {
        this.sessions.delete(id);
      }
    }

    this.saveIndex();
    return deleted;
  }

  /**
   * Get storage statistics
   */
  getStats(): {
    snapshotCount: number;
    sessionCount: number;
    uniqueContentCount: number;
    totalSize: number;
  } {
    let totalSize = 0;
    const uniqueHashes = new Set<string>();

    for (const snapshot of this.snapshots.values()) {
      uniqueHashes.add(snapshot.contentHash);
      totalSize += snapshot.size;
    }

    return {
      snapshotCount: this.snapshots.size,
      sessionCount: this.sessions.size,
      uniqueContentCount: uniqueHashes.size,
      totalSize,
    };
  }
}

// ============================================
// Singleton Instance
// ============================================

let snapshotManager: SnapshotManager | null = null;

export function getSnapshotManager(): SnapshotManager {
  if (!snapshotManager) {
    snapshotManager = new SnapshotManager();
  }
  return snapshotManager;
}
