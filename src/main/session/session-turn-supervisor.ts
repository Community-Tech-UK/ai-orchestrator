/**
 * SessionTurnSupervisor — per-instance turn lifecycle owner.
 *
 * Phase 3 skeleton: tracks ownership counters that are currently scattered across
 * Instance fields and handler modules.  Behavior is additive — the existing guards
 * (adapterGeneration, restartEpoch, respawnPromise) remain on Instance and still
 * work independently; the supervisor adds the missing `interruptSeq` + `turnGeneration`
 * fences and the durable turn event journal.
 *
 * Future phases will route sendInput admission and recovery dispatch through here.
 */

import { getLogger } from '../logging/logger';
import { getSessionContinuityManagerIfInitialized } from './session-continuity';

const logger = getLogger('SessionTurnSupervisor');

export type TurnOutcome = 'completed' | 'interrupted' | 'cancelled' | 'failed';
export type ActiveOperation = 'idle' | 'turn' | 'interrupt' | 'respawn';

export interface SupervisorSnapshot {
  instanceId: string;
  turnGeneration: number;
  interruptSeq: number;
  adapterGeneration: number;
  restartEpoch: number;
  activeOperation: ActiveOperation;
}

export class SessionTurnSupervisor {
  private turnGeneration = 0;
  private interruptSeq = 0;
  private adapterGeneration = 0;
  private restartEpoch = 0;
  private activeOperation: ActiveOperation = 'idle';

  constructor(readonly instanceId: string) {}

  // ─── Adapter / respawn lifecycle ───────────────────────────────────────────

  recordAdapterSetup(adapterGeneration: number): void {
    this.adapterGeneration = adapterGeneration;
    this.activeOperation = 'idle';
    this.logTurnEvent('adapter_setup', { adapterGeneration });
  }

  recordRespawn(restartEpoch: number, adapterGeneration: number): void {
    this.restartEpoch = restartEpoch;
    this.adapterGeneration = adapterGeneration;
    this.activeOperation = 'idle';
    this.logTurnEvent('respawn_complete', { restartEpoch, adapterGeneration });
  }

  // ─── Turn lifecycle ─────────────────────────────────────────────────────────

  recordTurnStart(providerTurnId?: string): void {
    this.turnGeneration++;
    this.activeOperation = 'turn';
    this.logTurnEvent('turn_started', {
      turnGeneration: this.turnGeneration,
      providerTurnId: providerTurnId ?? null,
    });
  }

  recordTurnEnd(outcome: TurnOutcome): void {
    this.activeOperation = 'idle';
    this.logTurnEvent('turn_ended', {
      turnGeneration: this.turnGeneration,
      outcome,
    });
  }

  // ─── Interrupt lifecycle ────────────────────────────────────────────────────

  /**
   * Records an interrupt and returns the new `interruptSeq`.
   * Callers should capture this value; after awaiting respawn, verify that
   * `isCurrent(seq)` is still true before sending any wake-up nudge.
   */
  recordInterrupt(): number {
    this.interruptSeq++;
    this.activeOperation = 'interrupt';
    this.logTurnEvent('interrupt_recorded', { interruptSeq: this.interruptSeq });
    return this.interruptSeq;
  }

  /**
   * Returns true if the given interrupt seq is still the latest one — i.e., no
   * subsequent interrupt has been issued since this value was captured.
   */
  isInterruptSeqCurrent(seq: number): boolean {
    return seq === this.interruptSeq;
  }

  // ─── Snapshot ───────────────────────────────────────────────────────────────

  snapshot(): SupervisorSnapshot {
    return {
      instanceId: this.instanceId,
      turnGeneration: this.turnGeneration,
      interruptSeq: this.interruptSeq,
      adapterGeneration: this.adapterGeneration,
      restartEpoch: this.restartEpoch,
      activeOperation: this.activeOperation,
    };
  }

  // ─── Turn journal ───────────────────────────────────────────────────────────

  private logTurnEvent(type: string, payload: Record<string, unknown>): void {
    try {
      getSessionContinuityManagerIfInitialized()?.logTurnEvent(this.instanceId, type, payload);
    } catch {
      // Journal failures must not disrupt the main flow.
    }
  }
}

// ─── Per-instance registry ───────────────────────────────────────────────────

const registry = new Map<string, SessionTurnSupervisor>();

export function getOrCreateTurnSupervisor(instanceId: string): SessionTurnSupervisor {
  let supervisor = registry.get(instanceId);
  if (!supervisor) {
    supervisor = new SessionTurnSupervisor(instanceId);
    registry.set(instanceId, supervisor);
    logger.debug('SessionTurnSupervisor created', { instanceId });
  }
  return supervisor;
}

export function getTurnSupervisor(instanceId: string): SessionTurnSupervisor | undefined {
  return registry.get(instanceId);
}

export function deleteTurnSupervisor(instanceId: string): void {
  if (registry.delete(instanceId)) {
    logger.debug('SessionTurnSupervisor deleted', { instanceId });
  }
}

/** Remove all supervisors — call only from tests. */
export function _resetTurnSupervisorsForTesting(): void {
  registry.clear();
}
