import { Injectable, signal } from '@angular/core';

/** One request to put the caret in a particular session's message box. */
export interface ComposerFocusRequest {
  /**
   * The `instanceId` the target composer is bound to: a live session id,
   * `'new'` for the new-session draft, or a history preview id.
   */
  readonly target: string;
}

/**
 * Lets the places that open a session (the session list, new-session actions,
 * a just-started session) ask for its message box to take focus.
 *
 * The request is held until the matching composer is on screen, because the
 * composer for the target is often not mounted yet when the request is made
 * (opening the new-session screen, or the first message starting a session).
 * Only the latest request counts.
 */
@Injectable({ providedIn: 'root' })
export class ComposerFocusService {
  private readonly pendingRequest = signal<ComposerFocusRequest | null>(null);
  readonly pending = this.pendingRequest.asReadonly();

  request(target: string): void {
    this.pendingRequest.set({ target });
  }

  /** Clears `request` if it is still the pending one. */
  consume(request: ComposerFocusRequest): void {
    if (this.pendingRequest() === request) {
      this.pendingRequest.set(null);
    }
  }
}
