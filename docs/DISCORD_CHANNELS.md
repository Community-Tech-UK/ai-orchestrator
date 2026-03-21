# Discord Channels — Implementation Guide

Control the Orchestrator remotely by sending messages to a Discord bot. The bot spawns CLI instances, runs your tasks, and streams results back to Discord.

## Prerequisites

### 1. Create a Discord Bot

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application**, name it (e.g. "Orchestrator Bot")
3. Go to **Bot** tab:
   - Click **Reset Token** and save the token somewhere safe
   - Enable **Message Content Intent** (required for reading message text)
4. Go to **OAuth2 > URL Generator**:
   - Scopes: `bot`
   - Bot Permissions: `Send Messages`, `Read Message History`, `Add Reactions`, `Manage Messages`
5. Copy the generated URL, open it, and invite the bot to your server

### 2. Required Intents

The bot uses these Gateway Intents (configured automatically):

| Intent | Why |
|--------|-----|
| Guilds | See server structure |
| GuildMessages | Receive messages in channels |
| DirectMessages | Receive DMs for pairing |
| MessageContent | Read message text (privileged — must enable in portal) |

If the bot connects but ignores messages, **Message Content Intent** is almost certainly not enabled in the developer portal.

## Connecting

### Via the UI

1. Navigate to the **Channels** page in the Orchestrator
2. Paste your bot token into the **Bot Token** field
3. Click **Connect**
4. The status dot turns green when connected, showing the bot's username

### Programmatically (IPC)

```typescript
const response = await electronAPI.channelConnect({
  platform: 'discord',
  token: 'your-bot-token',
});
```

## Access Control

The bot won't respond to random users. Three access modes control who can interact:

### Pairing Mode (default)

New users DM the bot → receive a 6-character hex code → you enter the code in the Orchestrator UI to approve them.

**Flow:**
1. Unknown user sends any DM to the bot
2. Bot replies: `Your pairing code is: a3f1b2`
3. In the Orchestrator UI, enter the code in **Sender Pairing** and click **Pair Sender**
4. That user can now send commands

**Limits:** Max 3 pending pairing codes at once. Codes expire after 1 hour.

### Allowlist Mode

Only pre-approved Discord user IDs can interact. Set via the **Access Policy** dropdown in the UI. You manage the list programmatically through the IPC API.

### Disabled Mode

Anyone can send commands. **Not recommended** for shared servers.

## Sending Commands

### Basic Message

Send a message in any channel where the bot is present. **In servers, you must @mention the bot.** In DMs, no mention needed.

```
@OrchestratorBot fix the login bug in auth.ts
```

The bot:
1. Reacts with ⏳ (processing)
2. Creates a new CLI instance named `Discord-YourName`
3. Sends your message to the instance
4. Streams the response back to Discord (batched every 2 seconds)
5. Reacts with ✅ (success) or ❌ (error)

### Target a Specific Instance

Prefix with `@instance-id` or `@DisplayName` to route to an existing instance:

```
@OrchestratorBot @inst-abc123 what's the status of that refactor?
```

The `@instance-id` must match either the instance's ID or display name (no spaces in the name for this to work).

### Broadcast to All Instances

Prefix with `@all` to send to every active instance:

```
@OrchestratorBot @all stop what you're doing and run tests
```

### Thread Routing

When a message is in a Discord thread, the bot checks if that thread was previously associated with an instance. If so, follow-up messages in the same thread go to the same instance automatically.

## Message Chunking

Discord limits messages to 2000 characters. When a response exceeds this, the bot splits it into multiple messages automatically.

## Security

### Outbound Content Scanning

Before sending any response back to Discord, the router runs `assertSendable()` which:

1. **Secret detection** — Scans for API keys, tokens, passwords, private keys, connection strings, and credentials using 49 regex patterns + entropy analysis
2. **Sensitive file paths** — Blocks content referencing `.env*`, `*.pem`, `*.key`, `credentials.*`, and paths inside `~/.orchestrator/` or `~/.claude/`

If a response contains sensitive content, the bot sends `[Response blocked: contains sensitive content]` instead.

### Rate Limiting

Each sender is rate-limited to 10 messages per minute (sliding window). Excess messages are silently dropped.

## Architecture

```
Discord Server
  └── Bot receives message
        └── DiscordAdapter (discord.js client)
              ├── Strips @bot mention from content
              ├── Access control (pairing / allowlist / disabled)
              └── Emits 'message' event
                    └── ChannelMessageRouter
                          ├── Rate limit check
                          ├── Persist inbound message (SQLite)
                          ├── Parse intent (@all, @instance, thread, new)
                          ├── Route to InstanceManager
                          └── streamResults()
                                ├── Subscribe to instance:output
                                ├── Debounce 2s batches
                                ├── assertSendable() security check
                                └── Send back via adapter
```

### Key Files

| File | Role |
|------|------|
| `src/main/channels/adapters/discord-adapter.ts` | Discord.js integration |
| `src/main/channels/channel-manager.ts` | Adapter registry singleton |
| `src/main/channels/channel-message-router.ts` | Intent parsing, routing, streaming |
| `src/main/channels/channel-persistence.ts` | SQLite message storage |
| `src/main/channels/rate-limiter.ts` | Per-sender sliding window |
| `src/main/channels/channel-adapter.ts` | Abstract base class |
| `src/main/ipc/handlers/channel-handlers.ts` | IPC handler registration |
| `src/renderer/app/features/channels/channels-page.component.ts` | Angular UI |
| `src/renderer/app/core/state/channel.store.ts` | Signal-based state |

### IPC Channels

**Request/Response** (renderer → main):

| Channel | Purpose |
|---------|---------|
| `channel:connect` | Connect to a platform |
| `channel:disconnect` | Disconnect |
| `channel:get-status` | Get connection status |
| `channel:get-messages` | Query stored messages |
| `channel:send-message` | Send a message to a chat |
| `channel:pair-sender` | Pair a sender by code |
| `channel:get-access-policy` | Get current access policy |
| `channel:set-access-policy` | Change access mode |

**Push Events** (main → renderer):

| Channel | Purpose |
|---------|---------|
| `channel:status-changed` | Connection status update |
| `channel:message-received` | New inbound message |
| `channel:response-sent` | Outbound response sent |
| `channel:error` | Error event |

### Data Storage

Messages are stored in the `channel_messages` SQLite table (migration `006`):

```sql
CREATE TABLE channel_messages (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  thread_id TEXT,
  sender_id TEXT NOT NULL,
  sender_name TEXT NOT NULL,
  content TEXT NOT NULL,
  direction TEXT NOT NULL,        -- 'inbound' | 'outbound'
  instance_id TEXT,
  reply_to_message_id TEXT,
  timestamp INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
```

## Extending: Adding a New Platform

The channel system is designed for multiple platforms. To add WhatsApp (or another platform):

1. Create a new adapter extending `BaseChannelAdapter` in `src/main/channels/adapters/`
2. Implement all abstract methods: `connect`, `disconnect`, `sendMessage`, `sendFile`, `editMessage`, `addReaction`, `getAccessPolicy`, `setAccessPolicy`, `pairSender`
3. Register it in `ChannelManager` at startup
4. Add the platform to the `ChannelPlatform` type union in `src/shared/types/channels.ts`
5. Update the Channels page UI to show the new platform's connection card

No changes needed to the router, persistence, rate limiter, or IPC layer — they're platform-agnostic.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| Bot connects but ignores messages | Message Content Intent not enabled | Enable it in Discord Developer Portal > Bot |
| Bot ignores server messages | Missing @mention | Bot requires `@BotName` in server channels |
| "Invalid pairing code" | Code expired or typo | Have user DM the bot again for a fresh code |
| Messages sent but no response | Instance busy or errored | Check instance status in the Orchestrator UI |
| "[Response blocked]" reply | Outbound content contained secrets | Expected behavior — check the instance output directly in the Orchestrator UI |
| Rate limited silently | >10 messages/minute from one sender | Wait and retry; the window slides |
| Connection error on startup | Bad token or network issue | Verify token, check internet; status will show 'error' |
