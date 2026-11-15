/**
 * Sessions the session watcher has handed back to the user, plus the one per-session switch.
 *
 * Main keeps the flags and sends the whole list on every change, so this only replaces what it holds. Nothing
 * here decides anything: a flag is the agent's own question, shown with the choice of answering it.
 */
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import type { SessionWatcherFlagPayload } from '@contracts/schemas/session-watcher';
import { SessionWatcherIpcService } from '../services/ipc/session-watcher-ipc.service';
import { InstanceStateService } from './instance/instance-state.service';

@Injectable({ providedIn: 'root' })
export class SessionWatcherStore {
  private readonly ipc = inject(SessionWatcherIpcService);
  private readonly instanceState = inject(InstanceStateService);
  private readonly list = signal<readonly SessionWatcherFlagPayload[]>([]);
  private initialization: Promise<void> | null = null;
  private revision = 0;

  readonly flags = this.list.asReadonly();
  private readonly byInstance = computed(() => new Map(this.list().map((flag) => [flag.instanceId, flag] as const)));

  private unsubscribe: (() => void) | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.unsubscribe?.());
  }

  /** Starts listening, then reads the current list once. Safe to call more than once. */
  initialize(): Promise<void> {
    if (this.initialization) return this.initialization;
    this.unsubscribe = this.ipc.onFlagsChanged((flags) => {
      this.revision += 1;
      this.list.set(flags);
    });
    const revision = this.revision;
    this.initialization = this.ipc.listFlags().then((result) => {
      // A push that arrived while the list was being read is newer than the list.
      if (result.success && result.data && this.revision === revision) this.list.set(result.data);
    });
    return this.initialization;
  }

  flagFor(instanceId: string | undefined): SessionWatcherFlagPayload | undefined {
    return instanceId ? this.byInstance().get(instanceId) : undefined;
  }

  /** The user's own "Yes, go ahead". Returns an error message to show, or null once it was sent. */
  async answerYes(flag: Pick<SessionWatcherFlagPayload, 'instanceId' | 'requestCount'>): Promise<string | null> {
    const result = await this.ipc.answerYes({ instanceId: flag.instanceId, requestCount: flag.requestCount });
    // One fixed line: whatever went wrong, the next step for the user is the same.
    return result.success ? null : 'Your answer was not sent. Open the session to reply.';
  }

  /** Switches the watcher off or on for one session. The session in view shows the change at once. */
  async setMuted(instanceId: string, muted: boolean): Promise<string | null> {
    const result = await this.ipc.setMuted({ instanceId, muted });
    if (!result.success) return 'Could not change this session.';
    this.instanceState.updateInstance(instanceId, { watcherMuted: muted });
    return null;
  }
}
