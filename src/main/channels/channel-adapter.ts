/**
 * Channel Adapter - Base class for platform adapters
 */

import { EventEmitter } from 'events';
import type {
  ChannelPlatform,
  ChannelConnectionStatus,
  ChannelConfig,
  ChannelInboundWatermark,
  InboundChannelMessage,
  SendOptions,
  SentMessage,
  PairedSender,
  AccessPolicy,
  PendingPairing,
  ChannelStatusEvent,
  ChannelErrorEvent,
} from '../../shared/types/channels';

export interface ChannelAutocompleteChoice {
  name: string;
  value: string;
}

export interface ChannelAutocompleteRequest {
  platform: ChannelPlatform;
  chatId: string;
  senderId: string;
  senderName: string;
  commandName: string;
  focusedName: string;
  focusedValue: string;
  options: Record<string, string>;
  respond: (choices: ChannelAutocompleteChoice[]) => Promise<void>;
}

export interface ChannelAdapterEvents {
  message: [InboundChannelMessage];
  autocomplete: [ChannelAutocompleteRequest];
  status: [ChannelStatusEvent];
  error: [ChannelErrorEvent];
  qr: [string]; // QR code data (WhatsApp only)
}

export abstract class BaseChannelAdapter extends EventEmitter {
  abstract readonly platform: ChannelPlatform;
  protected _status: ChannelConnectionStatus = 'disconnected';
  protected accessPolicy: AccessPolicy = {
    mode: 'pairing',
    allowedSenders: [],
    pendingPairings: [],
    maxPending: 3,
    codeExpiryMs: 60 * 60 * 1000, // 1 hour
  };

  /**
   * Per-chat inbound intake state (B6 idempotent delivery + watermark). Bounded
   * per chat; the number of distinct chats is naturally small (paired senders).
   */
  private readonly inboundWatermarks = new Map<string, ChannelInboundWatermark>();
  private static readonly INBOUND_DEDUP_PER_CHAT = 256;

  get status(): ChannelConnectionStatus {
    return this._status;
  }

  // Lifecycle
  abstract connect(config: ChannelConfig): Promise<void>;
  abstract disconnect(): Promise<void>;

  // Messaging
  abstract sendMessage(chatId: string, content: string, options?: SendOptions): Promise<SentMessage>;
  abstract sendFile(chatId: string, filePath: string, caption?: string): Promise<SentMessage>;
  abstract editMessage(chatId: string, messageId: string, content: string): Promise<void>;
  abstract addReaction(chatId: string, messageId: string, emoji: string): Promise<void>;

  /**
   * Human-friendly name for this machine's bot instance, if configured.
   * Platforms that support it (Discord) override this; others return undefined.
   */
  getDisplayName(): string | undefined {
    return undefined;
  }

  // Access control
  getAccessPolicy(): AccessPolicy {
    return { ...this.accessPolicy };
  }

  setAccessPolicy(policy: AccessPolicy): void {
    this.accessPolicy = { ...policy };
  }

  protected isSenderAllowed(senderId: string): boolean {
    if (this.accessPolicy.mode === 'disabled') return false;
    return this.accessPolicy.allowedSenders.includes(senderId);
  }

  protected handlePairingRequest(senderId: string, senderName: string): PendingPairing | null {
    if (this.accessPolicy.mode !== 'pairing') return null;

    // Check if already pending
    const existing = this.accessPolicy.pendingPairings.find(p => p.senderId === senderId);
    if (existing && existing.expiresAt > Date.now()) return existing;

    // Prune expired first
    this.accessPolicy.pendingPairings = this.accessPolicy.pendingPairings.filter(
      p => p.expiresAt > Date.now()
    );

    // Check max pending
    if (this.accessPolicy.pendingPairings.length >= this.accessPolicy.maxPending) return null;

    // Generate 6-char hex code
    const code = Math.random().toString(16).substring(2, 8).toUpperCase();
    const pending: PendingPairing = {
      code,
      senderId,
      senderName,
      expiresAt: Date.now() + this.accessPolicy.codeExpiryMs,
    };
    this.accessPolicy.pendingPairings.push(pending);
    return pending;
  }

  async pairSender(code: string): Promise<PairedSender> {
    const normalized = code.trim().toUpperCase();
    const index = this.accessPolicy.pendingPairings.findIndex(
      p => p.code === normalized && p.expiresAt > Date.now()
    );
    if (index === -1) {
      throw new Error('Invalid or expired pairing code');
    }
    const pending = this.accessPolicy.pendingPairings[index];
    this.accessPolicy.pendingPairings.splice(index, 1);
    this.accessPolicy.allowedSenders.push(pending.senderId);

    return {
      senderId: pending.senderId,
      senderName: pending.senderName,
      platform: this.platform,
      pairedAt: Date.now(),
    };
  }

  protected setStatus(status: ChannelConnectionStatus, extra?: Partial<ChannelStatusEvent>): void {
    this._status = status;
    this.emit('status', {
      platform: this.platform,
      status,
      ...extra,
    } satisfies ChannelStatusEvent);
  }

  protected emitError(error: string, recoverable: boolean): void {
    this.emit('error', {
      platform: this.platform,
      error,
      recoverable,
    } satisfies ChannelErrorEvent);
  }

  /**
   * Split a long message into chunks that fit platform limits.
   * Splits at paragraph boundaries first, then newlines, then spaces, then hard cut.
   */
  protected chunkMessage(content: string, maxLength: number): string[] {
    if (content.length <= maxLength) return [content];

    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      let splitAt = -1;

      // Try paragraph boundary
      const paraIdx = remaining.lastIndexOf('\n\n', maxLength);
      if (paraIdx > 0) {
        splitAt = paraIdx;
      }

      // Try newline
      if (splitAt === -1) {
        const nlIdx = remaining.lastIndexOf('\n', maxLength);
        if (nlIdx > 0) splitAt = nlIdx;
      }

      // Try space
      if (splitAt === -1) {
        const spaceIdx = remaining.lastIndexOf(' ', maxLength);
        if (spaceIdx > 0) splitAt = spaceIdx;
      }

      // Hard cut
      if (splitAt === -1) splitAt = maxLength;

      chunks.push(remaining.substring(0, splitAt));
      remaining = remaining.substring(splitAt).trimStart();
    }

    return chunks;
  }

  /**
   * Idempotent inbound intake (B6). Concrete adapters MUST route inbound messages
   * through this instead of emitting `'message'` directly: it dedups by the
   * platform message id (per chat, FIFO-bounded) so a reconnect/replay can't
   * re-route an already-handled message, advances the per-chat watermark, and
   * only then emits `'message'`.
   *
   * @returns `true` if the message was accepted and emitted, `false` if it was a
   *          duplicate and suppressed.
   */
  protected emitInboundMessage(msg: InboundChannelMessage): boolean {
    if (!this.acceptInbound(msg)) {
      return false;
    }
    this.emit('message', msg);
    return true;
  }

  /**
   * Record an inbound message against the per-chat watermark. Returns `false`
   * when the message's id was already seen for that chat (duplicate intake).
   */
  private acceptInbound(msg: InboundChannelMessage): boolean {
    const chatId = msg.chatId;
    const dedupId = msg.messageId || msg.id;
    let wm = this.inboundWatermarks.get(chatId);
    if (!wm) {
      wm = { chatId, recentIds: [], lastTimestamp: 0, processedCount: 0 };
      this.inboundWatermarks.set(chatId, wm);
    }

    if (dedupId && wm.recentIds.includes(dedupId)) {
      return false;
    }

    if (dedupId) {
      wm.recentIds.push(dedupId);
      if (wm.recentIds.length > BaseChannelAdapter.INBOUND_DEDUP_PER_CHAT) {
        wm.recentIds.shift();
      }
    }
    if (msg.timestamp >= wm.lastTimestamp) {
      wm.lastTimestamp = msg.timestamp;
      wm.lastMessageId = dedupId || undefined;
    }
    wm.processedCount += 1;
    return true;
  }

  /**
   * Observable inbound watermark for a chat (diagnostics / "attached from" UIs).
   * Returns a defensive copy, or `undefined` if no inbound has been seen.
   */
  getInboundWatermark(chatId: string): ChannelInboundWatermark | undefined {
    const wm = this.inboundWatermarks.get(chatId);
    return wm ? { ...wm, recentIds: [...wm.recentIds] } : undefined;
  }

  /**
   * Clear inbound dedup state. Call when a deliberate full replay is wanted
   * (e.g. an operator-requested resync); by default state persists across
   * reconnects so replays stay idempotent.
   */
  protected resetInboundWatermark(chatId?: string): void {
    if (chatId) {
      this.inboundWatermarks.delete(chatId);
    } else {
      this.inboundWatermarks.clear();
    }
  }
}
