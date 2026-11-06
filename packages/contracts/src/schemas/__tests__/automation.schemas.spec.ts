import { describe, expect, it } from 'vitest';
import {
  AutomationActionSchema,
  AutomationPreCheckPolicySchema,
  AutomationPreflightPayloadSchema,
  AutomationCreatePayloadSchema,
  AutomationResultSchema,
  AutomationMarkSeenPayloadSchema,
  AutomationRunSchema,
  AutomationUpdatePayloadSchema,
} from '../automation.schemas';

const baseAction = {
  prompt: 'Check the build',
  workingDirectory: '/tmp/project',
};

const baseCreatePayload = {
  name: 'Daily check',
  schedule: { type: 'cron', expression: '0 9 * * *', timezone: 'UTC' },
  missedRunPolicy: 'notify',
  concurrencyPolicy: 'skip',
  action: baseAction,
};
const maxCatalogModelId = `${'m'.repeat(509)}-v1`;
const tooLongCatalogModelId = `${'m'.repeat(510)}-v1`;

describe('AutomationCreatePayloadSchema destination', () => {
  it('accepts bounded webhook triggers and defaults their filter list', () => {
    const parsed = AutomationCreatePayloadSchema.parse({
      ...baseCreatePayload,
      trigger: {
        kind: 'webhook',
        routeId: 'route-issues',
      },
    });

    expect(parsed.trigger).toEqual({
      kind: 'webhook',
      routeId: 'route-issues',
      filters: [],
    });
  });

  it('rejects webhook filter paths outside the dotted-path subset', () => {
    expect(AutomationCreatePayloadSchema.safeParse({
      ...baseCreatePayload,
      trigger: {
        kind: 'webhook',
        routeId: 'route-issues',
        filters: [{ path: 'issue[0].state', operator: 'equals', value: 'opened' }],
      },
    }).success).toBe(false);
  });

  it('defaults missing destinations to a new instance', () => {
    const parsed = AutomationCreatePayloadSchema.parse(baseCreatePayload);

    expect(parsed.destination).toEqual({ kind: 'newInstance' });
  });

  it('accepts thread destinations and defaults archived revival on', () => {
    const parsed = AutomationCreatePayloadSchema.parse({
      ...baseCreatePayload,
      destination: {
        kind: 'thread',
        instanceId: 'instance-1',
        sessionId: 'session-1',
        historyEntryId: 'history-1',
      },
    });

    expect(parsed.destination).toEqual({
      kind: 'thread',
      instanceId: 'instance-1',
      sessionId: 'session-1',
      historyEntryId: 'history-1',
      reviveIfArchived: true,
    });
  });

  it('accepts Claude session-only reasoning modes in automation actions', () => {
    const parsed = AutomationCreatePayloadSchema.parse({
      ...baseCreatePayload,
      action: {
        ...baseAction,
        reasoningEffort: 'workflow',
      },
    });

    expect(parsed.action.reasoningEffort).toBe('workflow');
  });

  it('accepts internal loop resume system actions', () => {
    const parsed = AutomationCreatePayloadSchema.parse({
      ...baseCreatePayload,
      action: {
        ...baseAction,
        systemAction: {
          type: 'loopProviderLimitResume',
          loopRunId: 'loop-1',
        },
      },
    });

    expect(parsed.action.systemAction).toEqual({
      type: 'loopProviderLimitResume',
      loopRunId: 'loop-1',
    });
  });

  it('accepts model ids up to the dynamic catalog limit', () => {
    expect(maxCatalogModelId).toHaveLength(512);

    const parsed = AutomationCreatePayloadSchema.parse({
      ...baseCreatePayload,
      action: {
        ...baseAction,
        model: maxCatalogModelId,
      },
    });

    expect(parsed.action.model).toBe(maxCatalogModelId);
  });

  it('rejects model ids beyond the dynamic catalog limit', () => {
    expect(tooLongCatalogModelId).toHaveLength(513);

    expect(AutomationCreatePayloadSchema.safeParse({
      ...baseCreatePayload,
      action: {
        ...baseAction,
        model: tooLongCatalogModelId,
      },
    }).success).toBe(false);
  });
});

describe('AutomationUpdatePayloadSchema destination', () => {
  it('does not default destination on unrelated updates', () => {
    const parsed = AutomationUpdatePayloadSchema.parse({
      id: 'automation-1',
      updates: {
        name: 'Renamed automation',
      },
    });

    expect(parsed.updates.destination).toBeUndefined();
  });

  it('accepts destination updates without requiring the full automation payload', () => {
    const parsed = AutomationUpdatePayloadSchema.parse({
      id: 'automation-1',
      updates: {
        destination: {
          kind: 'thread',
          instanceId: 'instance-2',
          reviveIfArchived: false,
        },
      },
    });

    expect(parsed.updates.destination).toEqual({
      kind: 'thread',
      instanceId: 'instance-2',
      reviveIfArchived: false,
    });
  });
});

/**
 * Observed live 2026-08-01, from `app.log`:
 *   Blocked invalid renderer event payload
 *   { channel: "automation:changed",
 *     issues: [{ path: "automation.description",
 *                message: "Too big: expected string to have <=1000 characters" }] }
 *
 * An agent appended an operational note to a real automation. The write
 * succeeded (the MCP write path caps at 2000 and does not validate against
 * `AutomationCreatePayloadSchema`), then the `automation:changed`
 * renderer event failed this schema and `validateRendererEventPayload` dropped
 * it — so the automation changed on disk while the Automations UI kept showing
 * the stale one, with no error anywhere the user could see.
 *
 * The bug was the INCONSISTENCY between a 2000-char write cap and a 1000-char
 * event cap, so the fix is one shared bound across create/update/entity — not a
 * truncation, which would have destroyed the note.
 */
describe('automation description length (live drop, 2026-08-01)', () => {
  const longNote = 'PAUSED 2026-08-01 by the engine rework. '.repeat(40); // ~1600 chars

  it('accepts a realistic multi-paragraph operational description on create', () => {
    expect(longNote.length).toBeGreaterThan(1000);
    expect(
      AutomationCreatePayloadSchema.safeParse({
        ...baseCreatePayload,
        description: longNote,
      }).success,
    ).toBe(true);
  });

  it('accepts the same description on update', () => {
    expect(
      AutomationUpdatePayloadSchema.safeParse({
        id: '11111111-2222-4333-8444-555555555555',
        updates: { description: longNote },
      }).success,
    ).toBe(true);
  });

  it('is still bounded — a runaway description is rejected', () => {
    expect(
      AutomationCreatePayloadSchema.safeParse({
        ...baseCreatePayload,
        description: 'x'.repeat(8_001),
      }).success,
    ).toBe(false);
  });
});

/**
 * LT-139 — live-reproduced 2026-08-18. `AutomationActionSchema` never
 * declared `executionProfile`/`containedFallback` even though the shared
 * `AutomationAction` type and the renderer's Automation builder form both
 * set them. `z.object()` strips unknown keys by default, so
 * `validateIpcPayload(AutomationCreatePayloadSchema, ...)` silently dropped
 * both fields on every create/update — an automation built with "Contained"
 * selected in the UI persisted and then ran as 'standard' (full host
 * access, no sandbox) with no error anywhere. Confirmed live: a real
 * `automationCreate` call with `executionProfile: 'contained'` on a Claude
 * automation stored an action with no `executionProfile` field at all, and
 * firing it spawned a completely normal, unsandboxed Claude instance
 * instead of failing at fire time as WS-C7 requires for a non-Codex
 * provider.
 */
describe('automation execution profile (live drop, LT-139, 2026-08-18)', () => {
  it('round-trips executionProfile and containedFallback through create', () => {
    const parsed = AutomationCreatePayloadSchema.parse({
      ...baseCreatePayload,
      action: { ...baseAction, executionProfile: 'contained', containedFallback: 'fail' },
    });

    expect(parsed.action.executionProfile).toBe('contained');
    expect(parsed.action.containedFallback).toBe('fail');
  });

  it('round-trips executionProfile through update', () => {
    const parsed = AutomationUpdatePayloadSchema.parse({
      id: '11111111-2222-4333-8444-555555555555',
      updates: { action: { ...baseAction, executionProfile: 'contained' } },
    });

    expect(parsed.updates.action?.executionProfile).toBe('contained');
  });

  it('rejects an invalid executionProfile value rather than silently dropping it', () => {
    expect(
      AutomationCreatePayloadSchema.safeParse({
        ...baseCreatePayload,
        action: { ...baseAction, executionProfile: 'sandboxed' },
      }).success,
    ).toBe(false);
  });
});

describe('AutomationMarkSeenPayloadSchema', () => {
  it('accepts an explicit all-clear payload', () => {
    expect(AutomationMarkSeenPayloadSchema.parse({ all: true })).toEqual({ all: true });
  });

  it('still requires a target when all is omitted', () => {
    expect(AutomationMarkSeenPayloadSchema.safeParse({}).success).toBe(false);
    expect(AutomationMarkSeenPayloadSchema.safeParse({ automationId: 'auto-1' }).success).toBe(true);
    expect(AutomationMarkSeenPayloadSchema.safeParse({ runId: 'run-1' }).success).toBe(true);
  });
});

describe('scheduled job policy contracts', () => {
  it('round-trips limits and unchanged-output opt-in on both create and update', () => {
    const action = { ...baseAction, maxRunMinutes: 120, maxProcessedTokens: 50_000_000, slowWhenUnchanged: true };
    expect(AutomationCreatePayloadSchema.parse({ ...baseCreatePayload, action }).action).toEqual(action);
    expect(AutomationUpdatePayloadSchema.parse({ id: 'example', updates: { action, dismissModelHint: true } }).updates).toEqual({ action, dismissModelHint: true });
  });
  it.each([{ maxRunMinutes: 0 }, { maxRunMinutes: 1.5 }, { maxProcessedTokens: -1 }])('rejects invalid limits: %j', values => {
    expect(AutomationCreatePayloadSchema.safeParse({ ...baseCreatePayload, action: { ...baseAction, ...values } }).success).toBe(false);
  });
  it('requires an explicit semantic outcome and notification decision', () => {
    expect(AutomationResultSchema.parse({ outcome: 'needs_attention', notify: true })).toEqual({ outcome: 'needs_attention', notify: true });
    expect(AutomationResultSchema.safeParse({ outcome: 'no_change' }).success).toBe(false);
    expect(AutomationResultSchema.safeParse({ outcome: 'failed', notify: true }).success).toBe(false);
  });
});

describe('automation pre-check contracts', () => {
  const preCheck = { command: 'check.sh', onError: 'run-anyway' as const };

  it('preserves a check through create and update validation', () => {
    expect(AutomationCreatePayloadSchema.parse({
      ...baseCreatePayload, action: { ...baseAction, preCheck },
    }).action.preCheck).toEqual(preCheck);
    expect(AutomationUpdatePayloadSchema.parse({
      id: 'automation-1', updates: { action: { ...baseAction, preCheck } },
    }).updates.action?.preCheck).toEqual(preCheck);
  });

  it('rejects pre-checks for contained jobs on both write paths', () => {
    const action = { ...baseAction, preCheck, executionProfile: 'contained' };
    expect(AutomationCreatePayloadSchema.safeParse({ ...baseCreatePayload, action }).success).toBe(false);
    expect(AutomationUpdatePayloadSchema.safeParse({ id: 'automation-1', updates: { action } }).success).toBe(false);
  });

  it('rejects pre-checks with one-time schedules on both write paths', () => {
    const action = { ...baseAction, preCheck };
    const schedule = { type: 'oneTime', runAt: 1_800_000_000_000 };
    expect(AutomationCreatePayloadSchema.safeParse({ ...baseCreatePayload, action, schedule }).success).toBe(false);
    expect(AutomationUpdatePayloadSchema.safeParse({ id: 'automation-1', updates: { action, schedule } }).success).toBe(false);
  });

  it('rejects local pre-checks on jobs pinned to another computer on both write paths', () => {
    const action = { ...baseAction, preCheck, forceNodeId: '11111111-2222-4333-8444-555555555555' };
    expect(AutomationCreatePayloadSchema.safeParse({ ...baseCreatePayload, action }).success).toBe(false);
    expect(AutomationUpdatePayloadSchema.safeParse({ id: 'automation-1', updates: { action } }).success).toBe(false);
    expect(AutomationCreatePayloadSchema.safeParse({
      ...baseCreatePayload, action: { ...action, preCheck: undefined },
    }).success).toBe(true);
  });

  it.each(['11111111-2222-4333-8444-555555555555', 'windows-pc'])(
    'checks placement without changing persisted unchecked target support: %s', (forceNodeId) => {
      const config = { ...baseCreatePayload, action: { ...baseAction, forceNodeId } };
      expect(AutomationPreCheckPolicySchema.safeParse(config).success).toBe(true);
      expect(AutomationPreCheckPolicySchema.safeParse({
        ...config, action: { ...config.action, preCheck },
      }).success).toBe(false);
    },
  );

  it.each(['no-change', 'changed', 'first-check', 'check-failed', 'quiet'])('preserves the run outcome %s', (outcome) => {
    const run = AutomationRunSchema.parse({
      id: 'run-1', automationId: 'automation-1', status: 'skipped', trigger: 'scheduled',
      scheduledAt: 1, startedAt: 1, finishedAt: 2, instanceId: null, loopRunId: null,
      error: null, outputSummary: null, outputFullRef: null, idempotencyKey: null,
      triggerSource: null, deliveryMode: 'notify', seenAt: 2, createdAt: 1, updatedAt: 2,
      configSnapshot: null, attempt: 1, maxAttempts: 3, outcome,
    });
    expect(run.outcome).toBe(outcome);
  });
});

describe('authored automation prompt limits stay separate from runtime notes', () => {
  it.each([500_000, 500_001])('validates %i authored characters consistently on every input surface', (length) => {
    const action = { ...baseAction, prompt: 'x'.repeat(length) };
    const accepted = length === 500_000;
    expect(AutomationActionSchema.safeParse(action).success).toBe(accepted);
    expect(AutomationCreatePayloadSchema.safeParse({ ...baseCreatePayload, action }).success).toBe(accepted);
    expect(AutomationUpdatePayloadSchema.safeParse({ id: 'automation-1', updates: { action } }).success).toBe(accepted);
    expect(AutomationPreflightPayloadSchema.safeParse(action).success).toBe(accepted);
  });
});
