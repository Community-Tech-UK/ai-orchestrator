# Discord Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable users to control the Orchestrator from Discord by sending messages to a bot that spawns instances, runs tasks, and streams results back.

**Architecture:** A `ChannelManager` singleton manages platform adapters via a `BaseChannelAdapter` abstract class. A `ChannelMessageRouter` handles access control, rate limiting, intent parsing, and routing to instances. Discord is the first adapter (v1); WhatsApp types exist but no adapter ships. The full stack: shared types → Zod schemas → SQLite migration → main process services → IPC handlers → preload bridge → Angular IPC service → store → UI components.

**Tech Stack:** TypeScript, discord.js ^14.x, Electron IPC, Angular 21 signals, better-sqlite3, Zod 4, Vitest

**Spec:** `docs/superpowers/specs/2026-03-21-discord-whatsapp-channels-design.md`

---

## File Map

### New Files

| File | Responsibility |
|------|---------------|
| `src/shared/types/channels.ts` | Shared type definitions (ChannelPlatform, InboundChannelMessage, etc.) |
| `src/shared/validation/channel-schemas.ts` | Zod schemas for IPC payload validation |
| `src/main/channels/index.ts` | Barrel exports + `getChannelManager()` convenience getter |
| `src/main/channels/channel-adapter.ts` | `BaseChannelAdapter` abstract class + `ChannelAdapterEvents` |
| `src/main/channels/channel-manager.ts` | `ChannelManager` singleton — adapter registry + lifecycle |
| `src/main/channels/channel-message-router.ts` | Access gate → rate limit → parse → route → execute → stream results |
| `src/main/channels/channel-persistence.ts` | SQLite queries for `channel_messages` table |
| `src/main/channels/rate-limiter.ts` | Sliding window rate limiter utility |
| `src/main/channels/adapters/discord-adapter.ts` | Discord.js integration — connect, receive, send, chunk, threads |
| `src/main/ipc/handlers/channel-handlers.ts` | IPC handler registration for channel operations |
| `src/renderer/app/core/services/ipc/channel-ipc.service.ts` | Angular IPC bridge service |
| `src/renderer/app/core/state/channel.store.ts` | Signal-based state management |
| `src/renderer/app/features/channels/channels-page.component.ts` | Main channels page with connections, messages, settings |

### Modified Files

| File | Change |
|------|--------|
| `src/shared/types/ipc.types.ts` | Add `CHANNEL_*` IPC channel constants |
| `src/main/persistence/rlm/rlm-schema.ts` | Add `006_add_channel_messages` migration |
| `src/main/ipc/handlers/index.ts` | Export `registerChannelHandlers` |
| `src/main/index.ts` | Init `getChannelManager()` at startup, `shutdown()` on cleanup |
| `src/preload/preload.ts` | Add channel IPC methods to `electronAPI` |
| `src/renderer/app/app.routes.ts` | Add `/channels` route |

### Test Files

| File | Tests |
|------|-------|
| `src/main/channels/__tests__/rate-limiter.spec.ts` | Sliding window, per-sender isolation, reset |
| `src/main/channels/__tests__/channel-persistence.spec.ts` | Insert, query, thread resolution, cleanup |
| `src/main/channels/__tests__/channel-manager.spec.ts` | Register/unregister adapters, status tracking, shutdown |
| `src/main/channels/__tests__/channel-message-router.spec.ts` | Access gate, rate limiting, intent parsing, routing |
| `src/main/channels/__tests__/discord-adapter.spec.ts` | Connection lifecycle, message handling, chunking, pairing |

---

## Task 1: Shared Types

**Files:**
- Create: `src/shared/types/channels.ts`

- [ ] **Step 1: Create shared channel types**

```typescript
// src/shared/types/channels.ts

export type ChannelPlatform = 'discord' | 'whatsapp';
export type ChannelConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ChannelConfig {
  platform: ChannelPlatform;
  token?: string;
  allowedSenders: string[];
  allowedChats: string[];
}

export interface InboundChannelMessage {
  id: string;
  platform: ChannelPlatform;
  chatId: string;
  messageId: string;
  threadId?: string;
  senderId: string;
  senderName: string;
  content: string;
  attachments: ChannelAttachment[];
  isGroup: boolean;
  isDM: boolean;
  replyTo?: string;
  timestamp: number;
}

export interface ChannelResponse {
  channelMessageId: string;
  instanceId: string;
  content: string;
  files?: string[];
  status: 'streaming' | 'complete' | 'error';
}

export interface ChannelSendOptions {
  replyTo?: string;
  splitAt?: number;
}

export interface ChannelSentMessage {
  messageId: string;
  chatId: string;
  timestamp: number;
}

export interface PairedSender {
  senderId: string;
  senderName: string;
  platform: ChannelPlatform;
  pairedAt: number;
}

export interface AccessPolicy {
  mode: 'pairing' | 'allowlist' | 'disabled';
  allowedSenders: string[];
  pendingPairings: PendingPairing[];
  maxPending: number;
  codeExpiryMs: number;
}

export interface PendingPairing {
  code: string;
  senderId: string;
  senderName: string;
  expiresAt: number;
}

export interface ChannelAttachment {
  name: string;
  type: string;
  size: number;
  url?: string;
  localPath?: string;
}

export interface ChannelStatusEvent {
  platform: ChannelPlatform;
  status: ChannelConnectionStatus;
  botUsername?: string;
  phoneNumber?: string;
}

export interface ChannelErrorEvent {
  platform: ChannelPlatform;
  error: string;
  recoverable: boolean;
}

export interface StoredChannelMessage {
  id: string;
  platform: ChannelPlatform;
  chatId: string;
  messageId: string;
  threadId?: string;
  senderId: string;
  senderName: string;
  content: string;
  direction: 'inbound' | 'outbound';
  instanceId?: string;
  replyToMessageId?: string;
  timestamp: number;
  createdAt: number;
}

/** Error codes for channel IPC responses */
export type ChannelErrorCode =
  | 'CHANNEL_CONNECT_FAILED'
  | 'CHANNEL_NOT_CONNECTED'
  | 'CHANNEL_ADAPTER_UNAVAILABLE'
  | 'CHANNEL_SEND_FAILED'
  | 'CHANNEL_PAIR_INVALID'
  | 'CHANNEL_PAIR_EXPIRED'
  | 'CHANNEL_UNAUTHORIZED'
  | 'CHANNEL_RATE_LIMITED';
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: PASS (no errors from new file — it's self-contained types)

- [ ] **Step 3: Commit**

```bash
git add src/shared/types/channels.ts
git commit -m "feat(channels): add shared type definitions for channel system"
```

---

## Task 2: Zod Validation Schemas

**Files:**
- Create: `src/shared/validation/channel-schemas.ts`

- [ ] **Step 1: Create channel Zod schemas**

```typescript
// src/shared/validation/channel-schemas.ts

import { z } from 'zod';

const ChannelPlatformSchema = z.enum(['discord', 'whatsapp']);

export const ChannelConnectPayloadSchema = z.object({
  platform: ChannelPlatformSchema,
  token: z.string().min(1).max(500).optional(),
});

export const ChannelDisconnectPayloadSchema = z.object({
  platform: ChannelPlatformSchema,
});

export const ChannelGetStatusPayloadSchema = z.object({
  platform: ChannelPlatformSchema.optional(),
}).optional();

export const ChannelGetMessagesPayloadSchema = z.object({
  platform: ChannelPlatformSchema,
  chatId: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(100).optional().default(50),
  before: z.number().int().optional(),
});

export const ChannelSendMessagePayloadSchema = z.object({
  platform: ChannelPlatformSchema,
  chatId: z.string().min(1).max(200),
  content: z.string().min(1).max(65536),
  replyTo: z.string().max(200).optional(),
});

export const ChannelPairSenderPayloadSchema = z.object({
  platform: ChannelPlatformSchema,
  code: z.string().length(6).regex(/^[0-9a-f]+$/),
});

export const ChannelGetAccessPolicyPayloadSchema = z.object({
  platform: ChannelPlatformSchema,
});

export const ChannelSetAccessPolicyPayloadSchema = z.object({
  platform: ChannelPlatformSchema,
  mode: z.enum(['pairing', 'allowlist', 'disabled']),
});

export type ValidatedChannelConnectPayload = z.infer<typeof ChannelConnectPayloadSchema>;
export type ValidatedChannelDisconnectPayload = z.infer<typeof ChannelDisconnectPayloadSchema>;
export type ValidatedChannelGetMessagesPayload = z.infer<typeof ChannelGetMessagesPayloadSchema>;
export type ValidatedChannelSendMessagePayload = z.infer<typeof ChannelSendMessagePayloadSchema>;
export type ValidatedChannelPairSenderPayload = z.infer<typeof ChannelPairSenderPayloadSchema>;
export type ValidatedChannelSetAccessPolicyPayload = z.infer<typeof ChannelSetAccessPolicyPayloadSchema>;
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/shared/validation/channel-schemas.ts
git commit -m "feat(channels): add Zod validation schemas for channel IPC payloads"
```

---

## Task 3: IPC Channel Constants

**Files:**
- Modify: `src/shared/types/ipc.types.ts`

- [ ] **Step 1: Add channel IPC constants**

Add before the closing `} as const;` in `IPC_CHANNELS` (after the Token Stats block around line 816):

```typescript
  // Channel Management
  CHANNEL_CONNECT: 'channel:connect',
  CHANNEL_DISCONNECT: 'channel:disconnect',
  CHANNEL_GET_STATUS: 'channel:get-status',
  CHANNEL_GET_MESSAGES: 'channel:get-messages',
  CHANNEL_SEND_MESSAGE: 'channel:send-message',
  CHANNEL_PAIR_SENDER: 'channel:pair-sender',
  CHANNEL_GET_ACCESS_POLICY: 'channel:get-access-policy',
  CHANNEL_SET_ACCESS_POLICY: 'channel:set-access-policy',

  // Channel push events (main -> renderer)
  CHANNEL_STATUS_CHANGED: 'channel:status-changed',
  CHANNEL_MESSAGE_RECEIVED: 'channel:message-received',
  CHANNEL_RESPONSE_SENT: 'channel:response-sent',
  CHANNEL_ERROR: 'channel:error',
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/shared/types/ipc.types.ts
git commit -m "feat(channels): add IPC channel constants for channel management"
```

---

## Task 4: SQLite Migration

**Files:**
- Modify: `src/main/persistence/rlm/rlm-schema.ts`

- [ ] **Step 1: Add migration entry**

Add to the `MIGRATIONS` array after the `005_add_token_stats_table` entry:

```typescript
  {
    name: '006_add_channel_messages',
    up: `
      CREATE TABLE IF NOT EXISTS channel_messages (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        thread_id TEXT,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        content TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        instance_id TEXT,
        reply_to_message_id TEXT,
        timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_channel_messages_chat
        ON channel_messages(platform, chat_id);
      CREATE INDEX IF NOT EXISTS idx_channel_messages_instance
        ON channel_messages(instance_id);
      CREATE INDEX IF NOT EXISTS idx_channel_messages_thread
        ON channel_messages(thread_id);
      CREATE INDEX IF NOT EXISTS idx_channel_messages_timestamp
        ON channel_messages(platform, chat_id, timestamp);
    `,
    down: `
      DROP TABLE IF EXISTS channel_messages;
    `
  },
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/persistence/rlm/rlm-schema.ts
git commit -m "feat(channels): add SQLite migration for channel_messages table"
```

---

## Task 5: Rate Limiter

**Files:**
- Create: `src/main/channels/rate-limiter.ts`
- Create: `src/main/channels/__tests__/rate-limiter.spec.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/main/channels/__tests__/rate-limiter.spec.ts

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { RateLimiter } from '../rate-limiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    vi.useFakeTimers();
    limiter = new RateLimiter({ maxRequests: 3, windowMs: 60_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should allow requests under the limit', () => {
    expect(limiter.tryAcquire('user-1')).toBe(true);
    expect(limiter.tryAcquire('user-1')).toBe(true);
    expect(limiter.tryAcquire('user-1')).toBe(true);
  });

  it('should reject requests over the limit', () => {
    limiter.tryAcquire('user-1');
    limiter.tryAcquire('user-1');
    limiter.tryAcquire('user-1');
    expect(limiter.tryAcquire('user-1')).toBe(false);
  });

  it('should isolate per sender', () => {
    limiter.tryAcquire('user-1');
    limiter.tryAcquire('user-1');
    limiter.tryAcquire('user-1');
    expect(limiter.tryAcquire('user-2')).toBe(true);
  });

  it('should allow requests after window expires', () => {
    limiter.tryAcquire('user-1');
    limiter.tryAcquire('user-1');
    limiter.tryAcquire('user-1');
    expect(limiter.tryAcquire('user-1')).toBe(false);

    vi.advanceTimersByTime(60_001);
    expect(limiter.tryAcquire('user-1')).toBe(true);
  });

  it('should return remaining time until next available slot', () => {
    limiter.tryAcquire('user-1');
    limiter.tryAcquire('user-1');
    limiter.tryAcquire('user-1');
    const remaining = limiter.getRetryAfterMs('user-1');
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(60_000);
  });

  it('should reset a specific sender', () => {
    limiter.tryAcquire('user-1');
    limiter.tryAcquire('user-1');
    limiter.tryAcquire('user-1');
    limiter.reset('user-1');
    expect(limiter.tryAcquire('user-1')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/channels/__tests__/rate-limiter.spec.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement rate limiter**

```typescript
// src/main/channels/rate-limiter.ts

export interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
}

export class RateLimiter {
  private windows = new Map<string, number[]>();
  private config: RateLimiterConfig;

  constructor(config: RateLimiterConfig) {
    this.config = config;
  }

  tryAcquire(senderId: string): boolean {
    const now = Date.now();
    const timestamps = this.getWindow(senderId);
    const windowStart = now - this.config.windowMs;

    // Remove expired entries
    const valid = timestamps.filter(t => t > windowStart);
    this.windows.set(senderId, valid);

    if (valid.length >= this.config.maxRequests) {
      return false;
    }

    valid.push(now);
    return true;
  }

  getRetryAfterMs(senderId: string): number {
    const timestamps = this.getWindow(senderId);
    if (timestamps.length === 0) return 0;

    const oldest = timestamps[0];
    const expiresAt = oldest + this.config.windowMs;
    return Math.max(0, expiresAt - Date.now());
  }

  reset(senderId: string): void {
    this.windows.delete(senderId);
  }

  private getWindow(senderId: string): number[] {
    if (!this.windows.has(senderId)) {
      this.windows.set(senderId, []);
    }
    return this.windows.get(senderId)!;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/channels/__tests__/rate-limiter.spec.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/channels/rate-limiter.ts src/main/channels/__tests__/rate-limiter.spec.ts
git commit -m "feat(channels): add sliding window rate limiter"
```

---

## Task 6: Channel Persistence

**Files:**
- Create: `src/main/channels/channel-persistence.ts`
- Create: `src/main/channels/__tests__/channel-persistence.spec.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/main/channels/__tests__/channel-persistence.spec.ts

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ChannelPersistence } from '../channel-persistence';
import type { InboundChannelMessage } from '../../../shared/types/channels';

describe('ChannelPersistence', () => {
  let db: Database.Database;
  let persistence: ChannelPersistence;

  beforeEach(() => {
    db = new Database(':memory:');
    // Create the table directly for unit testing
    db.exec(`
      CREATE TABLE channel_messages (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        thread_id TEXT,
        sender_id TEXT NOT NULL,
        sender_name TEXT NOT NULL,
        content TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
        instance_id TEXT,
        reply_to_message_id TEXT,
        timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
      );
      CREATE INDEX idx_channel_messages_thread ON channel_messages(thread_id);
    `);
    persistence = new ChannelPersistence(db);
  });

  afterEach(() => {
    db.close();
  });

  const makeMessage = (overrides?: Partial<InboundChannelMessage>): InboundChannelMessage => ({
    id: 'msg-1',
    platform: 'discord',
    chatId: 'chat-123',
    messageId: 'discord-msg-1',
    senderId: 'user-1',
    senderName: 'TestUser',
    content: 'Hello world',
    attachments: [],
    isGroup: false,
    isDM: true,
    timestamp: Date.now(),
    ...overrides,
  });

  it('should insert and retrieve messages', () => {
    const msg = makeMessage();
    persistence.insertMessage(msg, 'inbound');
    const results = persistence.getMessages('discord', 'chat-123');
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Hello world');
    expect(results[0].direction).toBe('inbound');
  });

  it('should resolve instance for thread', () => {
    const msg = makeMessage({ threadId: 'thread-1' });
    persistence.insertMessage(msg, 'inbound', 'instance-5');
    const instanceId = persistence.getInstanceForThread('thread-1');
    expect(instanceId).toBe('instance-5');
  });

  it('should return undefined for unknown thread', () => {
    expect(persistence.getInstanceForThread('nonexistent')).toBeUndefined();
  });

  it('should paginate with before cursor', () => {
    persistence.insertMessage(makeMessage({ id: 'msg-1', timestamp: 1000, messageId: 'm1' }), 'inbound');
    persistence.insertMessage(makeMessage({ id: 'msg-2', timestamp: 2000, messageId: 'm2' }), 'inbound');
    persistence.insertMessage(makeMessage({ id: 'msg-3', timestamp: 3000, messageId: 'm3' }), 'inbound');

    const results = persistence.getMessages('discord', 'chat-123', { before: 3000, limit: 10 });
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe('msg-1');
  });

  it('should delete messages older than timestamp', () => {
    persistence.insertMessage(makeMessage({ id: 'old', timestamp: 1000, messageId: 'm1' }), 'inbound');
    persistence.insertMessage(makeMessage({ id: 'new', timestamp: 5000, messageId: 'm2' }), 'inbound');
    const deleted = persistence.deleteOlderThan(3000);
    expect(deleted).toBe(1);
    const remaining = persistence.getMessages('discord', 'chat-123');
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('new');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/channels/__tests__/channel-persistence.spec.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement channel persistence**

```typescript
// src/main/channels/channel-persistence.ts

import type Database from 'better-sqlite3';
import type { ChannelPlatform, InboundChannelMessage, StoredChannelMessage } from '../../shared/types/channels';

export class ChannelPersistence {
  private db: Database.Database;

  // Column alias mapping: snake_case SQL → camelCase TypeScript
  private static readonly SELECT_COLS = `
    id, platform,
    chat_id AS chatId,
    message_id AS messageId,
    thread_id AS threadId,
    sender_id AS senderId,
    sender_name AS senderName,
    content, direction,
    instance_id AS instanceId,
    reply_to_message_id AS replyToMessageId,
    timestamp,
    created_at AS createdAt
  `;

  constructor(db: Database.Database) {
    this.db = db;
  }

  insertMessage(msg: InboundChannelMessage, direction: 'inbound' | 'outbound', instanceId?: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO channel_messages (id, platform, chat_id, message_id, thread_id, sender_id, sender_name, content, direction, instance_id, reply_to_message_id, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      msg.id, msg.platform, msg.chatId, msg.messageId, msg.threadId ?? null,
      msg.senderId, msg.senderName, msg.content, direction,
      instanceId ?? null, msg.replyTo ?? null, msg.timestamp
    );
  }

  getMessages(
    platform: ChannelPlatform,
    chatId: string,
    opts?: { limit?: number; before?: number }
  ): StoredChannelMessage[] {
    const limit = opts?.limit ?? 50;
    if (opts?.before != null) {
      const stmt = this.db.prepare(`
        SELECT ${ChannelPersistence.SELECT_COLS} FROM channel_messages
        WHERE platform = ? AND chat_id = ? AND timestamp < ?
        ORDER BY timestamp ASC LIMIT ?
      `);
      return stmt.all(platform, chatId, opts.before, limit) as StoredChannelMessage[];
    }
    const stmt = this.db.prepare(`
      SELECT ${ChannelPersistence.SELECT_COLS} FROM channel_messages
      WHERE platform = ? AND chat_id = ?
      ORDER BY timestamp ASC LIMIT ?
    `);
    return stmt.all(platform, chatId, limit) as StoredChannelMessage[];
  }

  getInstanceForThread(threadId: string): string | undefined {
    const stmt = this.db.prepare(`
      SELECT instance_id AS instanceId FROM channel_messages
      WHERE thread_id = ? AND instance_id IS NOT NULL
      ORDER BY timestamp DESC LIMIT 1
    `);
    const row = stmt.get(threadId) as { instanceId: string } | undefined;
    return row?.instanceId;
  }

  getMessagesByInstance(instanceId: string): StoredChannelMessage[] {
    const stmt = this.db.prepare(`
      SELECT ${ChannelPersistence.SELECT_COLS} FROM channel_messages
      WHERE instance_id = ? ORDER BY timestamp ASC
    `);
    return stmt.all(instanceId) as StoredChannelMessage[];
  }

  deleteOlderThan(timestampMs: number): number {
    const stmt = this.db.prepare(`DELETE FROM channel_messages WHERE timestamp < ?`);
    return stmt.run(timestampMs).changes;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/channels/__tests__/channel-persistence.spec.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/channels/channel-persistence.ts src/main/channels/__tests__/channel-persistence.spec.ts
git commit -m "feat(channels): add channel message persistence layer"
```

---

## Task 7: BaseChannelAdapter Abstract Class

**Files:**
- Create: `src/main/channels/channel-adapter.ts`

- [ ] **Step 1: Create abstract adapter class**

```typescript
// src/main/channels/channel-adapter.ts

import { EventEmitter } from 'events';
import type {
  ChannelPlatform,
  ChannelConnectionStatus,
  ChannelConfig,
  ChannelSendOptions,
  ChannelSentMessage,
  InboundChannelMessage,
  AccessPolicy,
  PairedSender,
} from '../../shared/types/channels';

export interface ChannelAdapterEvents {
  'message': (msg: InboundChannelMessage) => void;
  'status': (status: ChannelConnectionStatus) => void;
  'error': (error: Error) => void;
  'qr': (qrData: string) => void;
}

export abstract class BaseChannelAdapter extends EventEmitter {
  abstract readonly platform: ChannelPlatform;
  abstract status: ChannelConnectionStatus;

  abstract connect(config: ChannelConfig): Promise<void>;
  abstract disconnect(): Promise<void>;

  abstract sendMessage(chatId: string, content: string, options?: ChannelSendOptions): Promise<ChannelSentMessage>;
  abstract sendFile(chatId: string, filePath: string, caption?: string): Promise<ChannelSentMessage>;
  abstract editMessage(chatId: string, messageId: string, content: string): Promise<void>;
  abstract addReaction(chatId: string, messageId: string, emoji: string): Promise<void>;

  abstract getAccessPolicy(): AccessPolicy;
  abstract setAccessPolicy(policy: AccessPolicy): void;
  abstract pairSender(code: string): Promise<PairedSender>;

  // Typed emit/on overrides
  override emit<K extends keyof ChannelAdapterEvents>(
    event: K,
    ...args: Parameters<ChannelAdapterEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof ChannelAdapterEvents>(
    event: K,
    listener: ChannelAdapterEvents[K]
  ): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/channels/channel-adapter.ts
git commit -m "feat(channels): add BaseChannelAdapter abstract class with typed events"
```

---

## Task 8: ChannelManager Singleton

**Files:**
- Create: `src/main/channels/channel-manager.ts`
- Create: `src/main/channels/index.ts`
- Create: `src/main/channels/__tests__/channel-manager.spec.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/main/channels/__tests__/channel-manager.spec.ts

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ChannelManager } from '../channel-manager';
import { BaseChannelAdapter } from '../channel-adapter';
import type {
  ChannelPlatform, ChannelConnectionStatus, ChannelConfig,
  ChannelSendOptions, ChannelSentMessage, AccessPolicy, PairedSender,
} from '../../../shared/types/channels';

class MockAdapter extends BaseChannelAdapter {
  readonly platform: ChannelPlatform = 'discord';
  status: ChannelConnectionStatus = 'disconnected';

  connect = vi.fn(async () => { this.status = 'connected'; });
  disconnect = vi.fn(async () => { this.status = 'disconnected'; });
  sendMessage = vi.fn(async (): Promise<ChannelSentMessage> => ({ messageId: '1', chatId: 'c', timestamp: Date.now() }));
  sendFile = vi.fn(async (): Promise<ChannelSentMessage> => ({ messageId: '1', chatId: 'c', timestamp: Date.now() }));
  editMessage = vi.fn(async () => {});
  addReaction = vi.fn(async () => {});
  getAccessPolicy = vi.fn((): AccessPolicy => ({ mode: 'disabled', allowedSenders: [], pendingPairings: [], maxPending: 3, codeExpiryMs: 3600000 }));
  setAccessPolicy = vi.fn();
  pairSender = vi.fn(async (): Promise<PairedSender> => ({ senderId: 's', senderName: 'n', platform: 'discord', pairedAt: Date.now() }));
}

describe('ChannelManager', () => {
  let manager: ChannelManager;

  beforeEach(() => {
    ChannelManager._resetForTesting();
    manager = ChannelManager.getInstance();
  });

  it('should be a singleton', () => {
    expect(ChannelManager.getInstance()).toBe(manager);
  });

  it('should register and retrieve adapters', () => {
    const adapter = new MockAdapter();
    manager.registerAdapter(adapter);
    expect(manager.getAdapter('discord')).toBe(adapter);
  });

  it('should unregister adapters', () => {
    const adapter = new MockAdapter();
    manager.registerAdapter(adapter);
    manager.unregisterAdapter('discord');
    expect(manager.getAdapter('discord')).toBeUndefined();
  });

  it('should return all statuses', () => {
    const adapter = new MockAdapter();
    manager.registerAdapter(adapter);
    const statuses = manager.getAllStatuses();
    expect(statuses.get('discord')).toBe('disconnected');
  });

  it('should call disconnect on all adapters during shutdown', async () => {
    const adapter = new MockAdapter();
    adapter.status = 'connected';
    manager.registerAdapter(adapter);
    await manager.shutdown();
    expect(adapter.disconnect).toHaveBeenCalled();
  });

  it('should not fail shutdown if adapter disconnect throws', async () => {
    const adapter = new MockAdapter();
    adapter.status = 'connected';
    adapter.disconnect = vi.fn(async () => { throw new Error('fail'); });
    manager.registerAdapter(adapter);
    await expect(manager.shutdown()).resolves.not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/channels/__tests__/channel-manager.spec.ts`
Expected: FAIL

- [ ] **Step 3: Implement ChannelManager**

```typescript
// src/main/channels/channel-manager.ts

import { getLogger } from '../logging/logger';
import { BaseChannelAdapter } from './channel-adapter';
import type { ChannelPlatform, ChannelConnectionStatus } from '../../shared/types/channels';

const logger = getLogger('ChannelManager');

export class ChannelManager {
  private static instance: ChannelManager;
  private adapters = new Map<ChannelPlatform, BaseChannelAdapter>();

  static getInstance(): ChannelManager {
    if (!this.instance) {
      this.instance = new ChannelManager();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.adapters.clear();
    }
    (this as { instance?: ChannelManager }).instance = undefined;
  }

  private constructor() {
    logger.info('ChannelManager initialized');
  }

  registerAdapter(adapter: BaseChannelAdapter): void {
    if (this.adapters.has(adapter.platform)) {
      logger.warn('Adapter already registered, replacing', { platform: adapter.platform });
    }
    this.adapters.set(adapter.platform, adapter);
    logger.info('Adapter registered', { platform: adapter.platform });
  }

  unregisterAdapter(platform: ChannelPlatform): void {
    this.adapters.delete(platform);
    logger.info('Adapter unregistered', { platform });
  }

  getAdapter(platform: ChannelPlatform): BaseChannelAdapter | undefined {
    return this.adapters.get(platform);
  }

  getAllStatuses(): Map<ChannelPlatform, ChannelConnectionStatus> {
    const statuses = new Map<ChannelPlatform, ChannelConnectionStatus>();
    for (const [platform, adapter] of this.adapters) {
      statuses.set(platform, adapter.status);
    }
    return statuses;
  }

  async reconnect(platform: ChannelPlatform, config: ChannelConfig): Promise<void> {
    const adapter = this.adapters.get(platform);
    if (!adapter) {
      throw new Error(`No adapter registered for ${platform}`);
    }
    logger.info('Reconnecting adapter', { platform });
    if (adapter.status === 'connected' || adapter.status === 'connecting') {
      await adapter.disconnect();
    }
    await adapter.connect(config);
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down all channel adapters');
    const promises = [...this.adapters.values()]
      .filter(a => a.status === 'connected' || a.status === 'connecting')
      .map(async (adapter) => {
        try {
          await adapter.disconnect();
        } catch (error) {
          logger.error('Failed to disconnect adapter', error instanceof Error ? error : undefined, { platform: adapter.platform });
        }
      });
    await Promise.all(promises);
    this.adapters.clear();
  }
}
```

```typescript
// src/main/channels/index.ts

export { ChannelManager } from './channel-manager';
export { BaseChannelAdapter } from './channel-adapter';
export type { ChannelAdapterEvents } from './channel-adapter';
export { RateLimiter } from './rate-limiter';
export { ChannelPersistence } from './channel-persistence';

import { getRlmDatabase } from '../persistence/rlm/rlm-database';

export function getChannelManager(): ChannelManager {
  return ChannelManager.getInstance();
}

let persistenceInstance: ChannelPersistence | undefined;
export function getChannelPersistence(): ChannelPersistence {
  if (!persistenceInstance) {
    persistenceInstance = new ChannelPersistence(getRlmDatabase());
  }
  return persistenceInstance;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/channels/__tests__/channel-manager.spec.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/channels/channel-manager.ts src/main/channels/index.ts src/main/channels/__tests__/channel-manager.spec.ts
git commit -m "feat(channels): add ChannelManager singleton with adapter registry"
```

---

## Task 9: Install discord.js Dependency

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install discord.js**

Run: `npm install discord.js`

Note: discord.js is imported dynamically in the DiscordAdapter, so it won't affect startup time. But it needs to be in `dependencies` for types and dynamic import to resolve. Must be installed before the adapter is written.

- [ ] **Step 2: Verify install succeeded**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(channels): add discord.js dependency"
```

---

## Task 10: Discord Adapter

**Files:**
- Create: `src/main/channels/adapters/discord-adapter.ts`
- Create: `src/main/channels/__tests__/discord-adapter.spec.ts`

- [ ] **Step 1: Write failing tests**

Test connection lifecycle, message handling, chunking, pairing flow, bot mention stripping. Mock `discord.js` at module level:

```typescript
// src/main/channels/__tests__/discord-adapter.spec.ts

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// Mock discord.js before import
const mockLogin = vi.fn();
const mockDestroy = vi.fn();
const mockChannelSend = vi.fn().mockResolvedValue({ id: 'sent-1' });

vi.mock('discord.js', () => {
  const EventEmitter = require('events');
  class MockClient extends EventEmitter {
    user = { id: 'bot-123', tag: 'TestBot#0001' };
    ws = { ping: 50 };
    login = mockLogin;
    destroy = mockDestroy;
    channels = {
      fetch: vi.fn().mockResolvedValue({
        send: mockChannelSend,
        isTextBased: () => true,
      }),
    };
  }
  return {
    Client: MockClient,
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      DirectMessages: 4,
      MessageContent: 8,
    },
    Partials: { Channel: 0, Message: 1 },
  };
});

import { DiscordAdapter } from '../adapters/discord-adapter';

describe('DiscordAdapter', () => {
  let adapter: DiscordAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new DiscordAdapter();
  });

  afterEach(async () => {
    if (adapter.status === 'connected') {
      await adapter.disconnect();
    }
  });

  it('should start as disconnected', () => {
    expect(adapter.platform).toBe('discord');
    expect(adapter.status).toBe('disconnected');
  });

  it('should connect with a bot token', async () => {
    mockLogin.mockResolvedValueOnce('token');
    await adapter.connect({ platform: 'discord', token: 'test-token', allowedSenders: [], allowedChats: [] });
    expect(mockLogin).toHaveBeenCalledWith('test-token');
    expect(adapter.status).toBe('connected');
  });

  it('should reject connect without token', async () => {
    await expect(
      adapter.connect({ platform: 'discord', allowedSenders: [], allowedChats: [] })
    ).rejects.toThrow();
  });

  it('should disconnect', async () => {
    mockLogin.mockResolvedValueOnce('token');
    await adapter.connect({ platform: 'discord', token: 'test-token', allowedSenders: [], allowedChats: [] });
    await adapter.disconnect();
    expect(adapter.status).toBe('disconnected');
  });

  it('should chunk messages longer than 2000 chars', async () => {
    mockLogin.mockResolvedValueOnce('token');
    await adapter.connect({ platform: 'discord', token: 'test-token', allowedSenders: [], allowedChats: [] });

    const longMessage = 'x'.repeat(4500);
    await adapter.sendMessage('chat-1', longMessage);

    // Should have sent 3 chunks (2000 + 2000 + 500)
    expect(mockChannelSend).toHaveBeenCalledTimes(3);
  });

  it('should manage access policy', () => {
    const policy = adapter.getAccessPolicy();
    expect(policy.mode).toBe('pairing');

    adapter.setAccessPolicy({ ...policy, mode: 'allowlist' });
    expect(adapter.getAccessPolicy().mode).toBe('allowlist');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/channels/__tests__/discord-adapter.spec.ts`
Expected: FAIL

- [ ] **Step 3: Implement DiscordAdapter**

Create `src/main/channels/adapters/discord-adapter.ts`. Key responsibilities:
- Lazy import `discord.js` in `connect()`
- Create `Client` with appropriate intents (Guilds, GuildMessages, DirectMessages, MessageContent)
- Listen on `messageCreate` → emit typed `message` event
- `sendMessage` with chunking at 2000 chars on paragraph boundaries
- Access policy management (pairing mode by default)
- Pairing flow: unknown sender DMs → generate 6-char hex code → emit pairing event
- Strip `<@BOT_ID>` from message content before emitting
- `addReaction` via Discord API
- Thread support: set `threadId` from message channel parent

The adapter should be ~200-250 lines. Follow the `BaseChannelAdapter` abstract class contract. Use `getLogger('DiscordAdapter')` for structured logging.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/channels/__tests__/discord-adapter.spec.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Run `npx tsc --noEmit` to verify typing**

Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/channels/adapters/discord-adapter.ts src/main/channels/__tests__/discord-adapter.spec.ts
git commit -m "feat(channels): add Discord adapter with chunking, pairing, and thread support"
```

---

## Task 11: Channel Message Router

**Files:**
- Create: `src/main/channels/channel-message-router.ts`
- Create: `src/main/channels/__tests__/channel-message-router.spec.ts`

- [ ] **Step 1: Write failing tests**

Test access gate, rate limiting, intent parsing (default, thread, explicit instance, broadcast), bot mention stripping, result streaming. Use mocked `InstanceManager` and `ChannelPersistence`.

Key test cases:
- Blocks unauthorized senders
- Allows allowlisted senders
- Blocks rate-limited senders
- Routes plain message to new instance
- Routes thread reply to existing instance via persistence lookup
- Routes `@instance-3` to specific instance
- Routes `@all` to all active instances
- Strips `<@BOT_ID>` mention from content before routing
- `assertSendable` blocks outbound messages containing API keys / tokens (integrate with `SecretDetector` from `src/main/security/`)
- `assertSendable` blocks outbound file paths matching `.env*`, `*.pem`, `*.key`, `credentials.*`
- `assertSendable` blocks paths inside `~/.orchestrator/`, `~/.claude/`
- Adds reaction on message receipt, swaps to checkmark on success, X on error

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/channels/__tests__/channel-message-router.spec.ts`
Expected: FAIL

- [ ] **Step 3: Implement ChannelMessageRouter**

Create `src/main/channels/channel-message-router.ts`. Responsibilities:
1. Access gate — check sender against `AccessPolicy.allowedSenders`
2. Rate limit — use `RateLimiter` (10 msg/min/sender)
3. Parse intent — strip bot mention `<@ID>`, detect `@instance-N`, `@all`, thread routing
4. Route — create/target instances via `InstanceManager`
5. Execute — send message content to instance
6. Stream results — subscribe to `instance:output`, batch on 2s debounce, send back via adapter
7. `assertSendable(content)` — scan outbound content via `SecretDetector` patterns before sending

The router should accept dependencies via constructor for testability:
```typescript
constructor(deps: {
  persistence: ChannelPersistence;
  rateLimiter: RateLimiter;
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/channels/__tests__/channel-message-router.spec.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/channels/channel-message-router.ts src/main/channels/__tests__/channel-message-router.spec.ts
git commit -m "feat(channels): add message router with access control and intent parsing"
```

---

## Task 12: IPC Handlers

**Files:**
- Create: `src/main/ipc/handlers/channel-handlers.ts`
- Modify: `src/main/ipc/handlers/index.ts`

- [ ] **Step 1: Create channel IPC handlers**

Follow the pattern from `cost-handlers.ts`:
- Import `ipcMain`, `IPC_CHANNELS`, `IpcResponse`
- Import Zod schemas from `channel-schemas.ts`
- Import `getChannelManager` from `../../channels`
- Export `registerChannelHandlers(deps: { windowManager: WindowManager }): void`
- Register handlers for all 8 request/response channels:
  - `CHANNEL_CONNECT` — get adapter, call `connect()`
  - `CHANNEL_DISCONNECT` — get adapter, call `disconnect()`
  - `CHANNEL_GET_STATUS` — return `getAllStatuses()` or single adapter status
  - `CHANNEL_GET_MESSAGES` — query `ChannelPersistence`
  - `CHANNEL_SEND_MESSAGE` — get adapter, call `sendMessage()`
  - `CHANNEL_PAIR_SENDER` — get adapter, call `pairSender()`
  - `CHANNEL_GET_ACCESS_POLICY` — get adapter, return policy
  - `CHANNEL_SET_ACCESS_POLICY` — get adapter, update policy mode
- Each handler validates payload with `validateIpcPayload()`, returns `{ success: true, data }` or `{ success: false, error: { code, message, timestamp } }` using `ChannelErrorCode` types

- [ ] **Step 2: Add export to handlers barrel**

Add to `src/main/ipc/handlers/index.ts`:
```typescript
export { registerChannelHandlers } from './channel-handlers';
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/main/ipc/handlers/channel-handlers.ts src/main/ipc/handlers/index.ts
git commit -m "feat(channels): add IPC handlers for channel operations"
```

---

## Task 13: Preload Bridge

**Files:**
- Modify: `src/preload/preload.ts`

- [ ] **Step 1: Add channel IPC constants to preload**

Add the channel IPC channel names to the `IPC_CHANNELS` object in preload (duplicated since preload can't import from shared):

```typescript
  // Channel Management
  CHANNEL_CONNECT: 'channel:connect',
  CHANNEL_DISCONNECT: 'channel:disconnect',
  CHANNEL_GET_STATUS: 'channel:get-status',
  CHANNEL_GET_MESSAGES: 'channel:get-messages',
  CHANNEL_SEND_MESSAGE: 'channel:send-message',
  CHANNEL_PAIR_SENDER: 'channel:pair-sender',
  CHANNEL_GET_ACCESS_POLICY: 'channel:get-access-policy',
  CHANNEL_SET_ACCESS_POLICY: 'channel:set-access-policy',
  CHANNEL_STATUS_CHANGED: 'channel:status-changed',
  CHANNEL_MESSAGE_RECEIVED: 'channel:message-received',
  CHANNEL_RESPONSE_SENT: 'channel:response-sent',
  CHANNEL_ERROR: 'channel:error',
```

- [ ] **Step 2: Add channel API methods to electronAPI object**

Add before the `platform: process.platform` line at the end of the `electronAPI` object. Follow the existing pattern (e.g., `costRecordUsage`):

```typescript
  // ============================================
  // Channel Management
  // ============================================

  channelConnect: (payload: Record<string, unknown>): Promise<IpcResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHANNEL_CONNECT, withAuth(payload)),

  channelDisconnect: (payload: Record<string, unknown>): Promise<IpcResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHANNEL_DISCONNECT, withAuth(payload)),

  channelGetStatus: (payload?: Record<string, unknown>): Promise<IpcResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHANNEL_GET_STATUS, withAuth(payload ?? {})),

  channelGetMessages: (payload: Record<string, unknown>): Promise<IpcResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHANNEL_GET_MESSAGES, withAuth(payload)),

  channelSendMessage: (payload: Record<string, unknown>): Promise<IpcResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHANNEL_SEND_MESSAGE, withAuth(payload)),

  channelPairSender: (payload: Record<string, unknown>): Promise<IpcResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHANNEL_PAIR_SENDER, withAuth(payload)),

  channelGetAccessPolicy: (payload: Record<string, unknown>): Promise<IpcResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHANNEL_GET_ACCESS_POLICY, withAuth(payload)),

  channelSetAccessPolicy: (payload: Record<string, unknown>): Promise<IpcResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHANNEL_SET_ACCESS_POLICY, withAuth(payload)),

  // Channel push events (main -> renderer)
  channelOnStatusChanged: (callback: (data: unknown) => void) =>
    ipcRenderer.on(IPC_CHANNELS.CHANNEL_STATUS_CHANGED, (_e, data) => callback(data)),

  channelOnMessageReceived: (callback: (data: unknown) => void) =>
    ipcRenderer.on(IPC_CHANNELS.CHANNEL_MESSAGE_RECEIVED, (_e, data) => callback(data)),

  channelOnResponseSent: (callback: (data: unknown) => void) =>
    ipcRenderer.on(IPC_CHANNELS.CHANNEL_RESPONSE_SENT, (_e, data) => callback(data)),

  channelOnError: (callback: (data: unknown) => void) =>
    ipcRenderer.on(IPC_CHANNELS.CHANNEL_ERROR, (_e, data) => callback(data)),
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/preload/preload.ts
git commit -m "feat(channels): add channel IPC methods to preload bridge"
```

---

## Task 14: Main Process Wiring

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/main/ipc/ipc-main-handler.ts`

- [ ] **Step 1: Import and initialize ChannelManager at startup**

Add import at top of `src/main/index.ts`:
```typescript
import { getChannelManager } from './channels';
```

Add initialization in `AIOrchestratorApp` constructor or `start()` method (after other service inits):
```typescript
// Initialize channel manager (lazy — adapters connect on user request)
getChannelManager();
```

- [ ] **Step 2: Add shutdown to cleanup()**

Add to `cleanup()` method before `this.instanceManager.terminateAll()`:
```typescript
try { getChannelManager().shutdown(); } catch { /* best effort */ }
```

- [ ] **Step 3: Register IPC handlers**

In `src/main/ipc/ipc-main-handler.ts`, add the import and call `registerChannelHandlers`:
```typescript
import { registerChannelHandlers } from './handlers';

// In registerHandlers():
registerChannelHandlers({ windowManager: this.windowManager });
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/index.ts src/main/ipc/ipc-main-handler.ts
git commit -m "feat(channels): wire ChannelManager into app lifecycle and IPC registration"
```

---

## Task 15: Angular IPC Service

**Files:**
- Create: `src/renderer/app/core/services/ipc/channel-ipc.service.ts`

- [ ] **Step 1: Create channel IPC service**

Follow the `cost-ipc.service.ts` pattern:

```typescript
// src/renderer/app/core/services/ipc/channel-ipc.service.ts

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';
import type { ChannelPlatform } from '../../../../../shared/types/channels';

@Injectable({ providedIn: 'root' })
export class ChannelIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  async channelConnect(platform: ChannelPlatform, token?: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelConnect({ platform, token });
  }

  async channelDisconnect(platform: ChannelPlatform): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelDisconnect({ platform });
  }

  async channelGetStatus(platform?: ChannelPlatform): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelGetStatus(platform ? { platform } : undefined);
  }

  async channelGetMessages(platform: ChannelPlatform, chatId: string, limit?: number, before?: number): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelGetMessages({ platform, chatId, limit, before });
  }

  async channelSendMessage(platform: ChannelPlatform, chatId: string, content: string, replyTo?: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelSendMessage({ platform, chatId, content, replyTo });
  }

  async channelPairSender(platform: ChannelPlatform, code: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelPairSender({ platform, code });
  }

  async channelGetAccessPolicy(platform: ChannelPlatform): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelGetAccessPolicy({ platform });
  }

  async channelSetAccessPolicy(platform: ChannelPlatform, mode: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.channelSetAccessPolicy({ platform, mode });
  }

  // Push event listeners
  onStatusChanged(callback: (data: unknown) => void): void {
    this.api?.channelOnStatusChanged(callback);
  }

  onMessageReceived(callback: (data: unknown) => void): void {
    this.api?.channelOnMessageReceived(callback);
  }

  onResponseSent(callback: (data: unknown) => void): void {
    this.api?.channelOnResponseSent(callback);
  }

  onError(callback: (data: unknown) => void): void {
    this.api?.channelOnError(callback);
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/core/services/ipc/channel-ipc.service.ts
git commit -m "feat(channels): add Angular IPC bridge service for channels"
```

---

## Task 16: Angular Channel Store

**Files:**
- Create: `src/renderer/app/core/state/channel.store.ts`

- [ ] **Step 1: Create channel store**

Follow the `hook.store.ts` pattern with signals:

```typescript
// src/renderer/app/core/state/channel.store.ts

import { Injectable, inject, signal, computed } from '@angular/core';
import { ChannelIpcService } from '../services/ipc/channel-ipc.service';
import type {
  ChannelPlatform, ChannelConnectionStatus, StoredChannelMessage,
  ChannelStatusEvent, ChannelErrorEvent, InboundChannelMessage, ChannelResponse,
} from '../../../../shared/types/channels';

interface ChannelState {
  platform: ChannelPlatform;
  status: ChannelConnectionStatus;
  botUsername?: string;
  error?: string;
}

@Injectable({ providedIn: 'root' })
export class ChannelStore {
  private ipcService = inject(ChannelIpcService);

  // State
  private _channels = signal<ChannelState[]>([
    { platform: 'discord', status: 'disconnected' },
  ]);
  private _messages = signal<StoredChannelMessage[]>([]);
  private _loading = signal(false);
  private _error = signal<string | null>(null);

  // Selectors
  channels = this._channels.asReadonly();
  messages = this._messages.asReadonly();
  loading = this._loading.asReadonly();
  error = this._error.asReadonly();

  discordStatus = computed(() =>
    this._channels().find(c => c.platform === 'discord')?.status ?? 'disconnected'
  );

  isAnyConnected = computed(() =>
    this._channels().some(c => c.status === 'connected')
  );

  constructor() {
    this.listenForPushEvents();
  }

  async connect(platform: ChannelPlatform, token?: string): Promise<void> {
    this._loading.set(true);
    this._error.set(null);
    this.updateChannelStatus(platform, 'connecting');

    try {
      const response = await this.ipcService.channelConnect(platform, token);
      if (!response.success) {
        const errorMsg = response.error?.message ?? 'Connection failed';
        this._error.set(errorMsg);
        this.updateChannelStatus(platform, 'error');
      }
    } catch (err) {
      this._error.set((err as Error).message);
      this.updateChannelStatus(platform, 'error');
    } finally {
      this._loading.set(false);
    }
  }

  async disconnect(platform: ChannelPlatform): Promise<void> {
    try {
      await this.ipcService.channelDisconnect(platform);
      this.updateChannelStatus(platform, 'disconnected');
    } catch (err) {
      this._error.set((err as Error).message);
    }
  }

  async loadMessages(platform: ChannelPlatform, chatId: string): Promise<void> {
    this._loading.set(true);
    try {
      const response = await this.ipcService.channelGetMessages(platform, chatId);
      if (response.success && response.data) {
        this._messages.set(response.data as StoredChannelMessage[]);
      }
    } catch (err) {
      this._error.set((err as Error).message);
    } finally {
      this._loading.set(false);
    }
  }

  async pairSender(platform: ChannelPlatform, code: string): Promise<boolean> {
    try {
      const response = await this.ipcService.channelPairSender(platform, code);
      return response.success;
    } catch {
      return false;
    }
  }

  private updateChannelStatus(platform: ChannelPlatform, status: ChannelConnectionStatus, extra?: Partial<ChannelState>): void {
    this._channels.update(channels =>
      channels.map(c =>
        c.platform === platform ? { ...c, status, ...extra } : c
      )
    );
  }

  private listenForPushEvents(): void {
    this.ipcService.onStatusChanged((data) => {
      const event = data as ChannelStatusEvent;
      this.updateChannelStatus(event.platform, event.status, {
        botUsername: event.botUsername,
      });
    });

    this.ipcService.onError((data) => {
      const event = data as ChannelErrorEvent;
      this._error.set(event.error);
      if (!event.recoverable) {
        this.updateChannelStatus(event.platform, 'error', { error: event.error });
      }
    });

    this.ipcService.onMessageReceived((data) => {
      const msg = data as InboundChannelMessage;
      this._messages.update(msgs => [...msgs, {
        id: msg.id,
        platform: msg.platform,
        chatId: msg.chatId,
        messageId: msg.messageId,
        threadId: msg.threadId,
        senderId: msg.senderId,
        senderName: msg.senderName,
        content: msg.content,
        direction: 'inbound' as const,
        timestamp: msg.timestamp,
        createdAt: Math.floor(Date.now() / 1000),
      }]);
    });

    this.ipcService.onResponseSent((data) => {
      const response = data as ChannelResponse;
      // Append outbound response to messages
      this._messages.update(msgs => [...msgs, {
        id: crypto.randomUUID(),
        platform: 'discord' as ChannelPlatform,
        chatId: '',
        messageId: '',
        senderId: 'orchestrator',
        senderName: 'Orchestrator',
        content: response.content,
        direction: 'outbound' as const,
        instanceId: response.instanceId,
        timestamp: Date.now(),
        createdAt: Math.floor(Date.now() / 1000),
      }]);
    });
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/renderer/app/core/state/channel.store.ts
git commit -m "feat(channels): add signals-based channel store"
```

---

## Task 17: Angular Channels Page Component

**Files:**
- Create: `src/renderer/app/features/channels/channels-page.component.ts`
- Modify: `src/renderer/app/app.routes.ts`

- [ ] **Step 1: Create channels page component**

A single-file component with three sections: Connection panel, Messages view, Settings. Use Angular 21 standalone component with `ChangeDetectionStrategy.OnPush`, signals from `ChannelStore`.

The component should show:
- Discord connection card (status indicator, connect/disconnect button, bot token input)
- Connected state: bot username, message count
- Error state: error message with retry button
- Pairing section: input for 6-char hex code + pair button
- Message list: scrollable chat view with sender, content, timestamp
- Access policy toggle (pairing/allowlist/disabled)

- [ ] **Step 2: Add route to app.routes.ts**

Add before the catch-all redirect:
```typescript
  // Channels: Discord/WhatsApp remote control
  {
    path: 'channels',
    loadComponent: () =>
      import('./features/channels/channels-page.component').then(
        (m) => m.ChannelsPageComponent
      ),
  },
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/renderer/app/features/channels/channels-page.component.ts src/renderer/app/app.routes.ts
git commit -m "feat(channels): add channels page component with Discord connection UI"
```

---

## Task 18: Full Verification

- [ ] **Step 1: TypeScript check (main)**

Run: `npx tsc --noEmit`
Expected: PASS with zero errors

- [ ] **Step 2: TypeScript check (specs)**

Run: `npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS (fix any lint errors introduced)

- [ ] **Step 4: Run all channel tests**

Run: `npx vitest run src/main/channels/`
Expected: All tests PASS

- [ ] **Step 5: Run full test suite**

Run: `npm run test`
Expected: No regressions — existing tests still pass

- [ ] **Step 6: Final commit (if any lint/test fixes were needed)**

```bash
git add -A
git commit -m "fix(channels): address lint and test issues from full verification"
```
