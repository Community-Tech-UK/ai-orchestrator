/**
 * Defer Decision Store - Manages permission decision files for hook/resume communication.
 *
 * When the orchestrator user approves or denies a deferred tool use, this store writes
 * a JSON file keyed by tool_use_id. When the CLI is resumed and the PreToolUse hook is
 * re-invoked, the hook reads the decision file to return `allow` or `deny` instead of
 * `defer` again.
 *
 * Decision directory is communicated to the hook via the ORCHESTRATOR_DECISION_DIR
 * environment variable.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getLogger } from '../../logging/logger';

const logger = getLogger('DeferDecisionStore');

export class DeferDecisionStore {
  private static instance: DeferDecisionStore;
  private decisionDir: string;

  private constructor() {
    this.decisionDir = join(tmpdir(), 'orchestrator-decisions');
    this.ensureDecisionDir();
  }

  static getInstance(): DeferDecisionStore {
    if (!DeferDecisionStore.instance) {
      DeferDecisionStore.instance = new DeferDecisionStore();
    }
    return DeferDecisionStore.instance;
  }

  /** Reset singleton for testing */
  static _resetForTesting(): void {
    if (DeferDecisionStore.instance) {
      DeferDecisionStore.instance.cleanup();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    DeferDecisionStore.instance = undefined as any;
  }

  /**
   * Write a decision file for a specific deferred tool use.
   * File: <decisionDir>/<toolUseId>.json
   *
   * VALIDATED: The hook receives tool_use_id on both initial invocation and resume.
   * Using tool_use_id as the filename ensures exact matching on resume.
   *
   * decision='modify': stored as permissionDecision='allow' with an additional
   * `updatedInput` field carrying the replacement tool input. The CLI hook emits
   * this field in its reply so that (when/if the Claude CLI honors updatedInput in
   * a PreToolUse hook reply) the tool runs with the modified input instead of the
   * original. Absent CLI support, the hook degrades to a plain allow.
   */
  writeDecision(
    toolUseId: string,
    decision: 'allow' | 'deny' | 'modify',
    reason?: string,
    updatedInput?: Record<string, unknown>,
  ): void {
    this.ensureDecisionDir();
    const filePath = join(this.decisionDir, `${toolUseId}.json`);

    // 'modify' is expressed to the hook as 'allow' + updatedInput. The modify
    // semantics live at the orchestrator layer; the CLI only understands allow/deny.
    const storedDecision = decision === 'modify' ? 'allow' : decision;
    const defaultReason =
      decision === 'allow' || decision === 'modify' ? 'User approved' : 'User denied';

    const payload: Record<string, unknown> = {
      permissionDecision: storedDecision,
      reason: reason ?? defaultReason,
      timestamp: Date.now(),
    };
    if (decision === 'modify' && updatedInput !== undefined) {
      payload['updatedInput'] = updatedInput;
    }

    writeFileSync(filePath, JSON.stringify(payload), 'utf-8');
    logger.info('Decision file written', { toolUseId, decision: storedDecision, filePath });
  }

  /**
   * Clean up all decision files in the decision directory.
   * Called after a successful resume or when the store is no longer needed.
   */
  cleanup(): void {
    try {
      if (existsSync(this.decisionDir)) {
        rmSync(this.decisionDir, { recursive: true, force: true });
        logger.debug('Decision directory cleaned up', { decisionDir: this.decisionDir });
      }
    } catch (err) {
      logger.warn('Failed to clean up decision directory', {
        decisionDir: this.decisionDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Get the decision directory path (set as ORCHESTRATOR_DECISION_DIR env var) */
  getDecisionDir(): string {
    this.ensureDecisionDir();
    return this.decisionDir;
  }

  private ensureDecisionDir(): void {
    if (!existsSync(this.decisionDir)) {
      mkdirSync(this.decisionDir, { recursive: true });
    }
  }
}

/** Convenience getter */
export function getDeferDecisionStore(): DeferDecisionStore {
  return DeferDecisionStore.getInstance();
}
