/**
 * History Manager - Manages conversation history persistence
 *
 * Archives terminated instances to disk for later restoration.
 * Uses electron-store for the metadata index and gzipped JSON for conversation data.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { promisify } from 'util';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type {
  ConversationHistoryEntry,
  ConversationData,
  HistoryIndex,
  HistoryLoadOptions,
  ConversationEndStatus,
} from '../../shared/types/history.types';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const HISTORY_INDEX_VERSION = 1;
const MAX_PREVIEW_LENGTH = 150;
const MAX_HISTORY_ENTRIES = 100; // Keep last 100 conversations

export class HistoryManager {
  private storageDir: string;
  private indexPath: string;
  private index: HistoryIndex;

  constructor() {
    this.storageDir = path.join(app.getPath('userData'), 'conversation-history');
    this.indexPath = path.join(this.storageDir, 'index.json');
    this.index = this.loadIndex();
  }

  /**
   * Archive an instance to history when it terminates
   */
  async archiveInstance(instance: Instance, status: ConversationEndStatus = 'completed'): Promise<void> {
    // Don't archive if no messages
    if (!instance.outputBuffer || instance.outputBuffer.length === 0) {
      console.log(`History: Skipping archive for ${instance.id} - no messages`);
      return;
    }

    // Find first and last user messages for preview
    const userMessages = instance.outputBuffer.filter(m => m.type === 'user');
    const firstUserMessage = userMessages[0]?.content || '';
    const lastUserMessage = userMessages[userMessages.length - 1]?.content || firstUserMessage;

    // Create history entry
    const entry: ConversationHistoryEntry = {
      id: crypto.randomUUID(),
      displayName: instance.displayName,
      createdAt: instance.createdAt,
      endedAt: Date.now(),
      workingDirectory: instance.workingDirectory,
      messageCount: instance.outputBuffer.length,
      firstUserMessage: this.truncatePreview(firstUserMessage),
      lastUserMessage: this.truncatePreview(lastUserMessage),
      status,
      originalInstanceId: instance.id,
      parentId: instance.parentId,
      sessionId: instance.sessionId,
    };

    // Create conversation data
    const conversationData: ConversationData = {
      entry,
      messages: instance.outputBuffer,
    };

    // Save conversation to disk
    await this.saveConversation(entry.id, conversationData);

    // Update index
    this.index.entries.unshift(entry);
    this.index.lastUpdated = Date.now();

    // Enforce max entries limit
    await this.enforceLimit();

    // Save index
    await this.saveIndex();

    console.log(`History: Archived instance ${instance.id} as ${entry.id} with ${entry.messageCount} messages`);
  }

  /**
   * Get all history entries (metadata only)
   */
  getEntries(options?: HistoryLoadOptions): ConversationHistoryEntry[] {
    let entries = [...this.index.entries];

    // Apply search filter
    if (options?.searchQuery) {
      const query = options.searchQuery.toLowerCase();
      entries = entries.filter(e =>
        e.displayName.toLowerCase().includes(query) ||
        e.firstUserMessage.toLowerCase().includes(query) ||
        e.lastUserMessage.toLowerCase().includes(query) ||
        e.workingDirectory.toLowerCase().includes(query)
      );
    }

    // Apply working directory filter
    if (options?.workingDirectory) {
      entries = entries.filter(e => e.workingDirectory === options.workingDirectory);
    }

    // Apply limit
    if (options?.limit && options.limit > 0) {
      entries = entries.slice(0, options.limit);
    }

    return entries;
  }

  /**
   * Load full conversation data for an entry
   */
  async loadConversation(entryId: string): Promise<ConversationData | null> {
    const conversationPath = this.getConversationPath(entryId);

    if (!fs.existsSync(conversationPath)) {
      console.error(`History: Conversation file not found for ${entryId}`);
      return null;
    }

    try {
      const compressed = await fs.promises.readFile(conversationPath);
      const data = await gunzip(compressed);
      return JSON.parse(data.toString()) as ConversationData;
    } catch (error) {
      console.error(`History: Failed to load conversation ${entryId}:`, error);
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

    // Remove from index
    this.index.entries.splice(index, 1);
    this.index.lastUpdated = Date.now();
    await this.saveIndex();

    // Delete conversation file
    const conversationPath = this.getConversationPath(entryId);
    try {
      await fs.promises.unlink(conversationPath);
    } catch (error) {
      // Ignore if file doesn't exist
    }

    console.log(`History: Deleted entry ${entryId}`);
    return true;
  }

  /**
   * Clear all history
   */
  async clearAll(): Promise<void> {
    // Delete all conversation files
    for (const entry of this.index.entries) {
      const conversationPath = this.getConversationPath(entry.id);
      try {
        await fs.promises.unlink(conversationPath);
      } catch (error) {
        // Ignore
      }
    }

    // Reset index
    this.index = {
      version: HISTORY_INDEX_VERSION,
      lastUpdated: Date.now(),
      entries: [],
    };
    await this.saveIndex();

    console.log('History: Cleared all entries');
  }

  /**
   * Get the number of history entries
   */
  getCount(): number {
    return this.index.entries.length;
  }

  // ============================================
  // Private Methods
  // ============================================

  private loadIndex(): HistoryIndex {
    this.ensureStorageDir();

    if (fs.existsSync(this.indexPath)) {
      try {
        const data = fs.readFileSync(this.indexPath, 'utf-8');
        const index = JSON.parse(data) as HistoryIndex;

        // Migrate if needed
        if (index.version !== HISTORY_INDEX_VERSION) {
          return this.migrateIndex(index);
        }

        return index;
      } catch (error) {
        console.error('History: Failed to load index, creating new one:', error);
      }
    }

    return {
      version: HISTORY_INDEX_VERSION,
      lastUpdated: Date.now(),
      entries: [],
    };
  }

  private migrateIndex(oldIndex: HistoryIndex): HistoryIndex {
    // For now, just update version - add migrations here as needed
    console.log(`History: Migrating index from v${oldIndex.version} to v${HISTORY_INDEX_VERSION}`);
    return {
      ...oldIndex,
      version: HISTORY_INDEX_VERSION,
    };
  }

  private async saveIndex(): Promise<void> {
    await fs.promises.writeFile(this.indexPath, JSON.stringify(this.index, null, 2));
  }

  private async saveConversation(entryId: string, data: ConversationData): Promise<void> {
    const conversationPath = this.getConversationPath(entryId);
    const jsonData = JSON.stringify(data);
    const compressed = await gzip(jsonData);
    await fs.promises.writeFile(conversationPath, compressed);
  }

  private getConversationPath(entryId: string): string {
    return path.join(this.storageDir, `${entryId}.json.gz`);
  }

  private ensureStorageDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
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
        } catch (error) {
          // Ignore
        }
      }
    }
  }

  /**
   * Get the storage directory path
   */
  getStoragePath(): string {
    return this.storageDir;
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
