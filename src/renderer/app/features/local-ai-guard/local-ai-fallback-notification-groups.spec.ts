import { describe, expect, it } from 'vitest';
import type { LocalAiRoutingEvent } from '../../../../shared/types/local-ai-guard.types';
import {
  fallbackNotificationGroupCostLabel,
  groupLocalAiFallbackNotifications,
} from './local-ai-fallback-notification-groups';

function event(
  id: string,
  createdAt: number,
  overrides: Partial<LocalAiRoutingEvent> = {},
): LocalAiRoutingEvent {
  return {
    id,
    slot: 'titleGeneration',
    intendedRoute: 'local',
    actualRoute: 'frontier',
    policy: 'notify-and-allow',
    disposition: 'allowed',
    decisionReason: 'policy',
    inputTokens: 100,
    outputTokens: 20,
    createdAt,
    ...overrides,
  };
}

describe('local AI fallback notification grouping', () => {
  it('groups one same-slot burst within five seconds and keeps newest-first event ids', () => {
    const groups = groupLocalAiFallbackNotifications([
      event('oldest', 1_000),
      event('newest', 6_000),
      event('middle', 3_000),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      slot: 'titleGeneration',
      newestCreatedAt: 6_000,
      key: 'newest:middle:oldest',
      eventIds: ['newest', 'middle', 'oldest'],
    });
  });

  it('keeps a same-slot burst together when another slot is interleaved', () => {
    const groups = groupLocalAiFallbackNotifications([
      event('title-old', 1_000),
      event('compression', 2_000, { slot: 'compression' }),
      event('title-new', 3_000),
    ]);

    expect(groups.map((group) => group.eventIds)).toEqual([
      ['title-new', 'title-old'],
      ['compression'],
    ]);
  });

  it('starts a new group when the slot changes or the full burst exceeds five seconds', () => {
    const groups = groupLocalAiFallbackNotifications([
      event('older-title', 1_000),
      event('compression', 4_000, { slot: 'compression' }),
      event('newer-title', 6_100),
    ]);

    expect(groups.map((group) => group.eventIds)).toEqual([
      ['newer-title'],
      ['compression'],
      ['older-title'],
    ]);
  });

  it('labels aggregate measured, estimated, and partially unknown costs conservatively', () => {
    expect(fallbackNotificationGroupCostLabel([
      event('measured-a', 1, { knownCostUsd: 0.001 }),
      event('measured-b', 2, { knownCostUsd: 0.002 }),
    ])).toBe('$0.0030 measured');

    expect(fallbackNotificationGroupCostLabel([
      event('measured', 1, { knownCostUsd: 0.001 }),
      event('estimated', 2, { estimatedCostUsd: 0.0025 }),
    ])).toBe('$0.0035 estimated');

    expect(fallbackNotificationGroupCostLabel([
      event('estimated', 1, { estimatedCostUsd: 0.0025 }),
      event('unknown', 2),
    ])).toBe('$0.0025 estimated + 1 cost unknown');

    expect(fallbackNotificationGroupCostLabel([
      event('unknown-a', 1),
      event('unknown-b', 2),
    ])).toBe('Cost unknown');
  });
});
