import { describe, expect, it } from 'vitest';
import {
  AutomationCreatePayloadSchema,
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
