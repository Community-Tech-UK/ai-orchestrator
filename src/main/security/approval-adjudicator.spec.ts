import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../db/sqlite-driver';

const settingsState = vi.hoisted(() => ({ approvalAdjudicationEnabled: false }));
const auxState = vi.hoisted(() => ({
  generateImpl: vi.fn(async () => ({
    text: '{"decision":"escalate","reason":"default fixture","riskLevel":"high"}',
    decision: {
      slot: 'approvalAdjudication',
      provider: 'local-fallback',
      source: 'fallback',
      reason: '',
      allowFrontierFallback: false,
    },
  })),
}));
const loopState = vi.hoisted(() => ({
  activeLoops: [] as { chatId: string; status: string; endedAt?: number | null }[],
}));
const notifyMock = vi.hoisted(() => ({ notify: vi.fn() }));
const dbState = vi.hoisted(() => ({ db: undefined as unknown }));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    get: (key: string) => (settingsState as Record<string, unknown>)[key],
  }),
}));
vi.mock('../rlm/auxiliary-llm-service', () => ({
  getAuxiliaryLlmService: () => ({ generate: auxState.generateImpl }),
}));
vi.mock('../orchestration/loop-coordinator', () => ({
  getLoopCoordinator: () => ({ getActiveLoops: () => loopState.activeLoops }),
}));
vi.mock('../notifications/notification-service', () => ({
  getNotificationService: () => notifyMock,
}));
vi.mock('../persistence/rlm-database', () => ({
  getRLMDatabase: () => ({ getRawDb: () => dbState.db }),
}));

import {
  adjudicate,
  cleanupAdjudicatorBreakerForInstance,
  isAdjudicatorBreakerTripped,
  maybeAdjudicateDeferredPermission,
  resetAdjudicatorBreaker,
  _resetApprovalAdjudicatorForTesting,
} from './approval-adjudicator';
import { DurableApprovalStore } from '../orchestration/durable-approval-store';
import type { PermissionRequest } from './permission-manager';

function bashRequest(instanceId = 'inst-1'): PermissionRequest {
  return {
    id: `req-${Math.random().toString(36).slice(2)}`,
    instanceId,
    scope: 'bash_execute',
    resource: 'bash:ls -la',
    timestamp: Date.now(),
  };
}

function verdictText(decision: string, reason = 'because', riskLevel = 'low'): string {
  return JSON.stringify({ decision, reason, riskLevel });
}

function textResult(text: string) {
  return {
    text,
    decision: {
      slot: 'approvalAdjudication' as const,
      provider: 'local-fallback' as const,
      source: 'fallback' as const,
      reason: '',
      allowFrontierFallback: false,
    },
  };
}

describe('approval-adjudicator', () => {
  beforeEach(() => {
    settingsState.approvalAdjudicationEnabled = false;
    loopState.activeLoops = [];
    auxState.generateImpl.mockReset();
    auxState.generateImpl.mockResolvedValue(textResult(verdictText('escalate')));
    notifyMock.notify.mockReset();
    dbState.db = new Database(':memory:') as unknown as SqliteDriver;
    DurableApprovalStore._resetForTesting();
    _resetApprovalAdjudicatorForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('adjudicate() — verdict parsing', () => {
    it('parses a valid allow verdict', async () => {
      auxState.generateImpl.mockResolvedValueOnce(textResult(verdictText('allow', 'safe read', 'low')));
      const verdict = await adjudicate({ instanceId: 'i1', summary: 's', actionKind: 'Bash', scope: 'bash_execute' });
      expect(verdict).toEqual({ decision: 'allow', reason: 'safe read', riskLevel: 'low' });
    });

    it('parses a valid deny verdict', async () => {
      auxState.generateImpl.mockResolvedValueOnce(textResult(verdictText('deny', 'off-task', 'medium')));
      const verdict = await adjudicate({ instanceId: 'i1', summary: 's', actionKind: 'Bash', scope: 'bash_execute' });
      expect(verdict).toEqual({ decision: 'deny', reason: 'off-task', riskLevel: 'medium' });
    });

    it('parses a valid escalate verdict', async () => {
      auxState.generateImpl.mockResolvedValueOnce(textResult(verdictText('escalate', 'unsure', 'high')));
      const verdict = await adjudicate({ instanceId: 'i1', summary: 's', actionKind: 'Bash', scope: 'bash_execute' });
      expect(verdict).toEqual({ decision: 'escalate', reason: 'unsure', riskLevel: 'high' });
    });

    it('malformed model output escalates', async () => {
      auxState.generateImpl.mockResolvedValueOnce(textResult('not json at all, just prose'));
      const verdict = await adjudicate({ instanceId: 'i1', summary: 's', actionKind: 'Bash', scope: 'bash_execute' });
      expect(verdict.decision).toBe('escalate');
    });

    it('valid JSON that fails schema validation escalates', async () => {
      auxState.generateImpl.mockResolvedValueOnce(textResult(JSON.stringify({ decision: 'maybe', reason: 'x', riskLevel: 'low' })));
      const verdict = await adjudicate({ instanceId: 'i1', summary: 's', actionKind: 'Bash', scope: 'bash_execute' });
      expect(verdict.decision).toBe('escalate');
    });

    it('exceeding the hard timeout escalates', async () => {
      vi.useFakeTimers();
      auxState.generateImpl.mockReturnValueOnce(new Promise(() => {})); // never resolves
      const pending = adjudicate({ instanceId: 'i1', summary: 's', actionKind: 'Bash', scope: 'bash_execute' });
      await vi.advanceTimersByTimeAsync(90_001);
      const verdict = await pending;
      expect(verdict.decision).toBe('escalate');
    });
  });

  describe('maybeAdjudicateDeferredPermission() — unattended wiring', () => {
    it('disabled setting: returns null and never calls the model', async () => {
      settingsState.approvalAdjudicationEnabled = false;
      loopState.activeLoops = [{ chatId: 'inst-1', status: 'running' }];

      const result = await maybeAdjudicateDeferredPermission({
        instanceId: 'inst-1',
        request: bashRequest('inst-1'),
        toolName: 'Bash',
      });
      expect(result).toBeNull();
      expect(auxState.generateImpl).not.toHaveBeenCalled();
    });

    it('enabled but the instance is not in an active loop (attended): returns null, untouched', async () => {
      settingsState.approvalAdjudicationEnabled = true;
      loopState.activeLoops = []; // no active loop for this instance

      const result = await maybeAdjudicateDeferredPermission({
        instanceId: 'inst-1',
        request: bashRequest('inst-1'),
        toolName: 'Bash',
      });
      expect(result).toBeNull();
      expect(auxState.generateImpl).not.toHaveBeenCalled();
    });

    it('a categorized request is NEVER adjudicated, even when enabled and unattended', async () => {
      settingsState.approvalAdjudicationEnabled = true;
      loopState.activeLoops = [{ chatId: 'inst-1', status: 'running' }];

      const secretRequest: PermissionRequest = {
        id: 'req-secret',
        instanceId: 'inst-1',
        scope: 'secret_access',
        resource: 'DB_PASSWORD',
        timestamp: Date.now(),
      };
      const result = await maybeAdjudicateDeferredPermission({
        instanceId: 'inst-1',
        request: secretRequest,
        toolName: 'Read',
      });
      expect(result).toBeNull();
      expect(auxState.generateImpl).not.toHaveBeenCalled();
    });

    it('enabled + unattended + allow verdict resolves with adjudicator attribution, audited', async () => {
      settingsState.approvalAdjudicationEnabled = true;
      loopState.activeLoops = [{ chatId: 'inst-1', status: 'running' }];
      auxState.generateImpl.mockResolvedValueOnce(textResult(verdictText('allow', 'safe listing', 'low')));

      const result = await maybeAdjudicateDeferredPermission({
        instanceId: 'inst-1',
        request: bashRequest('inst-1'),
        toolName: 'Bash',
      });
      expect(result).toEqual({ approved: true, reason: 'safe listing', riskLevel: 'low' });

      const store = DurableApprovalStore.getInstance(dbState.db as SqliteDriver);
      const rows = (dbState.db as unknown as { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[] } })
        .prepare("SELECT * FROM pending_approvals WHERE instance_id = 'inst-1' AND resolved_by = 'adjudicator'")
        .all();
      expect(rows).toHaveLength(1);
      expect(store).toBeInstanceOf(DurableApprovalStore);
    });

    it('enabled + unattended + deny verdict resolves denied with adjudicator attribution', async () => {
      settingsState.approvalAdjudicationEnabled = true;
      loopState.activeLoops = [{ chatId: 'inst-1', status: 'running' }];
      auxState.generateImpl.mockResolvedValueOnce(textResult(verdictText('deny', 'off-task', 'medium')));

      const result = await maybeAdjudicateDeferredPermission({
        instanceId: 'inst-1',
        request: bashRequest('inst-1'),
        toolName: 'Bash',
      });
      expect(result).toEqual({ approved: false, reason: 'off-task', riskLevel: 'medium' });
    });

    it('an escalate verdict returns null (leaves the ask pending for the human)', async () => {
      settingsState.approvalAdjudicationEnabled = true;
      loopState.activeLoops = [{ chatId: 'inst-1', status: 'running' }];
      auxState.generateImpl.mockResolvedValueOnce(textResult(verdictText('escalate', 'unsure', 'high')));

      const result = await maybeAdjudicateDeferredPermission({
        instanceId: 'inst-1',
        request: bashRequest('inst-1'),
        toolName: 'Bash',
      });
      expect(result).toBeNull();
    });
  });

  describe('denial circuit breaker', () => {
    beforeEach(() => {
      settingsState.approvalAdjudicationEnabled = true;
      loopState.activeLoops = [{ chatId: 'inst-1', status: 'running' }];
    });

    it('trips after 3 consecutive denials and escalates everything afterward', async () => {
      auxState.generateImpl.mockResolvedValue(textResult(verdictText('deny', 'no', 'medium')));

      for (let i = 0; i < 3; i++) {
        const outcome = await maybeAdjudicateDeferredPermission({
          instanceId: 'inst-1',
          request: bashRequest('inst-1'),
          toolName: 'Bash',
        });
        expect(outcome?.approved).toBe(false);
      }
      expect(isAdjudicatorBreakerTripped('inst-1')).toBe(true);
      expect(notifyMock.notify).toHaveBeenCalledTimes(1);

      auxState.generateImpl.mockClear();
      const afterTrip = await maybeAdjudicateDeferredPermission({
        instanceId: 'inst-1',
        request: bashRequest('inst-1'),
        toolName: 'Bash',
      });
      expect(afterTrip).toBeNull(); // escalated without even asking the model
      expect(auxState.generateImpl).not.toHaveBeenCalled();
    });

    it('a human approval decision un-trips an already-tripped breaker and requires a fresh streak to re-trip', async () => {
      auxState.generateImpl.mockResolvedValue(textResult(verdictText('deny', 'no', 'medium')));

      // Trip it for real: 3 consecutive denials.
      for (let i = 0; i < 3; i++) {
        await maybeAdjudicateDeferredPermission({ instanceId: 'inst-1', request: bashRequest('inst-1'), toolName: 'Bash' });
      }
      expect(isAdjudicatorBreakerTripped('inst-1')).toBe(true);

      // While tripped, adjudication is skipped entirely (gate returns null, model never asked).
      auxState.generateImpl.mockClear();
      const whileTripped = await maybeAdjudicateDeferredPermission({
        instanceId: 'inst-1',
        request: bashRequest('inst-1'),
        toolName: 'Bash',
      });
      expect(whileTripped).toBeNull();
      expect(auxState.generateImpl).not.toHaveBeenCalled();

      // A human decision (e.g. resolving the now-parked ask) must clear the trip, not just the counter.
      resetAdjudicatorBreaker('inst-1');
      expect(isAdjudicatorBreakerTripped('inst-1')).toBe(false);

      // Adjudication is consulted again immediately after the reset.
      auxState.generateImpl.mockClear();
      auxState.generateImpl.mockResolvedValueOnce(textResult(verdictText('allow', 'fine', 'low')));
      const afterReset = await maybeAdjudicateDeferredPermission({
        instanceId: 'inst-1',
        request: bashRequest('inst-1'),
        toolName: 'Bash',
      });
      expect(afterReset).toEqual({ approved: true, reason: 'fine', riskLevel: 'low' });
      expect(auxState.generateImpl).toHaveBeenCalledTimes(1);

      // Re-tripping requires a FRESH streak of 3 — the reset denial above must not count.
      auxState.generateImpl.mockResolvedValue(textResult(verdictText('deny', 'no', 'medium')));
      await maybeAdjudicateDeferredPermission({ instanceId: 'inst-1', request: bashRequest('inst-1'), toolName: 'Bash' });
      await maybeAdjudicateDeferredPermission({ instanceId: 'inst-1', request: bashRequest('inst-1'), toolName: 'Bash' });
      expect(isAdjudicatorBreakerTripped('inst-1')).toBe(false); // only 2 since the allow/reset
      await maybeAdjudicateDeferredPermission({ instanceId: 'inst-1', request: bashRequest('inst-1'), toolName: 'Bash' });
      expect(isAdjudicatorBreakerTripped('inst-1')).toBe(true); // 3rd denial re-trips
    });

    it('an allow verdict also breaks a denial streak', async () => {
      auxState.generateImpl.mockResolvedValueOnce(textResult(verdictText('deny', 'no', 'medium')));
      auxState.generateImpl.mockResolvedValueOnce(textResult(verdictText('deny', 'no', 'medium')));
      auxState.generateImpl.mockResolvedValueOnce(textResult(verdictText('allow', 'ok', 'low')));
      auxState.generateImpl.mockResolvedValueOnce(textResult(verdictText('deny', 'no', 'medium')));
      auxState.generateImpl.mockResolvedValueOnce(textResult(verdictText('deny', 'no', 'medium')));

      for (let i = 0; i < 5; i++) {
        await maybeAdjudicateDeferredPermission({ instanceId: 'inst-1', request: bashRequest('inst-1'), toolName: 'Bash' });
      }
      // Streak was: deny, deny, allow (reset), deny, deny — never 3 consecutive.
      expect(isAdjudicatorBreakerTripped('inst-1')).toBe(false);
    });

    it('cleanupAdjudicatorBreakerForInstance() forgets tripped state entirely (e.g. on terminateInstance)', async () => {
      auxState.generateImpl.mockResolvedValue(textResult(verdictText('deny', 'no', 'medium')));
      for (let i = 0; i < 3; i++) {
        await maybeAdjudicateDeferredPermission({ instanceId: 'inst-1', request: bashRequest('inst-1'), toolName: 'Bash' });
      }
      expect(isAdjudicatorBreakerTripped('inst-1')).toBe(true);

      cleanupAdjudicatorBreakerForInstance('inst-1');
      expect(isAdjudicatorBreakerTripped('inst-1')).toBe(false);

      // A brand-new streak on the same (now-forgotten) instance id starts from zero.
      auxState.generateImpl.mockClear();
      auxState.generateImpl.mockResolvedValue(textResult(verdictText('deny', 'no', 'medium')));
      await maybeAdjudicateDeferredPermission({ instanceId: 'inst-1', request: bashRequest('inst-1'), toolName: 'Bash' });
      await maybeAdjudicateDeferredPermission({ instanceId: 'inst-1', request: bashRequest('inst-1'), toolName: 'Bash' });
      expect(isAdjudicatorBreakerTripped('inst-1')).toBe(false);
      expect(auxState.generateImpl).toHaveBeenCalledTimes(2);
    });
  });
});
