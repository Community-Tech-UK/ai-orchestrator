/**
 * Decision 16(b) — the single place that decides a session may be terminated.
 *
 * The confirmation started life as local state inside
 * `instance-list.component.ts`, which made it reachable from exactly one entry
 * point: the row's × button. That was not the only way to end a session. The
 * `close-instance` action — bound to **Cmd+W** by default
 * (`keybinding.types.ts`, context `global`) — called `store.terminateInstance`
 * directly from `dashboard.component.ts`, so the most reflexive keystroke on a
 * Mac ended a session instantly and irreversibly with no warning at all. A
 * component-local guard cannot cover an action dispatched from another
 * component, and the spec that claimed "exactly one path" only counted call
 * sites inside that one file, so it could not see the gap.
 *
 * Hoisting the intent into a root-provided store makes "ask first" a property of
 * terminating rather than a property of one button. The dialog itself is mounted
 * once at app level for the same reason: the sidebar that hosts the instance
 * list is collapsible, so a dialog rendered inside it would silently do nothing
 * whenever the sidebar was hidden — a keystroke that appears to be ignored is
 * its own defect.
 */
import { Injectable, computed, inject, signal } from '@angular/core';

import { InstanceStore } from '../../core/state/instance.store';

@Injectable({ providedIn: 'root' })
export class TerminateConfirmStore {
  private readonly instances = inject(InstanceStore);

  private readonly pending = signal<string | null>(null);

  /** The session awaiting confirmation, or null when nothing is pending. */
  readonly pendingId = this.pending.asReadonly();

  /**
   * Name for the prompt. Falls back to "this session" rather than showing a raw
   * id: an id in a destructive prompt tells the reader nothing about what they
   * are about to lose.
   */
  readonly pendingName = computed(() => {
    const id = this.pending();
    if (!id) return '';
    return this.instances.instances().find((i) => i.id === id)?.displayName ?? 'this session';
  });

  /** Ask before terminating. Every entry point goes through here. */
  request(instanceId: string): void {
    this.pending.set(instanceId);
  }

  confirm(): void {
    const id = this.pending();
    if (!id) return;
    this.pending.set(null);
    void this.instances.terminateInstance(id);
  }

  cancel(): void {
    this.pending.set(null);
  }
}
