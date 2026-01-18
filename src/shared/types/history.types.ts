/**
 * History Types - Types for conversation history persistence
 */

import type { OutputMessage } from './instance.types';

/**
 * Status when the conversation ended
 */
export type ConversationEndStatus = 'completed' | 'error' | 'terminated';

/**
 * A single entry in the conversation history
 */
export interface ConversationHistoryEntry {
  /** Unique identifier for this history entry */
  id: string;

  /** Display name of the instance when it was terminated */
  displayName: string;

  /** When the instance was created */
  createdAt: number;

  /** When the instance was terminated/ended */
  endedAt: number;

  /** Working directory the instance was running in */
  workingDirectory: string;

  /** Total number of messages in the conversation */
  messageCount: number;

  /** First user message (preview, truncated to 150 chars) */
  firstUserMessage: string;

  /** Last user message (preview, truncated to 150 chars) */
  lastUserMessage: string;

  /** How the conversation ended */
  status: ConversationEndStatus;

  /** Original instance ID (for reference) */
  originalInstanceId: string;

  /** Parent instance ID if it was a child instance */
  parentId: string | null;

  /** Session ID from the original instance */
  sessionId: string;
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

  /** Error message if failed */
  error?: string;
}
