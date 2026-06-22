import type { EventEmitter } from 'node:events';
import type { ConversationLedgerService } from '../conversation-ledger';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { InstanceManager } from '../instance/instance-manager';

export interface ChatServiceConfig {
  db?: SqliteDriver;
  ledger?: ConversationLedgerService;
  instanceManager: InstanceManager;
  eventBus?: EventEmitter;
}

export interface ChatSystemEventInput {
  chatId: string;
  nativeMessageId: string;
  nativeTurnId?: string;
  phase?: string;
  content: string;
  createdAt?: number;
  metadata?: Record<string, unknown>;
  /**
   * Ledger role for the appended event. Defaults to `'system'`. Use `'user'`
   * for synthesized events that represent the user's intent, or `'assistant'`
   * for agent-produced turns that should read back as prior assistant turns.
   */
  role?: 'user' | 'system' | 'assistant';
  /**
   * When `true`, run the same title heuristic that `sendMessage` runs on
   * first-message arrival. Intended for synthetic user-role events.
   */
  autoName?: boolean;
}
