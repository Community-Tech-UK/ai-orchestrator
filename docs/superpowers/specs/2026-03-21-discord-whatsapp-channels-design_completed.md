# Discord & WhatsApp Channels for AI Orchestrator

**Date**: 2026-03-21
**Status**: Approved

## v1 Scope

Implementation ships the **full abstraction layer** (ChannelManager, ChannelAdapter interface, ChannelMessageRouter, rate limiter, persistence, IPC handlers, Zod schemas, Angular UI) with **Discord as the only concrete adapter**. WhatsApp types are defined (`ChannelPlatform = 'discord' | 'whatsapp'`) but no WhatsApp adapter code ships in v1. This validates the architecture with a real adapter while keeping WhatsApp as a clean plug-in follow-up.

## Problem

The Orchestrator can only be controlled from the Electron UI or terminal. Users want to send tasks and receive results from Discord and WhatsApp — turning their messaging apps into remote controls for the Orchestrator.

## Goals

- Send a message from Discord or WhatsApp, have the Orchestrator execute it (spawn agents, run tasks), and stream results back to the chat
- Support DMs (private tasks) and channels/groups (shared work)
- Direct execution — no approval gate; messages are acted on immediately
- Both platforms land simultaneously behind a shared abstraction
- Pairing-based access control to prevent unauthorized use

## Non-Goals

- MCP channel protocol compatibility (we're building native services, not MCP servers)
- WhatsApp Business API in v1 (whatsapp-web.js first, Business API as a future adapter swap)
- Approval/confirmation gates (direct execution only for v1)
- Telegram support in v1 (trivial to add later via the adapter interface)

## Architecture

### Overview

```
Discord / WhatsApp
       |
       v
+----------------------------------------------+
|            Electron Main Process              |
|                                               |
|  ChannelManager (singleton)                   |
|    +-- DiscordAdapter    (discord.js)         |
|    +-- WhatsAppAdapter   (whatsapp-web.js)    |
|    +-- ... future adapters                    |
|           |                                   |
|           v                                   |
|    ChannelMessageRouter                       |
|    (access gate -> parse -> route -> execute) |
|           |                                   |
|           v                                   |
|    InstanceManager / Orchestration            |
|    (spawn agents, run tasks, stream results)  |
|                                               |
|  IPC Handlers (channel-handlers.ts)           |
|    <-> Angular Renderer                       |
|  Channels Panel / Messages / Settings         |
+----------------------------------------------+
```

### Key Components

#### 1. ChannelManager (singleton)

Location: `src/main/channels/channel-manager.ts`

Manages all channel adapters. Responsible for:
- Registering/unregistering adapters
- Forwarding inbound messages to the ChannelMessageRouter
- Tracking connection status across all platforms
- Persisting channel config (tokens, allowlists) via SettingsManager
- Forwarding events to the Angular UI via `webContents.send()` (see Event Wiring)

```typescript
class ChannelManager {
  private static instance: ChannelManager;
  private adapters = new Map<ChannelPlatform, ChannelAdapter>();
  private router: ChannelMessageRouter;

  static getInstance(): ChannelManager { ... }
  static _resetForTesting(): void { ... }

  registerAdapter(adapter: ChannelAdapter): void;
  unregisterAdapter(platform: ChannelPlatform): void;
  getAdapter(platform: ChannelPlatform): ChannelAdapter | undefined;
  getAllStatuses(): Map<ChannelPlatform, ChannelConnectionStatus>;
  shutdown(): Promise<void>;
}

// Convenience getter
export function getChannelManager(): ChannelManager {
  return ChannelManager.getInstance();
}
```

#### 2. BaseChannelAdapter (abstract class)

Location: `src/main/channels/channel-adapter.ts`

The contract every platform implements. Follows the `BaseCliAdapter extends EventEmitter` pattern:

```typescript
// Typed event signatures
interface ChannelAdapterEvents {
  'message': (msg: InboundChannelMessage) => void;
  'status': (status: ChannelConnectionStatus) => void;
  'error': (error: Error) => void;
  'qr': (qrData: string) => void;  // WhatsApp only
}

abstract class BaseChannelAdapter extends EventEmitter {
  abstract readonly platform: ChannelPlatform;
  abstract readonly status: ChannelConnectionStatus;

  // Lifecycle
  abstract connect(config: ChannelConfig): Promise<void>;
  abstract disconnect(): Promise<void>;

  // Messaging
  abstract sendMessage(chatId: string, content: string, options?: ChannelSendOptions): Promise<ChannelSentMessage>;
  abstract sendFile(chatId: string, filePath: string, caption?: string): Promise<ChannelSentMessage>;
  abstract editMessage(chatId: string, messageId: string, content: string): Promise<void>;
  abstract addReaction(chatId: string, messageId: string, emoji: string): Promise<void>;

  // Access control
  abstract getAccessPolicy(): AccessPolicy;
  abstract setAccessPolicy(policy: AccessPolicy): void;
  abstract pairSender(code: string): Promise<PairedSender>;

  // Typed emit/on overrides
  override emit<K extends keyof ChannelAdapterEvents>(event: K, ...args: Parameters<ChannelAdapterEvents[K]>): boolean;
  override on<K extends keyof ChannelAdapterEvents>(event: K, listener: ChannelAdapterEvents[K]): this;
}
```

All types (`ChannelSendOptions`, `ChannelSentMessage`, `PairedSender`, etc.) are defined once in `src/shared/types/channels.ts` and imported by both the adapter and consumer code.

**Adapters are lazily imported** via dynamic `import()` to avoid loading discord.js (~2MB) or whatsapp-web.js (~5MB) until the user actually enables that channel. This aligns with the project's progressive loading approach (skills system).

#### 3. DiscordAdapter

Location: `src/main/channels/adapters/discord-adapter.ts`

- Uses `discord.js` (^14.x) with Gateway intents: DirectMessages, Guilds, GuildMessages, MessageContent
- Connects via bot token (entered in UI or config)
- Listens on `client.on('messageCreate')` -> access gate -> emit `message` event
- Sends replies via Discord API, chunked at 2000 chars at paragraph boundaries
- Typing indicator on message receipt
- Supports threads for conversation continuity

#### 4. WhatsAppAdapter

Location: `src/main/channels/adapters/whatsapp-adapter.ts`

- Uses `whatsapp-web.js` (^1.x) with `LocalAuth` strategy for session persistence
- **Must use `puppeteer-core`** (not full `puppeteer`) to avoid bundling Chromium
- Connects via QR code scan (QR data emitted as `qr` event, rendered in Angular UI)
- Uses system Chrome via `PUPPETEER_EXECUTABLE_PATH` env var
- **Fallback behavior**: If system Chrome is not found, the adapter emits an `error` event with a clear message ("Chrome/Chromium not found. Install Chrome or set PUPPETEER_EXECUTABLE_PATH") and stays in `disconnected` status. The Angular UI displays this error with a help link.
- Listens on `client.on('message')` -> access gate -> emit `message` event
- Sends replies via WhatsApp Web API, chunked at 65536 chars
- Supports quoted replies for conversation continuity

**Build configuration**: `whatsapp-web.js` and `puppeteer-core` must be added to Electron Builder's `externals` list in `package.json` so they are not bundled into the asar archive (they have dynamic file requirements).

### Reconnection Strategy

Adapters handle reconnection internally. Discord's `discord.js` Client has built-in auto-reconnect with backoff — the adapter relies on this and surfaces status changes via `status` events. If `discord.js` gives up (e.g., invalid token, revoked bot), the adapter transitions to `error` status and emits a `ChannelErrorEvent` with `recoverable: false`.

For manual reconnects (user clicks "Reconnect" in UI), `ChannelManager.reconnect(platform)` calls `adapter.disconnect()` then `adapter.connect(config)`.

### Error Codes

IPC handlers return typed error codes for consistent client handling:

| Code | When |
|------|------|
| `CHANNEL_CONNECT_FAILED` | Adapter failed to connect (bad token, network, etc.) |
| `CHANNEL_NOT_CONNECTED` | Operation attempted on disconnected adapter |
| `CHANNEL_ADAPTER_UNAVAILABLE` | Platform dependency failed to import |
| `CHANNEL_SEND_FAILED` | Message send failed (network, rate limit, etc.) |
| `CHANNEL_PAIR_INVALID` | Pairing code not found or expired |
| `CHANNEL_PAIR_EXPIRED` | Pairing code expired |
| `CHANNEL_UNAUTHORIZED` | Sender not in allowlist |
| `CHANNEL_RATE_LIMITED` | Sender exceeded rate limit |

#### 5. ChannelMessageRouter

Location: `src/main/channels/channel-message-router.ts`

Routes inbound messages to instances:

1. **Access gate** — checks sender against allowlist, rejects unauthorized
2. **Rate limit** — sliding window rate limiter (max 10 messages/minute/sender), shared utility in `src/main/channels/rate-limiter.ts`
3. **Parse intent** — strips bot mention prefix (Discord `<@BOT_ID>` format), then extracts routing hints from message text
4. **Route**:
   - Default: create a new instance, send message as task
   - Reply/thread: look up original instance via `thread_id` in `channel_messages` table
   - `@instance-3 ...`: explicit instance targeting
   - `@all ...`: broadcast to all active instances
   - Multi-agent keywords ("use N agents", "debate", "verify"): delegate to orchestration coordinators
5. **Execute** — delivers message to instance(s)
6. **Stream results** — subscribes to `instance:output`, batches on 2-second debounce, sends back through adapter

**Inbound attachment handling:**
- Discord: attachments listed in message metadata; downloaded lazily to `~/.orchestrator/channels/discord/inbox/` only when an instance needs them (Discord CDN URLs persist)
- WhatsApp: attachments downloaded eagerly on receipt to `~/.orchestrator/channels/whatsapp/inbox/` (WhatsApp has no history API to fetch them later). Path passed to instance as context.

Result delivery UX:
- Immediate reaction on receipt
- Batched output chunks during execution
- Final complete message (or file attachment if >2000/65536 chars)
- Swap reaction to checkmark on success, X on error

#### 6. IPC Handlers

Location: `src/main/ipc/handlers/channel-handlers.ts`

New IPC domain exposing channel operations to the renderer.

**IPC Channel Constants** (added to `IPC_CHANNELS` in `src/shared/types/ipc.types.ts`):

```typescript
// Channel management (request/response via ipcMain.handle)
CHANNEL_CONNECT: 'channel:connect',
CHANNEL_DISCONNECT: 'channel:disconnect',
CHANNEL_GET_STATUS: 'channel:get-status',
CHANNEL_GET_MESSAGES: 'channel:get-messages',
CHANNEL_SEND_MESSAGE: 'channel:send-message',
CHANNEL_PAIR_SENDER: 'channel:pair-sender',
CHANNEL_SET_ACCESS_POLICY: 'channel:set-access-policy',
CHANNEL_GET_ACCESS_POLICY: 'channel:get-access-policy',

// Channel push events (main -> renderer via webContents.send)
CHANNEL_STATUS_CHANGED: 'channel:status-changed',
CHANNEL_MESSAGE_RECEIVED: 'channel:message-received',
CHANNEL_RESPONSE_SENT: 'channel:response-sent',
CHANNEL_ERROR: 'channel:error',
```

**Handler registration** follows the existing pattern — `registerChannelHandlers()` is exported from `src/main/ipc/handlers/index.ts` and called in `IpcMainHandler.registerHandlers()` in `src/main/ipc/ipc-main-handler.ts`:

```typescript
// In ipc-main-handler.ts registerHandlers():
registerChannelHandlers({ windowManager: this.windowManager });
```

**Push events** use the existing `webContents.send()` pattern (same as cost-handlers, mcp-handlers):

```typescript
// In channel-handlers.ts:
const mainWindow = windowManager.getMainWindow();
mainWindow?.webContents.send(IPC_CHANNELS.CHANNEL_STATUS_CHANGED, {
  platform: 'discord',
  status: 'connected',
  botUsername: 'MyBot#1234'
});

mainWindow?.webContents.send(IPC_CHANNELS.CHANNEL_ERROR, {
  platform: 'whatsapp',
  error: 'Chrome/Chromium not found',
  recoverable: true
});
```

#### 7. Angular UI

**Store location**: `src/renderer/app/core/state/channel.store.ts` (following existing convention — all stores live in `core/state/`)

**Feature module**: `src/renderer/app/features/channels/`

Three views:

**Channel Connections Panel:**
- Platform cards showing connection status (disconnected/connecting/connected/error)
- Discord: token input modal -> connected state with bot username
- WhatsApp: QR code rendered live from `qr` events -> connected state with phone number
- Disconnect button, error display with actionable messages

**Channel Messages View:**
- Chat-style message list grouped by platform/chat
- Shows inbound messages, handling instance, response sent back
- Click message -> navigate to instance detail view
- Filter by platform, chat, time range

**Channel Settings:**
- Per-platform allowed senders list (view, add, revoke)
- Access policy mode toggle (pairing / allowlist / disabled)
- Rate limit configuration

### Data Model

```typescript
type ChannelPlatform = 'discord' | 'whatsapp';
type ChannelConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

interface ChannelConfig {
  platform: ChannelPlatform;
  token?: string;              // Discord bot token
  allowedSenders: string[];
  allowedChats: string[];      // Empty = DMs only
}

interface InboundChannelMessage {
  id: string;                  // UUID
  platform: ChannelPlatform;
  chatId: string;
  messageId: string;
  threadId?: string;           // Discord thread ID or WhatsApp quoted-message chain ID
  senderId: string;
  senderName: string;
  content: string;
  attachments: ChannelAttachment[];
  isGroup: boolean;
  isDM: boolean;
  replyTo?: string;
  timestamp: number;
}

interface ChannelResponse {
  channelMessageId: string;    // Links back to inbound message
  instanceId: string;          // Which instance handled it
  content: string;
  files?: string[];            // File paths to send back
  status: 'streaming' | 'complete' | 'error';
}

// ChannelSendOptions, ChannelSentMessage, PairedSender defined above in BaseChannelAdapter section
// (single definition in src/shared/types/channels.ts, imported everywhere)

interface ChannelSendOptions {
  replyTo?: string;            // Platform message ID to reply to
  splitAt?: number;            // Override default chunk size
}

interface ChannelSentMessage {
  messageId: string;           // Platform message ID of the sent message
  chatId: string;
  timestamp: number;
}

interface PairedSender {
  senderId: string;            // Platform user ID
  senderName: string;
  platform: ChannelPlatform;
  pairedAt: number;
}

interface AccessPolicy {
  mode: 'pairing' | 'allowlist' | 'disabled';
  allowedSenders: string[];
  pendingPairings: PendingPairing[];
  maxPending: number;          // Default: 3
  codeExpiryMs: number;        // Default: 3600000 (1 hour)
}

interface PendingPairing {
  code: string;
  senderId: string;
  senderName: string;
  expiresAt: number;
}

interface ChannelAttachment {
  name: string;
  type: string;
  size: number;
  url?: string;                // Remote URL (Discord CDN, etc.)
  localPath?: string;          // Local path after download
}

// Push event payloads (main -> renderer via webContents.send)
interface ChannelStatusEvent {
  platform: ChannelPlatform;
  status: ChannelConnectionStatus;
  botUsername?: string;         // Discord bot name
  phoneNumber?: string;        // WhatsApp connected number
}

interface ChannelErrorEvent {
  platform: ChannelPlatform;
  error: string;
  recoverable: boolean;
}
```

### Zod Schemas

Location: `src/shared/validation/channel-schemas.ts`

```typescript
import { z } from 'zod';

const ChannelPlatformSchema = z.enum(['discord', 'whatsapp']);

export const ChannelConnectPayloadSchema = z.object({
  platform: ChannelPlatformSchema,
  token: z.string().min(1).max(500).optional(), // Discord bot token; WhatsApp uses QR
});

export const ChannelDisconnectPayloadSchema = z.object({
  platform: ChannelPlatformSchema,
});

export const ChannelGetMessagesPayloadSchema = z.object({
  platform: ChannelPlatformSchema,
  chatId: z.string().min(1).max(200),
  limit: z.number().int().min(1).max(100).optional().default(50),
  before: z.number().int().optional(), // timestamp cursor for pagination
});

export const ChannelSendMessagePayloadSchema = z.object({
  platform: ChannelPlatformSchema,
  chatId: z.string().min(1).max(200),
  content: z.string().min(1).max(65536),
  replyTo: z.string().max(200).optional(),
});

export const ChannelPairSenderPayloadSchema = z.object({
  platform: ChannelPlatformSchema,
  code: z.string().length(6).regex(/^[0-9a-f]+$/), // 6-char hex code
});

export const ChannelGetStatusPayloadSchema = z.object({
  platform: ChannelPlatformSchema.optional(), // omit to get all platforms
});

export const ChannelGetAccessPolicyPayloadSchema = z.object({
  platform: ChannelPlatformSchema,
});

export const ChannelSetAccessModePayloadSchema = z.object({
  platform: ChannelPlatformSchema,
  mode: z.enum(['pairing', 'allowlist', 'disabled']),
});

export type ValidatedChannelConnectPayload = z.infer<typeof ChannelConnectPayloadSchema>;
export type ValidatedChannelPairSenderPayload = z.infer<typeof ChannelPairSenderPayloadSchema>;
```

### Persistence

#### SQLite Migration

Added as a new entry in the `MIGRATIONS` array in `src/main/persistence/rlm/rlm-schema.ts`, following the existing `NNN_name` pattern:

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
}
```

The `thread_id` column maps Discord thread IDs and WhatsApp quoted-message chains to enable conversation-to-instance routing. The router queries `SELECT DISTINCT instance_id FROM channel_messages WHERE thread_id = ? ORDER BY timestamp DESC LIMIT 1` to resolve continuity.

Channel config (tokens, allowlists) stored via `getSettingsManager()` (electron-store), not in SQLite.

#### Persistence API

Location: `src/main/channels/channel-persistence.ts`

```typescript
class ChannelPersistence {
  insertMessage(msg: InboundChannelMessage, direction: 'inbound' | 'outbound', instanceId?: string): void;
  getMessages(platform: ChannelPlatform, chatId: string, opts?: { limit?: number; before?: number }): StoredChannelMessage[];
  getInstanceForThread(threadId: string): string | undefined;
  getMessagesByInstance(instanceId: string): StoredChannelMessage[];
  deleteOlderThan(timestampMs: number): number;  // returns count deleted
}

export function getChannelPersistence(): ChannelPersistence;
```

Uses the existing RLM database connection from `getRlmDatabase()`.

## Security

### Access Control

- **Pairing flow**: Unknown sender DMs bot -> bot replies with 6-char hex code -> user enters code in Orchestrator UI -> sender added to allowlist
- **Allowlist enforcement**: Only allowlisted sender IDs reach the router; all others silently dropped
- **Group messages**: Require `@bot` mention to prevent accidental triggers
- **Max 3 pending pairing codes**, expire after 1 hour
- **Rate limiting**: Sliding window, max 10 inbound messages per minute per sender (shared `RateLimiter` utility in `src/main/channels/rate-limiter.ts`)

### Data Protection

- Bot never sends config files, tokens, `.env` content, or state directory files through channels. An `assertSendable(path)` guard in `channel-message-router.ts` checks outbound file paths against a deny-list:
  - Files matching `.env*`, `*.pem`, `*.key`, `credentials.*`, `secrets.*`
  - Paths inside `~/.orchestrator/`, `~/.claude/`, `node_modules/`
  - Any path flagged by the existing `SecretDetector` from `src/main/security/`
  - Message content is also scanned by `SecretDetector` for tokens/API keys before sending
- WhatsApp message content not persisted by default (configurable) for privacy
- Tokens stored via `getSettingsManager()` (electron-store, encrypted at rest on supported platforms)

## Dependencies

| Package | Version | Purpose | Size Impact |
|---------|---------|---------|-------------|
| `discord.js` | ^14.x | Discord Gateway + REST API | ~2MB |
| `whatsapp-web.js` | ^1.x | WhatsApp Web bridge | ~5MB |
| `puppeteer-core` | ^22.x | Headless Chrome for whatsapp-web.js (no bundled Chromium) | ~3MB |
| `qrcode` | ^1.x | QR code generation for Angular UI | ~200KB |

**Lazy loading**: Both `discord.js` and `whatsapp-web.js` are loaded via dynamic `import()` only when the user enables the respective channel.

**Graceful degradation**: If a platform's dependency fails to import (e.g., native module build failure, optional dep not installed), the adapter emits an `error` event and the ChannelManager marks that platform as unavailable. The UI shows "Discord unavailable: [reason]" but WhatsApp (and vice versa) continues to work independently.

**Electron Builder config**: `whatsapp-web.js` and `puppeteer-core` must be added to `externals` in the build config so they are excluded from asar packaging.

## File Structure

```
src/main/channels/
+-- index.ts                           # Exports, singleton init, getChannelManager()
+-- channel-manager.ts                 # ChannelManager singleton
+-- channel-adapter.ts                 # ChannelAdapter interface + shared types
+-- channel-message-router.ts          # Routing logic
+-- channel-persistence.ts             # SQLite queries (uses RLM database)
+-- rate-limiter.ts                    # Sliding window rate limiter utility
+-- adapters/
|   +-- discord-adapter.ts             # Discord implementation
|   +-- whatsapp-adapter.ts            # WhatsApp implementation
+-- __tests__/
    +-- channel-manager.spec.ts
    +-- channel-message-router.spec.ts
    +-- rate-limiter.spec.ts
    +-- discord-adapter.spec.ts
    +-- whatsapp-adapter.spec.ts

src/main/ipc/handlers/
+-- channel-handlers.ts                # New IPC domain

src/shared/types/
+-- channels.ts                        # Shared type definitions

src/shared/validation/
+-- channel-schemas.ts                 # Zod schemas for IPC payloads

src/preload/
+-- preload.ts                         # Add channel IPC channels

src/renderer/app/core/state/
+-- channel.store.ts                   # Signal-based state (follows existing pattern)

src/renderer/app/core/services/ipc/
+-- channel-ipc.service.ts            # IPC bridge service (follows existing *-ipc.service.ts pattern)

src/renderer/app/features/channels/
+-- channels.routes.ts                 # Route definitions
+-- components/
|   +-- channel-connections/           # Connection cards + QR display
|   +-- channel-messages/              # Chat-style message view
|   +-- channel-settings/              # Access policy management
```

## Integration Points

### Startup (src/main/index.ts)

```typescript
import { getChannelManager } from './channels';

// During app initialization
const channelManager = getChannelManager();

// During shutdown
await channelManager.shutdown();
```

### IPC Handler Registration (src/main/ipc/ipc-main-handler.ts)

```typescript
// In imports:
import { registerChannelHandlers } from './handlers';

// In registerHandlers():
registerChannelHandlers({ windowManager: this.windowManager });
```

Also add `registerChannelHandlers` to the barrel export in `src/main/ipc/handlers/index.ts`.

### Preload Bridge

Add ~12 new IPC channels to `src/preload/preload.ts`:
- 8 request/response channels (ipcRenderer.invoke)
- 4 push event channels (ipcRenderer.on)

### Event Wiring

ChannelManager subscribes to:
- `instance:output` — for streaming results back to channels
- `instance:state-update` — for completion/error detection

ChannelManager pushes to renderer via `webContents.send()`:
- `channel:status-changed` — connection state changes (ChannelStatusEvent payload)
- `channel:message-received` — inbound messages (InboundChannelMessage payload)
- `channel:response-sent` — outbound responses (ChannelResponse payload)
- `channel:error` — adapter errors (ChannelErrorEvent payload)

## Testing Strategy

**Mocking approach:**
- Discord: Mock `discord.js` `Client` class — mock `login()`, `on('messageCreate')`, channel methods
- WhatsApp: Mock `whatsapp-web.js` `Client` class — mock `initialize()`, `on('qr')`, `on('message')`, send methods
- Both mocks are injected via constructor parameter or module-level mock in vitest

**Test coverage by file:**
- `channel-manager.spec.ts`: Adapter registration/unregistration, status tracking, graceful shutdown, lazy import failure handling
- `channel-message-router.spec.ts`: Access gate (allowed/blocked/rate-limited), intent parsing, routing (default/thread/explicit/broadcast), result batching
- `rate-limiter.spec.ts`: Sliding window behavior, per-sender isolation, window reset
- `discord-adapter.spec.ts`: Connection lifecycle, message receive/send, chunking at 2000 chars, thread support, pairing flow
- `whatsapp-adapter.spec.ts`: QR code flow, connection lifecycle, message receive/send, Chrome-not-found error, LocalAuth persistence

## Future Considerations

- **WhatsApp Business API adapter**: Swap `whatsapp-web.js` for official API when needed. Same `ChannelAdapter` interface, different internals.
- **Telegram adapter**: Trivial to add — `grammy` library, same adapter pattern.
- **Slack adapter**: Same pattern, different library.
- **Approval mode**: Configurable per-channel — some channels auto-execute, others require confirmation. Add `autoExecute` to `ChannelConfig` when needed.
- **MCP channel bridge**: Optionally expose adapters as MCP channel servers for child CLI instances.
- **File/image handling**: Forward code diffs, screenshots, and generated files back through channels.
- **Message archival**: Periodic cleanup of old channel_messages rows (e.g., older than 30 days).
