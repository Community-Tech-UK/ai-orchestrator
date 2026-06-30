/**
 * B12 — Workflow lifecycle projection unit tests.
 *
 * These tests are intentionally EXHAUSTIVE: every member of each source enum is
 * asserted. Combined with the `assertNever` exhaustive switches in the projection,
 * a new status added to any source enum forces both a compile error (in the
 * projection) and a visible gap here.
 */

import { describe, it, expect } from 'vitest';
import type { LoopStatus } from './loop.types';
import type { AutomationRunStatus } from './automation.types';
import type { InstanceStatus } from './instance.types';
import {
  loopStatusToPhase,
  automationRunStatusToPhase,
  instanceStatusToPhase,
  isTerminalPhase,
  isActivePhase,
  WORKFLOW_TERMINAL_STATES,
  type WorkflowLifecyclePhase,
} from './workflow-lifecycle.types';

describe('workflow lifecycle projection', () => {
  describe('terminal-phase predicates', () => {
    const terminal: WorkflowLifecyclePhase[] = ['completed', 'failed', 'cancelled'];
    const nonTerminal: WorkflowLifecyclePhase[] = ['pending', 'running', 'paused', 'blocked'];

    it('classifies terminal phases', () => {
      for (const p of terminal) {
        expect(isTerminalPhase(p)).toBe(true);
        expect(isActivePhase(p)).toBe(false);
      }
    });

    it('classifies non-terminal phases', () => {
      for (const p of nonTerminal) {
        expect(isTerminalPhase(p)).toBe(false);
        expect(isActivePhase(p)).toBe(true);
      }
    });

    it('exports exactly the terminal states', () => {
      expect([...WORKFLOW_TERMINAL_STATES].sort()).toEqual(['cancelled', 'completed', 'failed']);
    });
  });

  describe('loopStatusToPhase', () => {
    const cases: Record<LoopStatus, WorkflowLifecyclePhase> = {
      running: 'running',
      paused: 'paused',
      'provider-limit': 'paused',
      completed: 'completed',
      'completed-needs-review': 'completed',
      cancelled: 'cancelled',
      failed: 'failed',
      error: 'failed',
      'no-progress': 'failed',
      'cap-reached': 'failed',
      'cost-exceeded': 'failed',
      'needs-human-arbitration': 'failed',
      'reviewer-unreliable': 'failed',
      'reviewer-unavailable': 'failed',
      'builder-unreliable': 'failed',
    };

    it.each(Object.entries(cases))('maps %s -> %s', (status, phase) => {
      expect(loopStatusToPhase(status as LoopStatus)).toBe(phase);
    });

    it('treats provider-limit as resumable, not terminal', () => {
      expect(isTerminalPhase(loopStatusToPhase('provider-limit'))).toBe(false);
    });

    it('treats completed-needs-review as a successful terminal', () => {
      expect(loopStatusToPhase('completed-needs-review')).toBe('completed');
    });

    it('treats ping-pong deadlock and reviewer fault statuses as failed terminals', () => {
      expect(isTerminalPhase(loopStatusToPhase('cost-exceeded'))).toBe(true);
      expect(isTerminalPhase(loopStatusToPhase('needs-human-arbitration'))).toBe(true);
      expect(isTerminalPhase(loopStatusToPhase('reviewer-unreliable'))).toBe(true);
      expect(isTerminalPhase(loopStatusToPhase('reviewer-unavailable'))).toBe(true);
      expect(isTerminalPhase(loopStatusToPhase('builder-unreliable'))).toBe(true);
    });
  });

  describe('automationRunStatusToPhase', () => {
    const cases: Record<AutomationRunStatus, WorkflowLifecyclePhase> = {
      pending: 'pending',
      running: 'running',
      succeeded: 'completed',
      failed: 'failed',
      skipped: 'cancelled',
      cancelled: 'cancelled',
    };

    it.each(Object.entries(cases))('maps %s -> %s', (status, phase) => {
      expect(automationRunStatusToPhase(status as AutomationRunStatus)).toBe(phase);
    });
  });

  describe('instanceStatusToPhase', () => {
    const cases: Record<InstanceStatus, WorkflowLifecyclePhase> = {
      initializing: 'pending',
      ready: 'running',
      idle: 'running',
      busy: 'running',
      processing: 'running',
      thinking_deeply: 'running',
      interrupting: 'running',
      cancelling: 'running',
      'interrupt-escalating': 'running',
      respawning: 'running',
      waking: 'running',
      waiting_for_input: 'blocked',
      waiting_for_permission: 'blocked',
      degraded: 'blocked',
      hibernating: 'paused',
      hibernated: 'paused',
      terminated: 'completed',
      error: 'failed',
      failed: 'failed',
      cancelled: 'cancelled',
      superseded: 'cancelled',
    };

    it.each(Object.entries(cases))('maps %s -> %s', (status, phase) => {
      expect(instanceStatusToPhase(status as InstanceStatus)).toBe(phase);
    });
  });
});
