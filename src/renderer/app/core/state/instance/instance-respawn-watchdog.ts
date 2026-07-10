/**
 * Respawn timeout watchdog.
 *
 * Split out of instance.store.ts. Tracks per-instance recovery timers: if an
 * instance stays in an interrupt/respawn state longer than RESPAWN_TIMEOUT_MS,
 * it is force-terminated and restarted so the user isn't stuck with an
 * unresponsive session. Owned by InstanceStore, which passes its dependencies
 * via the constructor and calls `clearAll()` on destroy.
 */
import type { InstanceStatus } from './instance.types';
import type { InstanceStateService } from './instance-state.service';
import type { InstanceListStore } from './instance-list.store';
import { isInterruptRecoveryStatus } from './instance-messaging-queue-utils';

export class RespawnWatchdog {
  private readonly respawnTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly RESPAWN_TIMEOUT_MS = 15_000;

  constructor(
    private readonly stateService: InstanceStateService,
    private readonly listStore: InstanceListStore,
  ) {}

  /**
   * Start or clear the recovery timeout when status changes.
   */
  update(instanceId: string, newStatus: InstanceStatus): void {
    // Clear any existing timer when status changes
    const existing = this.respawnTimers.get(instanceId);
    if (existing) {
      clearTimeout(existing);
      this.respawnTimers.delete(instanceId);
    }

    if (isInterruptRecoveryStatus(newStatus)) {
      const timer = setTimeout(() => {
        this.respawnTimers.delete(instanceId);
        const inst = this.stateService.getInstance(instanceId);
        const stillRecovering = inst && isInterruptRecoveryStatus(inst.status);
        if (stillRecovering) {
          console.error('Interrupt recovery timeout: force-terminating stuck instance', { instanceId });
          this.listStore.terminateInstance(instanceId).then(() =>
            this.listStore.restartInstance(instanceId)
          ).catch((err) => {
            console.error('Interrupt recovery timeout recovery failed', err);
          });
        }
      }, RespawnWatchdog.RESPAWN_TIMEOUT_MS);
      this.respawnTimers.set(instanceId, timer);
    }
  }

  /** Clear all pending timers (call on store destroy). */
  clearAll(): void {
    for (const timer of this.respawnTimers.values()) {
      clearTimeout(timer);
    }
    this.respawnTimers.clear();
  }
}
