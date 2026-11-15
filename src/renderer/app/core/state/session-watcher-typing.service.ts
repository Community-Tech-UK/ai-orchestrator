/**
 * Tells main when the user is typing in a session or has a message queued for it, so the session watcher holds its
 * reply instead of talking over them.
 *
 * A session counts as being typed in when its message box has text that changed in the last two minutes, or when
 * messages typed during the turn are still queued to send. A draft left alone for longer holds nothing, so a
 * forgotten half-typed message cannot switch the watcher off for that session. While the hold is true it is
 * re-reported, at most once every 30 seconds per session; when it stops, main is told to release at once.
 * Nothing is reported while "Keep sessions going without me" is off or flag-only, because the watcher sends no
 * replies then.
 */
import { DestroyRef, Injectable, Injector, effect, inject, untracked } from '@angular/core';
import { DraftService } from '../services/draft.service';
import { SessionWatcherIpcService } from '../services/ipc/session-watcher-ipc.service';
import { InstanceStateService } from './instance/instance-state.service';
import { SettingsStore } from './settings.store';

export const TYPING_HOLD_MS = 2 * 60_000;
export const TYPING_REPORT_INTERVAL_MS = 30_000;

@Injectable({ providedIn: 'root' })
export class SessionWatcherTypingReporter {
  private readonly drafts = inject(DraftService);
  private readonly ipc = inject(SessionWatcherIpcService);
  private readonly instanceState = inject(InstanceStateService);
  private readonly settings = inject(SettingsStore);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  /** Sessions with a hold in force, and when it was last reported. */
  private readonly reportedAt = new Map<string, number>();
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    effect(() => {
      // Re-check when a draft changes, a queue changes or the setting changes; the timer covers the passing of time.
      this.drafts.textVersion();
      this.instanceState.messageQueue();
      this.settings.get('keepSessionsGoing');
      untracked(() => this.evaluate());
    }, { injector: this.injector });
    const timer = setInterval(() => this.evaluate(), TYPING_REPORT_INTERVAL_MS);
    this.destroyRef.onDestroy(() => clearInterval(timer));
  }

  private evaluate(): void {
    const level = this.settings.get('keepSessionsGoing');
    if (level === 'off' || level === 'flag-only') {
      this.reportedAt.clear();
      return;
    }
    const now = Date.now();
    const queues = this.instanceState.messageQueue();
    const sessions = new Set<string>(this.reportedAt.keys());
    for (const key of this.drafts.getAllDraftKeys()) if (this.instanceState.getInstance(key)) sessions.add(key);
    for (const [id, queue] of queues) if (queue.length > 0) sessions.add(id);
    for (const id of sessions) {
      const changedAt = this.drafts.lastChangeAt(id);
      const typing = (changedAt !== undefined && now - changedAt < TYPING_HOLD_MS) || (queues.get(id)?.length ?? 0) > 0;
      const last = this.reportedAt.get(id);
      if (typing) {
        if (last !== undefined && now - last < TYPING_REPORT_INTERVAL_MS) continue;
        this.reportedAt.set(id, now);
        void this.ipc.reportTyping({ instanceId: id, untilMs: now + TYPING_HOLD_MS });
      } else if (last !== undefined) {
        this.reportedAt.delete(id);
        void this.ipc.reportTyping({ instanceId: id, untilMs: 0 });
      }
    }
  }
}
