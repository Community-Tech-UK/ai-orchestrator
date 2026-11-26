# Discord & WhatsApp Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Discord and WhatsApp messaging channels so users can send tasks to the Orchestrator from their phone and receive results back in chat.

**Architecture:** Native singleton services in the Electron main process. A `ChannelManager` manages platform adapters (Discord via discord.js, WhatsApp via whatsapp-web.js) behind a shared `ChannelAdapter` interface. A `ChannelMessageRouter` gates, parses, routes inbound messages to instances and streams results back. Angular UI provides connection management, message history, and settings.

**Tech Stack:** TypeScript, discord.js ^14.x, whatsapp-web.js ^1.x, puppeteer-core ^22.x, qrcode ^1.x, Zod 4, better-sqlite3, Angular 21 signals

**Spec:** `docs/superpowers/specs/2026-03-21-discord-whatsapp-channels-design_completed.md`

---

## File Map

### New Files (Main Process)
| File | Responsibility |
|------|---------------|
| `src/main/channels/channel-adapter.ts` | `ChannelAdapter` interface, shared types, `SendOptions`, `SentMessage`, `PairedSender`, `AccessPolicy` |
| `src/main/channels/rate-limiter.ts` | Sliding window rate limiter utility |
| `src/main/channels/channel-persistence.ts` | SQLite queries for `channel_messages` table |
| `src/main/channels/channel-manager.ts` | `ChannelManager` singleton, adapter registry, event forwarding |
| `src/main/channels/channel-message-router.ts` | Access gate, intent parsing, instance routing, result streaming |
| `src/main/channels/adapters/discord-adapter.ts` | Discord implementation of `ChannelAdapter` |
| `src/main/channels/adapters/whatsapp-adapter.ts` | WhatsApp implementation of `ChannelAdapter` |
| `src/main/channels/index.ts` | Barrel exports, `getChannelManager()` |
| `src/main/ipc/handlers/channel-handlers.ts` | IPC handler registration for channel domain |

### New Files (Shared)
| File | Responsibility |
|------|---------------|
| `src/shared/types/channels.ts` | Shared type definitions used by both main and renderer |
| `src/shared/validation/channel-schemas.ts` | Zod schemas for IPC payload validation |

### New Files (Renderer)
| File | Responsibility |
|------|---------------|
| `src/renderer/app/core/services/ipc/channel-ipc.service.ts` | IPC bridge service |
| `src/renderer/app/core/state/channel.store.ts` | Signal-based state management |
| `src/renderer/app/features/channels/channels.routes.ts` | Route definitions for channels feature |
| `src/renderer/app/features/channels/components/channel-connections/channel-connections.component.ts` | Connection cards, token input, QR display |
| `src/renderer/app/features/channels/components/channel-messages/channel-messages.component.ts` | Chat-style message history view |
| `src/renderer/app/features/channels/components/channel-settings/channel-settings.component.ts` | Access policy management, paired accounts |

### New Files (Tests)
| File | Responsibility |
|------|---------------|
| `src/main/channels/__tests__/rate-limiter.spec.ts` | Rate limiter tests |
| `src/main/channels/__tests__/channel-persistence.spec.ts` | Persistence layer tests |
| `src/main/channels/__tests__/channel-manager.spec.ts` | Manager lifecycle tests |
| `src/main/channels/__tests__/channel-message-router.spec.ts` | Routing logic tests |
| `src/main/channels/__tests__/discord-adapter.spec.ts` | Discord adapter tests |
| `src/main/channels/__tests__/whatsapp-adapter.spec.ts` | WhatsApp adapter tests |

### Modified Files
| File | Change |
|------|--------|
| `src/shared/types/ipc.types.ts` | Add 12 channel IPC constants + payload interfaces |
| `src/preload/preload.ts` | Add 12 channel IPC channels (8 invoke + 4 on) |
| `src/main/persistence/rlm/rlm-schema.ts` | Add migration `006_add_channel_messages` |
| `src/main/ipc/handlers/index.ts` | Add `registerChannelHandlers` export |
| `src/main/ipc/ipc-main-handler.ts` | Add `registerChannelHandlers()` call |
| `src/main/index.ts` | Initialize `getChannelManager()` at startup, shutdown on exit |
| `src/renderer/app/core/services/ipc/index.ts` | Add `ChannelIpcService` export |
| `package.json` | Add `discord.js`, `whatsapp-web.js`, `puppeteer-core`, `qrcode` deps |

---

## Task 1: Install Dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install npm packages**

```bash
npm install discord.js@^14 whatsapp-web.js@^1 puppeteer-core@^22 qrcode@^1
npm install -D @types/qrcode
```

- [ ] **Step 2: Configure Electron Builder externals**

In `package.json` (or `electron-builder.json`), ensure `whatsapp-web.js` and `puppeteer-core` are excluded from asar packaging. Add to the build config's `asarUnpack` or `externals` field as appropriate for the project's bundler. These packages have dynamic file requirements that break inside asar archives.

- [ ] **Step 3: Verify installation**

Run: `npx tsc --noEmit 2>&1 | head -5`
Expected: No new errors from the added packages

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add discord.js, whatsapp-web.js, puppeteer-core, qrcode dependencies"
```

---

## Task 2: Shared Types & Validation Schemas

**Files:**
- Create: `src/shared/types/channels.ts`
- Create: `src/shared/validation/channel-schemas.ts`
- Modify: `src/shared/types/ipc.types.ts`

- [ ] **Step 1: Create shared channel types**

Create `src/shared/types/channels.ts`:

```typescript
/**
 * Channel Types - Shared between main process and renderer
 */

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

export interface SendOptions {
  replyTo?: string;
  splitAt?: number;
}

export interface SentMessage {
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

export interface ChannelMessageRow {
  id: string;
  platform: string;
  chat_id: string;
  message_id: string;
  thread_id: string | null;
  sender_id: string;
  sender_name: string;
  content: string;
  direction: 'inbound' | 'outbound';
  instance_id: string | null;
  reply_to_message_id: string | null;
  timestamp: number;
  created_at: number;
}
```

- [ ] **Step 2: Create Zod validation schemas**

Create `src/shared/validation/channel-schemas.ts`:

```typescript
/**
 * Channel IPC Payload Validation Schemas
 */
import { z } from 'zod';

const ChannelPlatformSchema = z.enum(['discord', 'whatsapp']);

export const ChannelConnectPayloadSchema = z.object({
  platform: ChannelPlatformSchema,
  token: z.string().min(1).max(500).optional(),
});

export const ChannelDisconnectPayloadSchema = z.object({
  platform: ChannelPlatformSchema,
});

export const ChannelGetStatusPayloadSchema = z.object({}).optional();

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

export const ChannelSetAccessPolicyPayloadSchema = z.object({
  platform: ChannelPlatformSchema,
  mode: z.enum(['pairing', 'allowlist', 'disabled']),
});

export const ChannelGetAccessPolicyPayloadSchema = z.object({
  platform: ChannelPlatformSchema,
});

export type ValidatedChannelConnectPayload = z.infer<typeof ChannelConnectPayloadSchema>;
export type ValidatedChannelSendMessagePayload = z.infer<typeof ChannelSendMessagePayloadSchema>;
export type ValidatedChannelPairSenderPayload = z.infer<typeof ChannelPairSenderPayloadSchema>;
export type ValidatedChannelGetMessagesPayload = z.infer<typeof ChannelGetMessagesPayloadSchema>;
```

- [ ] **Step 3: Add IPC channel constants to `src/shared/types/ipc.types.ts`**

Add inside the `IPC_CHANNELS` object, after the existing Remote Observer section:

```typescript
  // Channel management (request/response)
  CHANNEL_CONNECT: 'channel:connect',
  CHANNEL_DISCONNECT: 'channel:disconnect',
  CHANNEL_GET_STATUS: 'channel:get-status',
  CHANNEL_GET_MESSAGES: 'channel:get-messages',
  CHANNEL_SEND_MESSAGE: 'channel:send-message',
  CHANNEL_PAIR_SENDER: 'channel:pair-sender',
  CHANNEL_SET_ACCESS_POLICY: 'channel:set-access-policy',
  CHANNEL_GET_ACCESS_POLICY: 'channel:get-access-policy',

  // Channel push events (main -> renderer)
  CHANNEL_STATUS_CHANGED: 'channel:status-changed',
  CHANNEL_MESSAGE_RECEIVED: 'channel:message-received',
  CHANNEL_RESPONSE_SENT: 'channel:response-sent',
  CHANNEL_ERROR: 'channel:error',
```

Also add payload interfaces at the end of the file. Import `ChannelPlatform` from `channels.ts` to avoid duplicating the platform union:

```typescript
import type { ChannelPlatform } from './channels';

// ============ Channel Payloads ============

export interface ChannelConnectPayload {
  platform: ChannelPlatform;
  token?: string;
}

export interface ChannelDisconnectPayload {
  platform: ChannelPlatform;
}

export interface ChannelGetMessagesPayload {
  platform: ChannelPlatform;
  chatId: string;
  limit?: number;
  before?: number;
}

export interface ChannelSendMessagePayload {
  platform: ChannelPlatform;
  chatId: string;
  content: string;
  replyTo?: string;
}

export interface ChannelPairSenderPayload {
  platform: ChannelPlatform;
  code: string;
}

export interface ChannelSetAccessPolicyPayload {
  platform: ChannelPlatform;
  mode: 'pairing' | 'allowlist' | 'disabled';
}

export interface ChannelGetAccessPolicyPayload {
  platform: ChannelPlatform;
}
```

- [ ] **Step 4: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 5: Run lint**

Run: `npx eslint src/shared/types/channels.ts src/shared/validation/channel-schemas.ts`
Expected: PASS (or fix any issues)

- [ ] **Step 6: Commit**

```bash
git add src/shared/types/channels.ts src/shared/validation/channel-schemas.ts src/shared/types/ipc.types.ts
git commit -m "feat(channels): add shared types, Zod schemas, and IPC constants"
```

---

## Task 3: Rate Limiter Utility

**Files:**
- Create: `src/main/channels/rate-limiter.ts`
- Create: `src/main/channels/__tests__/rate-limiter.spec.ts`

- [ ] **Step 1: Write failing tests**

Create `src/main/channels/__tests__/rate-limiter.spec.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimiter } from '../rate-limiter';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(10, 60_000); // 10 per 60s
  });

  it('allows messages under the limit', () => {
    for (let i = 0; i < 10; i++) {
      expect(limiter.check('user-1')).toBe(true);
    }
  });

  it('blocks messages over the limit', () => {
    for (let i = 0; i < 10; i++) {
      limiter.check('user-1');
    }
    expect(limiter.check('user-1')).toBe(false);
  });

  it('tracks senders independently', () => {
    for (let i = 0; i < 10; i++) {
      limiter.check('user-1');
    }
    expect(limiter.check('user-1')).toBe(false);
    expect(limiter.check('user-2')).toBe(true);
  });

  it('resets after the window expires', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 10; i++) {
      limiter.check('user-1');
    }
    expect(limiter.check('user-1')).toBe(false);

    vi.advanceTimersByTime(60_001);
    expect(limiter.check('user-1')).toBe(true);
    vi.useRealTimers();
  });

  it('uses sliding window (old entries expire individually)', () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) {
      limiter.check('user-1');
    }
    vi.advanceTimersByTime(30_000);
    for (let i = 0; i < 5; i++) {
      limiter.check('user-1');
    }
    expect(limiter.check('user-1')).toBe(false);

    vi.advanceTimersByTime(30_001);
    expect(limiter.check('user-1')).toBe(true);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/channels/__tests__/rate-limiter.spec.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement rate limiter**

Create `src/main/channels/rate-limiter.ts`:

```typescript
/**
 * Sliding Window Rate Limiter
 *
 * Tracks timestamps per sender and prunes expired entries on each check.
 */

export class RateLimiter {
  private windows = new Map<string, number[]>();

  constructor(
    private maxRequests: number,
    private windowMs: number,
  ) {}

  check(senderId: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;

    let timestamps = this.windows.get(senderId);
    if (!timestamps) {
      timestamps = [];
      this.windows.set(senderId, timestamps);
    }

    const firstValid = timestamps.findIndex(t => t > cutoff);
    if (firstValid > 0) {
      timestamps.splice(0, firstValid);
    } else if (firstValid === -1) {
      timestamps.length = 0;
    }

    if (timestamps.length >= this.maxRequests) {
      return false;
    }

    timestamps.push(now);
    return true;
  }

  reset(senderId: string): void {
    this.windows.delete(senderId);
  }

  clear(): void {
    this.windows.clear();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/channels/__tests__/rate-limiter.spec.ts`
Expected: PASS (all 5 tests)

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/channels/rate-limiter.ts src/main/channels/__tests__/rate-limiter.spec.ts
git commit -m "feat(channels): add sliding window rate limiter"
```

---

## Task 4: SQLite Migration & Persistence Layer

**Files:**
- Modify: `src/main/persistence/rlm/rlm-schema.ts`
- Create: `src/main/channels/channel-persistence.ts`
- Create: `src/main/channels/__tests__/channel-persistence.spec.ts`

- [ ] **Step 1: Add migration to rlm-schema.ts**

Append to the `MIGRATIONS` array in `src/main/persistence/rlm/rlm-schema.ts`:

```typescript
  // Migration 006: Add channel messages table
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
      DROP INDEX IF EXISTS idx_channel_messages_timestamp;
      DROP INDEX IF EXISTS idx_channel_messages_thread;
      DROP INDEX IF EXISTS idx_channel_messages_instance;
      DROP INDEX IF EXISTS idx_channel_messages_chat;
      DROP TABLE IF EXISTS channel_messages;
    `
  },
```

- [ ] **Step 2: Write failing persistence tests**

Create `src/main/channels/__tests__/channel-persistence.spec.ts` with tests for:
- Save and retrieve an inbound message
- Resolve instance from thread_id
- Return null for unknown thread
- Paginate messages with `before` cursor
- Update instance_id on existing message

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/main/channels/__tests__/channel-persistence.spec.ts`
Expected: FAIL (module not found)

- [ ] **Step 4: Implement persistence layer**

Create `src/main/channels/channel-persistence.ts`:

```typescript
/**
 * Channel Persistence - SQLite queries for channel_messages table
 */

import type Database from 'better-sqlite3';
import type { ChannelMessageRow } from '../../shared/types/channels';

type SaveMessageParams = Omit<ChannelMessageRow, 'created_at'>;

export class ChannelPersistence {
  constructor(private db: Database.Database) {}

  saveMessage(msg: SaveMessageParams): void {
    const stmt = this.db.prepare(`
      INSERT INTO channel_messages
        (id, platform, chat_id, message_id, thread_id, sender_id, sender_name,
         content, direction, instance_id, reply_to_message_id, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      msg.id, msg.platform, msg.chat_id, msg.message_id, msg.thread_id,
      msg.sender_id, msg.sender_name, msg.content, msg.direction,
      msg.instance_id, msg.reply_to_message_id, msg.timestamp,
    );
  }

  getMessages(
    platform: string,
    chatId: string,
    limit = 50,
    before?: number,
  ): ChannelMessageRow[] {
    if (before) {
      return this.db.prepare(`
        SELECT * FROM channel_messages
        WHERE platform = ? AND chat_id = ? AND timestamp < ?
        ORDER BY timestamp DESC LIMIT ?
      `).all(platform, chatId, before, limit) as ChannelMessageRow[];
    }
    return this.db.prepare(`
      SELECT * FROM channel_messages
      WHERE platform = ? AND chat_id = ?
      ORDER BY timestamp DESC LIMIT ?
    `).all(platform, chatId, limit) as ChannelMessageRow[];
  }

  resolveInstanceByThread(threadId: string): string | null {
    const row = this.db.prepare(`
      SELECT instance_id FROM channel_messages
      WHERE thread_id = ? AND instance_id IS NOT NULL
      ORDER BY timestamp DESC LIMIT 1
    `).get(threadId) as { instance_id: string } | undefined;
    return row?.instance_id ?? null;
  }

  updateInstanceId(messageId: string, instanceId: string): void {
    this.db.prepare(`
      UPDATE channel_messages SET instance_id = ? WHERE id = ?
    `).run(instanceId, messageId);
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/main/channels/__tests__/channel-persistence.spec.ts`
Expected: PASS

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/persistence/rlm/rlm-schema.ts src/main/channels/channel-persistence.ts src/main/channels/__tests__/channel-persistence.spec.ts
git commit -m "feat(channels): add SQLite migration and persistence layer"
```

---

## Task 5: Channel Adapter Interface & Discord Adapter

**Files:**
- Create: `src/main/channels/channel-adapter.ts`
- Create: `src/main/channels/adapters/discord-adapter.ts`
- Create: `src/main/channels/__tests__/discord-adapter.spec.ts`

- [ ] **Step 1: Create the adapter interface**

Create `src/main/channels/channel-adapter.ts` with the `BaseChannelAdapter` abstract class extending `EventEmitter`. Define abstract methods: `connect`, `disconnect`, `sendMessage`, `sendFile`, `editMessage`, `addReaction`, `getAccessPolicy`, `setAccessPolicy`, `pairSender`. See spec for the full interface.

- [ ] **Step 2: Write failing Discord adapter tests**

Create `src/main/channels/__tests__/discord-adapter.spec.ts`. Mock `discord.js` with `vi.mock()` before importing the adapter. Test cases:
- Starts in `disconnected` status with platform `discord`
- Connects via bot token, emits `connecting` then `connected` status events
- Disconnects cleanly
- Default access policy is `pairing` mode with maxPending=3
- Chunks messages at 2000 chars
- Handles incoming messages from allowlisted senders (emits `message` event)
- Drops messages from non-allowlisted senders silently
- Sends pairing code to unknown senders in pairing mode

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run src/main/channels/__tests__/discord-adapter.spec.ts`
Expected: FAIL (module not found)

- [ ] **Step 4: Implement Discord adapter**

Create `src/main/channels/adapters/discord-adapter.ts`. Key implementation details:
- Lazy-imports `discord.js` in `connect()` method
- Uses `GatewayIntentBits`: Guilds, GuildMessages, DirectMessages, MessageContent
- Uses `Partials.Channel` for DM support
- `handleMessage()`: checks bot self-messages, group @mention requirement, access gate, typing indicator, then emits `InboundChannelMessage`
- `handlePairingRequest()`: generates 6-char hex code, stores in `pendingPairings`, replies to user
- `chunkMessage()`: splits at paragraph boundaries, then newlines, then spaces, then hard cut at 2000 chars
- Uses `getLogger('DiscordAdapter')` for structured logging

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/main/channels/__tests__/discord-adapter.spec.ts`
Expected: PASS

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/channels/channel-adapter.ts src/main/channels/adapters/discord-adapter.ts src/main/channels/__tests__/discord-adapter.spec.ts
git commit -m "feat(channels): add ChannelAdapter interface and Discord adapter"
```

---

## Task 6: WhatsApp Adapter

**Files:**
- Create: `src/main/channels/adapters/whatsapp-adapter.ts`
- Create: `src/main/channels/__tests__/whatsapp-adapter.spec.ts`

- [ ] **Step 1: Write failing WhatsApp adapter tests**

Create `src/main/channels/__tests__/whatsapp-adapter.spec.ts`. Mock `whatsapp-web.js` with `vi.mock()`. Test cases:
- Starts in `disconnected` status with platform `whatsapp`
- Connects, emits QR event, emits `connected` after `ready` event
- Disconnects cleanly
- Default access policy is `pairing` mode
- Emits error with clear message when Chrome is not found
- Handles incoming messages from allowlisted senders
- Drops messages from non-allowlisted senders silently

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/channels/__tests__/whatsapp-adapter.spec.ts`
Expected: FAIL

- [ ] **Step 3: Implement WhatsApp adapter**

Create `src/main/channels/adapters/whatsapp-adapter.ts`. Key differences from Discord:
- Uses `puppeteer-core` (not full puppeteer) with system Chrome via `PUPPETEER_EXECUTABLE_PATH`
- Fallback: if Chrome not found, emit `error` event with "Chrome/Chromium not found" message, stay `disconnected`
- Uses `LocalAuth` strategy for session persistence across app restarts
- Emits `qr` event with QR code data for Angular UI rendering
- Chunks at 65536 chars
- Eager attachment download (WhatsApp has no history API)
- Uses `getLogger('WhatsAppAdapter')` for structured logging

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/channels/__tests__/whatsapp-adapter.spec.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/channels/adapters/whatsapp-adapter.ts src/main/channels/__tests__/whatsapp-adapter.spec.ts
git commit -m "feat(channels): add WhatsApp adapter with QR code auth"
```

---

## Task 7: Channel Manager

**Files:**
- Create: `src/main/channels/channel-manager.ts`
- Create: `src/main/channels/index.ts`
- Create: `src/main/channels/__tests__/channel-manager.spec.ts`

- [ ] **Step 1: Write failing ChannelManager tests**

Create `src/main/channels/__tests__/channel-manager.spec.ts`. Use a minimal `MockAdapter` class. Test cases:
- Is a singleton (`getInstance()` returns same reference)
- Registers and retrieves adapters by platform
- Unregisters adapters
- Returns statuses for all registered adapters
- Shuts down all connected adapters
- Forwards adapter `message` events to listeners
- Forwards adapter `status` events to listeners
- Forwards adapter `error` events to listeners

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/channels/__tests__/channel-manager.spec.ts`
Expected: FAIL

- [ ] **Step 3: Implement ChannelManager**

Create `src/main/channels/channel-manager.ts` following the singleton pattern with `getInstance()`, `_resetForTesting()`, and `getChannelManager()` getter. Key features:
- `adapters` Map keyed by `ChannelPlatform`
- `onEvent()` listener registration with cleanup function return
- Subscribes to adapter events on `registerAdapter()`, forwards to all listeners
- `removeAllListeners()` on `unregisterAdapter()`
- `shutdown()` disconnects all connected adapters in parallel
- Uses `getLogger('ChannelManager')`

- [ ] **Step 4: Create barrel export**

Create `src/main/channels/index.ts` exporting: `ChannelManager`, `getChannelManager`, `BaseChannelAdapter`, `ChannelPersistence`, `RateLimiter`, and relevant types. **Note:** After Task 8, update this barrel to also export `ChannelMessageRouter`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/main/channels/__tests__/channel-manager.spec.ts`
Expected: PASS

- [ ] **Step 6: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/channels/channel-manager.ts src/main/channels/index.ts src/main/channels/__tests__/channel-manager.spec.ts
git commit -m "feat(channels): add ChannelManager singleton"
```

---

## Task 8: Channel Message Router

**Files:**
- Create: `src/main/channels/channel-message-router.ts`
- Create: `src/main/channels/__tests__/channel-message-router.spec.ts`

- [ ] **Step 1: Write failing router tests**

Create `src/main/channels/__tests__/channel-message-router.spec.ts`. Mock `InstanceManager` and `ChannelManager`. Test cases:
- Blocks unauthorized senders (not in adapter allowlist)
- Blocks rate-limited senders (>10 messages/min)
- Routes default message by creating new instance
- Routes threaded message to existing instance (via persistence lookup)
- Routes `@instance-3 <message>` to explicit instance
- Routes `@all <message>` to all active instances
- Batches output on 2-second debounce before sending back
- Sends reaction on receipt, completion, and error
- Saves messages to persistence layer

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/channels/__tests__/channel-message-router.spec.ts`
Expected: FAIL

- [ ] **Step 3: Implement the message router**

Create `src/main/channels/channel-message-router.ts`. Constructor takes:
- `channelManager: ChannelManager`
- `instanceManager: InstanceManager` (import from `../../instance/instance-manager`)
- `persistence: ChannelPersistence`

Key methods:
- `start()`: subscribes to `channelManager.onEvent()` for `message` type
- `stop()`: cleans up subscriptions
- `handleInboundMessage(msg)`: access gate -> rate limit -> parse intent -> route -> stream results
- `parseIntent(content)`: returns `{ type: 'default' | 'explicit' | 'broadcast', instanceId?, cleanContent }`
- `routeDefault(msg)`: creates instance via `instanceManager`, saves to persistence
- `routeToThread(msg)`: resolves via `persistence.resolveInstanceByThread()`
- `routeExplicit(msg, instanceId)`: sends to specific instance
- `streamResults(msg, instanceId, adapter)`: subscribes to `instance:output` events from InstanceManager's EventEmitter, 2s debounce batch, sends via adapter
- `assertSendable(filePath)`: security guard that blocks sending files from config/state directories (tokens, access.json, .env). Only allows files from designated inbox/outbox directories. Throws if path is forbidden.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/channels/__tests__/channel-message-router.spec.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/main/channels/channel-message-router.ts src/main/channels/__tests__/channel-message-router.spec.ts
git commit -m "feat(channels): add message router with access gate, rate limiting, and result streaming"
```

---

## Task 9: IPC Handlers & Preload Bridge

**Files:**
- Create: `src/main/ipc/handlers/channel-handlers.ts`
- Modify: `src/main/ipc/handlers/index.ts`
- Modify: `src/main/ipc/ipc-main-handler.ts`
- Modify: `src/preload/preload.ts`

- [ ] **Step 1: Create channel IPC handlers**

Create `src/main/ipc/handlers/channel-handlers.ts` following the `communication-handlers.ts` pattern. Register handlers for all 8 request/response channels. Wire push events from `ChannelManager.onEvent()` to `webContents.send()`.

Handler signature: `registerChannelHandlers(deps: { windowManager: WindowManager }): void`

Each handler: `ipcMain.handle(IPC_CHANNELS.CHANNEL_XXX, async (_event, payload) => { try { validate -> delegate -> return { success, data } } catch { return { success: false, error } } })`

- [ ] **Step 2: Add to barrel export**

In `src/main/ipc/handlers/index.ts`, add:

```typescript
export { registerChannelHandlers } from './channel-handlers';
```

- [ ] **Step 3: Register in IPC main handler**

In `src/main/ipc/ipc-main-handler.ts`:
- Add `registerChannelHandlers` to the destructured import from `'./handlers'`
- Add in `registerHandlers()`: `registerChannelHandlers({ windowManager: this.windowManager });`

- [ ] **Step 4: Add to preload bridge**

In `src/preload/preload.ts`:
- Add the 12 channel IPC constants to the duplicated `IPC_CHANNELS` object (must match `src/shared/types/ipc.types.ts` exactly)
- Add 8 invoke methods following existing pattern:

```typescript
  channelConnect: (payload: { platform: string; token?: string }): Promise<IpcResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHANNEL_CONNECT, payload),
  channelDisconnect: (payload: { platform: string }): Promise<IpcResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHANNEL_DISCONNECT, payload),
  channelGetStatus: (): Promise<IpcResponse> =>
    ipcRenderer.invoke(IPC_CHANNELS.CHANNEL_GET_STATUS),
  // ... (5 more following same pattern)
```

- Add 4 event listener methods following existing pattern:

```typescript
  onChannelStatusChanged: (callback: (event: unknown) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.CHANNEL_STATUS_CHANGED, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CHANNEL_STATUS_CHANGED, handler);
  },
  // ... (3 more following same pattern)
```

- [ ] **Step 5: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 6: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/ipc/handlers/channel-handlers.ts src/main/ipc/handlers/index.ts src/main/ipc/ipc-main-handler.ts src/preload/preload.ts
git commit -m "feat(channels): add IPC handlers and preload bridge"
```

---

## Task 10: Startup Integration

**Files:**
- Modify: `src/main/index.ts`

- [ ] **Step 1: Add ChannelManager to startup**

In `src/main/index.ts`:
- Import: `import { getChannelManager } from './channels';`
- During app initialization (after InstanceManager is ready): `const channelManager = getChannelManager();`
- During shutdown (in the existing shutdown sequence): `await channelManager.shutdown();`

- [ ] **Step 2: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/main/index.ts
git commit -m "feat(channels): wire ChannelManager into app startup and shutdown"
```

---

## Task 11: Angular IPC Service & Store

**Files:**
- Create: `src/renderer/app/core/services/ipc/channel-ipc.service.ts`
- Create: `src/renderer/app/core/state/channel.store.ts`
- Modify: `src/renderer/app/core/services/ipc/index.ts`

- [ ] **Step 1: Create Channel IPC service**

Create `src/renderer/app/core/services/ipc/channel-ipc.service.ts` following `comm-ipc.service.ts` pattern:
- `@Injectable({ providedIn: 'root' })`
- Inject `ElectronIpcService`, get API via `this.base.getApi()`
- Methods: `connect()`, `disconnect()`, `getStatus()`, `pairSender()`, `sendMessage()`, `getMessages()`, `getAccessPolicy()`, `setAccessPolicy()`
- Event listeners: `onStatusChanged()`, `onMessageReceived()`, `onResponseSent()`, `onError()` — each returns cleanup function

- [ ] **Step 2: Create Channel store**

Create `src/renderer/app/core/state/channel.store.ts` following `command.store.ts` pattern:
- `@Injectable({ providedIn: 'root' })` with `OnDestroy`
- Private signals: `_discord`, `_whatsapp` (each `ChannelState`), `_messages`, `_loading`
- Public readonly selectors via `.asReadonly()`
- Computed: `anyConnected`
- Subscribe to push events in constructor, clean up in `ngOnDestroy()`
- Methods: `connectDiscord(token)`, `connectWhatsApp()`, `disconnect(platform)`, `pairSender(platform, code)`

- [ ] **Step 3: Add to IPC service barrel export**

In `src/renderer/app/core/services/ipc/index.ts`, add:

```typescript
export { ChannelIpcService } from './channel-ipc.service';
```

- [ ] **Step 4: Run typecheck (both configs)**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS

- [ ] **Step 5: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/app/core/services/ipc/channel-ipc.service.ts src/renderer/app/core/services/ipc/index.ts src/renderer/app/core/state/channel.store.ts
git commit -m "feat(channels): add Angular IPC service and signal-based store"
```

---

## Task 12: Full Integration Verification

- [ ] **Step 1: Run all channel tests**

Run: `npx vitest run src/main/channels/`
Expected: All tests pass

- [ ] **Step 2: Run full typecheck (both configs)**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS

- [ ] **Step 3: Run full lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 4: Run full test suite**

Run: `npm run test`
Expected: No regressions

- [ ] **Step 5: Commit any remaining fixes**

Only if there were issues to fix:
```bash
git add -A
git commit -m "fix(channels): address integration issues from full verification"
```

---

## Task 13: Angular UI — Channel Connections Component

**Files:**
- Create: `src/renderer/app/features/channels/channels.routes.ts`
- Create: `src/renderer/app/features/channels/components/channel-connections/channel-connections.component.ts`

- [ ] **Step 1: Create route definitions**

Create `src/renderer/app/features/channels/channels.routes.ts`:

```typescript
import { Routes } from '@angular/router';

export const CHANNELS_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () =>
      import('./components/channel-connections/channel-connections.component')
        .then(m => m.ChannelConnectionsComponent),
  },
  {
    path: 'messages',
    loadComponent: () =>
      import('./components/channel-messages/channel-messages.component')
        .then(m => m.ChannelMessagesComponent),
  },
  {
    path: 'settings',
    loadComponent: () =>
      import('./components/channel-settings/channel-settings.component')
        .then(m => m.ChannelSettingsComponent),
  },
];
```

- [ ] **Step 2: Create Channel Connections component**

Create `src/renderer/app/features/channels/components/channel-connections/channel-connections.component.ts`. This is a standalone Angular component with `OnPush` change detection:

- Injects `ChannelStore`
- Displays two platform cards (Discord, WhatsApp) showing connection status
- Discord card: shows token input field when disconnected, "Connect" button, bot username when connected
- WhatsApp card: shows "Connect" button that triggers QR code flow. Listens for `qr` events from the store and renders QR code using the `qrcode` package (raw QR data passed from main, rendered client-side)
- Both cards: "Disconnect" button when connected, error display with actionable message
- Uses signals from `ChannelStore` (`discord()`, `whatsapp()`, `loading()`)

- [ ] **Step 3: Run typecheck**

Run: `npx tsc --noEmit`
Expected: PASS

- [ ] **Step 4: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/renderer/app/features/channels/
git commit -m "feat(channels): add Angular channel connections component and routes"
```

---

## Task 14: Angular UI — Channel Messages & Settings Components

**Files:**
- Create: `src/renderer/app/features/channels/components/channel-messages/channel-messages.component.ts`
- Create: `src/renderer/app/features/channels/components/channel-settings/channel-settings.component.ts`

- [ ] **Step 1: Create Channel Messages component**

Create `src/renderer/app/features/channels/components/channel-messages/channel-messages.component.ts`. Standalone, OnPush:

- Injects `ChannelStore`
- Chat-style message list from `store.messages()` signal
- Groups by platform/chat, shows sender name, timestamp, content
- Shows which instance handled each message and the response
- Click a message navigates to instance detail view (using Angular Router)
- Filters: by platform dropdown, time range

- [ ] **Step 2: Create Channel Settings component**

Create `src/renderer/app/features/channels/components/channel-settings/channel-settings.component.ts`. Standalone, OnPush:

- Injects `ChannelStore`
- Per-platform section showing:
  - Allowed senders list (display name + sender ID, revoke button)
  - Access policy mode toggle (pairing / allowlist / disabled)
  - Pairing code input field + "Pair" button
- Calls `store.pairSender(platform, code)` on pair action

- [ ] **Step 3: Wire routes into app router**

Add the channels routes to the app's main router configuration. Find the existing route definitions (likely in `src/renderer/app/app.routes.ts` or similar) and add:

```typescript
{
  path: 'channels',
  loadChildren: () =>
    import('./features/channels/channels.routes')
      .then(m => m.CHANNELS_ROUTES),
},
```

- [ ] **Step 4: Run typecheck (both configs)**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS

- [ ] **Step 5: Run lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/renderer/app/features/channels/ src/renderer/app/app.routes.ts
git commit -m "feat(channels): add messages view, settings view, and route wiring"
```

---

## Task 15: Final Full Verification

- [ ] **Step 1: Run all channel tests**

Run: `npx vitest run src/main/channels/`
Expected: All tests pass

- [ ] **Step 2: Run full typecheck (both configs)**

Run: `npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json`
Expected: PASS

- [ ] **Step 3: Run full lint**

Run: `npm run lint`
Expected: PASS

- [ ] **Step 4: Run full test suite**

Run: `npm run test`
Expected: No regressions

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: PASS — production build succeeds with new dependencies

- [ ] **Step 6: Final commit**

Only if there were issues to fix:
```bash
git add -A
git commit -m "feat(channels): final verification pass"
```
