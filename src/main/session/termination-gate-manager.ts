/**
 * TerminationGateManager — Pluggable pre-termination validation.
 *
 * Extracted from session-continuity.ts so gates can be tested and wired
 * independently. Gates are advisory (fail-open): they emit warnings but
 * never block shutdown.
 *
 * Inspired by codex-plugin-cc's stop-review-gate-hook pattern.
 */

import { EventEmitter } from 'events';
import type { SessionState } from './session-continuity';
import { getLogger } from '../logging/logger';

const logger = getLogger('TerminationGateManager');

export interface TerminationGateResult {
  /** Whether the gate allows termination to proceed. */
  pass: boolean;
  /** Human-readable reason (displayed when blocked). */
  reason?: string;
  /** Optional structured data (review findings, verification results, etc.). */
  data?: unknown;
}

export interface SessionTerminationGate {
  /** Unique name for logging/identification. */
  name: string;
  /**
   * Validate whether the session may terminate.
   * Receives the full session state; should return within `timeoutMs`.
   */
  validate(state: SessionState): Promise<TerminationGateResult>;
  /** Max time to wait for this gate (ms). Defaults to 60 000. */
  timeoutMs?: number;
}

export class TerminationGateManager extends EventEmitter {
  private gates: SessionTerminationGate[] = [];

  /** Register a gate that runs before termination. */
  registerGate(gate: SessionTerminationGate): void {
    this.gates.push(gate);
    logger.info('Registered termination gate', { name: gate.name });
  }

  /** Unregister a gate by name. */
  unregisterGate(name: string): void {
    this.gates = this.gates.filter((g) => g.name !== name);
  }

  /** Whether any gates are registered. */
  get hasGates(): boolean {
    return this.gates.length > 0;
  }

  /**
   * Run all registered termination gates for a session state.
   * Gates that time out return `{ pass: true }` (fail-open).
   */
  async runGates(state: SessionState): Promise<TerminationGateResult[]> {
    if (this.gates.length === 0) return [];

    const results: TerminationGateResult[] = [];
    for (const gate of this.gates) {
      const timeoutMs = gate.timeoutMs ?? 60_000;
      try {
        const result = await Promise.race([
          gate.validate(state),
          new Promise<TerminationGateResult>((resolve) =>
            setTimeout(() => resolve({ pass: true, reason: `Gate '${gate.name}' timed out after ${timeoutMs}ms` }), timeoutMs),
          ),
        ]);
        results.push(result);

        if (!result.pass) {
          logger.warn('Termination gate blocked', {
            gate: gate.name,
            instanceId: state.instanceId,
            reason: result.reason,
          });
          this.emit('gate:blocked', {
            gate: gate.name,
            instanceId: state.instanceId,
            result,
          });
        }
      } catch (error) {
        // Gates must not block shutdown — fail-open on errors
        logger.warn('Termination gate threw', {
          gate: gate.name,
          error: error instanceof Error ? error.message : String(error),
        });
        results.push({ pass: true, reason: `Gate '${gate.name}' error: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    return results;
  }
}
