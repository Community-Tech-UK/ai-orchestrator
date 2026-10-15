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
import { LoopStore } from '../../core/state/loop.store';
import { PlanQueueStore } from '../../core/state/plan-queue.store';

@Injectable({ providedIn: 'root' })
export class TerminateConfirmStore {
  private readonly instances = inject(InstanceStore);
  private readonly loops = inject(LoopStore);
  private readonly queue = inject(PlanQueueStore);

  private readonly pending = signal<{ kind: 'one'; instanceId: string } | { kind: 'all' } | null>(null);
  readonly isOpen = computed(() => this.pending() !== null);
  readonly isAll = computed(() => this.pending()?.kind === 'all');
  readonly allCount = computed(() => this.instances.instances().length);
  readonly queueWillPause = computed(() => this.isAll() && this.queue.allRuns().some(run => run.status === 'running'));
  readonly runningLoopCount = computed(() => {
    const ids = this.loops.runningChatIds();
    return this.isAll() ? this.instances.instances().filter(instance => ids.has(instance.id)).length : Number(ids.has(this.pendingId() ?? ''));
  });

  /** The session awaiting confirmation, or null when nothing is pending. */
  readonly pendingId = computed(() => { const pending = this.pending(); return pending?.kind === 'one' ? pending.instanceId : null; });

  /**
   * Name for the prompt. Falls back to "this session" rather than showing a raw
   * id: an id in a destructive prompt tells the reader nothing about what they
   * are about to lose.
   */
  readonly pendingName = computed(() => {
    const id = this.pendingId();
    if (!id) return '';
    return this.instances.instances().find((i) => i.id === id)?.displayName ?? 'this session';
  });

  /**
   * Whether closing this session leaves a thread behind in history.
   *
   * Only a root session does. `archiveRootConversation()` in
   * `instance-termination.ts` returns early when `parentId` is set, so a child
   * (subagent) session is closed without ever being archived — and the child
   * rows carry the same × button as their parent. An unknown id gets the
   * cautious answer: the prompt may under-promise, never over-promise.
   */
  readonly pendingIsArchived = computed(() => {
    const id = this.pendingId();
    if (!id) return false;
    const instance = this.instances.instances().find((i) => i.id === id);
    return instance ? !instance.parentId : false;
  });

  /** Ask before terminating. Every entry point goes through here. */
  request(instanceId: string): void {
    this.pending.set({ kind: 'one', instanceId });
  }

  requestAll(): void {
    if (this.allCount() > 0) this.pending.set({ kind: 'all' });
  }

  confirm(): void {
    const pending = this.pending();
    if (!pending) return;
    this.pending.set(null);
    if (pending.kind === 'all') void this.instances.terminateAllInstances();
    else void this.instances.terminateInstance(pending.instanceId);
  }

  cancel(): void {
    this.pending.set(null);
  }
}
