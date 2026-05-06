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
