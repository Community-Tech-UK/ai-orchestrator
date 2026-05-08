import { Injectable, signal } from '@angular/core';

/**
 * Tiny signal-based bus that the `mp` keybinding uses to ask any mounted
 * `<app-compact-model-picker>` to open its model trigger. Each picker
 * subscribes via an effect on `request()` and calls its own
 * `openModelMenu()` whenever the counter increments.
 *
 * If two pickers are mounted at once (sidebar new-chat form + chat-detail
 * compact picker), both will react to a single keybinding press; the user
 * can dismiss one with Esc. This is acknowledged in the spec; a focus-aware
 * filter is a v2 follow-up.
 */
@Injectable({ providedIn: 'root' })
export class ModelPickerFocusService {
  private readonly _request = signal(0);
  readonly request = this._request.asReadonly();

  requestOpen(): void {
    this._request.update((n) => n + 1);
  }
}
