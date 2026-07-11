/**
 * Zombie-busy status reconciler.
 *
 * Renderer instance status is partly optimistic — the messaging store flips an
 * instance to 'busy' before the main process confirms — and main-process
 * status updates are edge-triggered events. When main never leaves 'idle'
 * (for example a send wedged behind a recovering session that only settles at
 * termination), no event ever corrects the renderer and the tab shows a
 * spinner forever. Codex deliberately has no renderer send timeout
 * (see instance-messaging-send-utils.ts), so nothing else bounds that state.
 *
 * Every POLL_INTERVAL_MS this service compares suspicious renderer statuses
 * (active-turn or initializing) against the main process's authoritative
 * instance list and adopts the backend status once the same mismatch has been
 * seen on MISMATCH_CONFIRMATIONS consecutive polls. Freshly dispatched sends
 * are exempt for RECENT_SEND_GRACE_MS so the legitimate gap between renderer
 * dispatch and backend turn start is never clobbered.
 */
import { DestroyRef, Injectable, inject } from '@angular/core';
import { IpcFacadeService } from '../../services/ipc';
import { InstanceStateService } from './instance-state.service';
import { isActiveTurnStatus, isReadyForInputStatus } from './instance-messaging-queue-utils';
import type { InstanceStatus } from './instance.types';

const POLL_INTERVAL_MS = 15_000;
const MISMATCH_CONFIRMATIONS = 2;
const RECENT_SEND_GRACE_MS = 5 * 60_000;

/** Renderer statuses that show activity and can go stale without a backend turn. */
function isStaleSuspectStatus(status: InstanceStatus): boolean {
  return isActiveTurnStatus(status) || status === 'initializing';
}

@Injectable({ providedIn: 'root' })
export class InstanceStatusReconcilerService {
  private readonly stateService = inject(InstanceStateService);
  private readonly ipc = inject(IpcFacadeService);

  /** instanceId → Date.now() when the renderer dispatched a send IPC. */
  private readonly sendsInFlight = new Map<string, number>();
  /** "instanceId:rendererStatus:backendStatus" → consecutive mismatched polls. */
  private readonly mismatchStreaks = new Map<string, number>();
  private reconcileInFlight = false;

  constructor() {
    const pollTimer = setInterval(() => {
      this.reconcileOnce().catch((error: unknown) => {
        console.warn('InstanceStatusReconciler: reconcile pass failed', error);
      });
    }, POLL_INTERVAL_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(pollTimer));
  }

  /** Called by the messaging store when a send IPC is dispatched. */
  noteSendStarted(instanceId: string): void {
    this.sendsInFlight.set(instanceId, Date.now());
  }

  /** Called by the messaging store when a send IPC settles (success or failure). */
  noteSendSettled(instanceId: string): void {
    this.sendsInFlight.delete(instanceId);
  }

  /**
   * One reconcile pass. Exposed for tests; production runs it on the
   * constructor interval. Skips IPC entirely when nothing looks stale.
   */
  async reconcileOnce(): Promise<void> {
    if (this.reconcileInFlight) return;

    const suspects: { id: string; status: InstanceStatus }[] = [];
    for (const instance of this.stateService.state().instances.values()) {
      if (!isStaleSuspectStatus(instance.status)) continue;
      const sendStartedAt = this.sendsInFlight.get(instance.id);
      if (sendStartedAt !== undefined && Date.now() - sendStartedAt < RECENT_SEND_GRACE_MS) {
        continue;
      }
      suspects.push({ id: instance.id, status: instance.status });
    }
    if (suspects.length === 0) {
      this.mismatchStreaks.clear();
      return;
    }

    this.reconcileInFlight = true;
    try {
      const response = await this.ipc.listInstances();
      if (!response.success || !Array.isArray(response.data)) return;

      const backendStatuses = new Map<string, InstanceStatus>();
      for (const raw of response.data as Record<string, unknown>[]) {
        if (typeof raw['id'] === 'string' && typeof raw['status'] === 'string') {
          backendStatuses.set(raw['id'], raw['status'] as InstanceStatus);
        }
      }

      const confirmedKeys = new Set<string>();
      for (const suspect of suspects) {
        const backendStatus = backendStatuses.get(suspect.id);
        if (
          backendStatus === undefined
          || !isReadyForInputStatus(backendStatus)
          || backendStatus === suspect.status
        ) {
          continue;
        }

        const key = `${suspect.id}:${suspect.status}:${backendStatus}`;
        confirmedKeys.add(key);
        const streak = (this.mismatchStreaks.get(key) ?? 0) + 1;
        if (streak < MISMATCH_CONFIRMATIONS) {
          this.mismatchStreaks.set(key, streak);
          continue;
        }

        // The IPC round-trip is a race window: a real status event or a fresh
        // send may have landed since the suspects were snapshotted. Only adopt
        // the backend status if the instance is still exactly as observed.
        const current = this.stateService.getInstance(suspect.id);
        if (
          !current
          || current.status !== suspect.status
          || this.sendsInFlight.has(suspect.id)
        ) {
          this.mismatchStreaks.delete(key);
          confirmedKeys.delete(key);
          continue;
        }

        console.warn('InstanceStatusReconciler: adopting backend status for stale instance', {
          instanceId: suspect.id,
          rendererStatus: suspect.status,
          backendStatus,
        });
        this.stateService.updateInstance(suspect.id, { status: backendStatus });
        this.mismatchStreaks.delete(key);
        confirmedKeys.delete(key);
      }

      // Streaks must be consecutive: drop any that did not recur this poll.
      for (const key of this.mismatchStreaks.keys()) {
        if (!confirmedKeys.has(key)) {
          this.mismatchStreaks.delete(key);
        }
      }
    } finally {
      this.reconcileInFlight = false;
    }
  }
}
