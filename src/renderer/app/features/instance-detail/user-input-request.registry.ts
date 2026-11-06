/**
 * The message box asks this before it sends: is an agent waiting on a question
 * for this session? If so, the typed text is the answer. Only question cards
 * register here; approvals never do, so typing cannot allow a tool.
 */

import { Injectable, signal } from '@angular/core';

/** What happened to text offered to a waiting question. */
export type QuestionOfferResult =
  /** The reply was delivered and the card is closed. */
  | 'answered'
  /** A card with several questions took the text and is waiting for the rest. */
  | 'partial'
  /** Delivery failed. The card is still open and says why; keep the text. */
  | 'failed'
  /** A reply for the same card is still being delivered. */
  | 'busy'
  /** Nothing is waiting for this text, so it is an ordinary message. */
  | 'not-applicable';

export interface QuestionCardHandle {
  requestId: string;
  instanceId: string;
  /** When the question arrived; the oldest open question is answered first. */
  createdAt: number;
  /** Takes the typed text for this card. */
  answer(text: string): Promise<QuestionOfferResult>;
}

@Injectable({ providedIn: 'root' })
export class UserInputRequestRegistry {
  private readonly byOwner = new Map<object | string, readonly QuestionCardHandle[]>();
  private readonly inFlight = new Set<string>();
  private readonly revision = signal(0);

  /** Replaces everything one list of cards has registered. Call it whenever that list changes. */
  replace(owner: object | string, handles: readonly QuestionCardHandle[]): void {
    if (handles.length === 0) this.byOwner.delete(owner);
    else this.byOwner.set(owner, handles);
    this.revision.update(value => value + 1);
  }

  /** Reactive presence check for controls that must never answer over a question. */
  hasWaitingQuestion(instanceId: string): boolean {
    this.revision();
    return this.oldestWaiting(instanceId) !== undefined;
  }

  /** Offers typed text to the oldest question waiting on this session. */
  async offer(instanceId: string, text: string): Promise<QuestionOfferResult> {
    const reply = text.trim();
    const next = this.oldestWaiting(instanceId);
    if (!reply || !next) return 'not-applicable';
    const key = JSON.stringify([instanceId, next.requestId]);
    if (this.inFlight.has(key)) return 'busy';
    this.inFlight.add(key);
    try {
      return await next.answer(reply);
    } catch (error) {
      // A card should report its own failures; a throw must still not cost the person their text.
      console.error('Question card could not take an answer from the message box:', error);
      return 'failed';
    } finally {
      this.inFlight.delete(key);
    }
  }

  /**
   * The message box's way in. Returns true when the text belongs to a waiting
   * question, so the box must not also send it. The box is cleared only once the
   * text was taken, and only if the person has not typed something else since.
   */
  async handleComposerText(
    instanceId: string,
    text: string,
    composer: { current: () => string; clear: () => void },
  ): Promise<boolean> {
    const result = await this.offer(instanceId, text);
    if ((result === 'answered' || result === 'partial') && composer.current().trim() === text.trim()) composer.clear();
    return result !== 'not-applicable';
  }

  private oldestWaiting(instanceId: string): QuestionCardHandle | undefined {
    let oldest: QuestionCardHandle | undefined;
    for (const handles of this.byOwner.values()) {
      for (const handle of handles) {
        if (handle.instanceId === instanceId && (!oldest || handle.createdAt < oldest.createdAt)) oldest = handle;
      }
    }
    return oldest;
  }
}
