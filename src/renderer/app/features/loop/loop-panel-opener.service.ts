import { Injectable, signal } from '@angular/core';

/**
 * One pending "open the Loop config panel for this chat" request.
 *
 * `id` is unique per `open()` call so the consumer (typically the input
 * panel) can detect new requests even when the surrounding signal value
 * happens to be structurally identical to a previously-handled one — for
 * example when the user clicks "Reattempt" twice on the same past run.
 */
export interface LoopPanelOpenRequest {
  /** Monotonic per-call id. */
  readonly id: string;
  /** Chat / instance id this request targets. The host ignores requests
   *  for other chats so we don't accidentally open someone else's panel. */
  readonly chatId: string;
  /** Iteration-0 goal to seed into the host's message textarea. Empty when
   *  the past run had no distinct goal (in which case the seed prompt
   *  alone is enough — it'll be reused for both iter 0 and iter 1+). */
  readonly seedMessage?: string;
  /** Iteration-1+ continuation directive to seed into the panel's prompt
   *  textarea. Required for the request to be useful — without it the
   *  panel would just fall back to recall/default. */
  readonly seedPrompt?: string;
  /** Where the request came from, for telemetry / debugging. */
  readonly source: 'reattempt-past-run' | 'manual';
}

/**
 * Cross-component bridge between the loop-control panel ("Past loop
 * prompts" rows) and the input-panel that hosts the Loop config panel.
 *
 * The two components live as siblings under instance-detail / chat-detail
 * and don't share a parent that already coordinates them. Instead of
 * threading callbacks through every parent variant, components publish
 * requests through this singleton; the input-panel watches the signal,
 * applies the seed to its textarea + the loop-config panel, and consumes
 * the request so it doesn't fire twice.
 */
@Injectable({ providedIn: 'root' })
export class LoopPanelOpenerService {
  private readonly _pending = signal<LoopPanelOpenRequest | null>(null);
  private nextId = 1;

  /** Read-only view of the current pending request (or null). */
  readonly pending = this._pending.asReadonly();

  /**
   * Publish a new "open loop panel" request. Always allocates a fresh id
   * so the host's effect re-fires even if the same prompt is reattempted
   * back-to-back.
   */
  open(
    chatId: string,
    opts: {
      seedMessage?: string;
      seedPrompt?: string;
      source?: LoopPanelOpenRequest['source'];
    } = {},
  ): void {
    if (!chatId) return;
    this._pending.set({
      id: `lpo-${this.nextId++}`,
      chatId,
      seedMessage: opts.seedMessage,
      seedPrompt: opts.seedPrompt,
      source: opts.source ?? 'manual',
    });
  }

  /**
   * Consume the current request if it targets `chatId`. Returns the
   * request if consumed, or null if there's nothing pending or the
   * pending request is for a different chat (don't steal another chat's
   * request when the wrong instance is on screen).
   */
  consume(chatId: string): LoopPanelOpenRequest | null {
    const current = this._pending();
    if (!current || current.chatId !== chatId) return null;
    this._pending.set(null);
    return current;
  }

  /** Test seam — drop any pending request without consuming it. */
  _resetForTesting(): void {
    this._pending.set(null);
    this.nextId = 1;
  }
}
