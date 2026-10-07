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
      this.arm(instanceId, RespawnWatchdog.RESPAWN_TIMEOUT_MS);
    }
  }

  /**
   * A circuit-breaker backoff keeps status `respawning` for the whole wait.
   * The 15s stuck-session limit is measured from the end of that wait, so a
   * 30s-or-longer backoff is not treated as a hung interrupt.
   */
  private arm(instanceId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this.respawnTimers.delete(instanceId);
      const inst = this.stateService.getInstance(instanceId);
      if (!inst || !isInterruptRecoveryStatus(inst.status)) {
        return;
      }
      const wait = inst.waitReason;
      if (wait?.kind === 'backoff' && wait.retryAt > Date.now()) {
        const remainingMs = wait.retryAt - Date.now();
        this.arm(instanceId, remainingMs + RespawnWatchdog.RESPAWN_TIMEOUT_MS);
        return;
      }
      console.error('Interrupt recovery timeout: force-terminating stuck instance', { instanceId });
      this.listStore.terminateInstance(instanceId).then(() =>
        this.listStore.restartInstance(instanceId)
      ).catch((err) => {
        console.error('Interrupt recovery timeout recovery failed', err);
      });
    }, delayMs);
    this.respawnTimers.set(instanceId, timer);
  }

  /** Clear all pending timers (call on store destroy). */
  clearAll(): void {
    for (const timer of this.respawnTimers.values()) {
      clearTimeout(timer);
    }
    this.respawnTimers.clear();
  }
}
