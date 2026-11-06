import { describe, expect, it } from 'vitest';
import type { OutputMessage } from '../../core/state/instance/instance.types';
import * as systemEvents from './display-item-system-events';
import {
  ROUTINE_NOTICE_GROUP_ACTION,
  buildRoutineGroupLabel,
  createRoutineNoticeGroup,
  isFoldableRoutineNotice,
  isQuietProviderCompactionMarker,
} from './display-item-system-events';

function system(metadata: Record<string, unknown>): OutputMessage {
  return { id: 'm', type: 'system', timestamp: 1, content: 'notice', metadata };
}

describe('routine notice folding helpers (U10)', () => {
  it('no longer carries a list of exact notice wordings', () => {
    expect('QUIET_INTERRUPT_SYSTEM_MESSAGES' in systemEvents).toBe(false);
  });

  it('folds only system messages that an emit site flagged routine', () => {
    expect(isFoldableRoutineNotice(system({ audience: 'routine' }))).toBe(true);
    expect(isFoldableRoutineNotice(system({ audience: 'attention' }))).toBe(false);
    expect(isFoldableRoutineNotice(system({}))).toBe(false);
    expect(isFoldableRoutineNotice({ id: 'm', type: 'system', timestamp: 1, content: 'Interrupted — waiting for input' })).toBe(false);
    expect(isFoldableRoutineNotice({ ...system({ audience: 'routine' }), type: 'assistant' })).toBe(false);
    expect(isFoldableRoutineNotice({ ...system({ audience: 'routine' }), type: 'error' })).toBe(false);
  });

  it.each([
    ['an approval request', { action: 'request_user_action' }],
    ['an approval answer', { action: 'user_action_response' }],
    ['a task error', { action: 'task_error' }],
    ['a permission decision', { permissionDecision: true }],
    ['a blocked secret request', { secretRequestBlocked: true }],
    ['a permission prompt', { type: 'permission_denial' }],
    ['a secret prompt', { type: 'secret_required' }],
    ['an input request', { type: 'input_required' }],
    ['a failed tool (is_error)', { is_error: true }],
    ['a failed tool (isError)', { isError: true }],
    ['a failed check', { checkFailed: true }],
  ])('never folds %s, even when it is flagged routine', (_label, extra) => {
    expect(isFoldableRoutineNotice(system({ audience: 'routine', ...extra }))).toBe(false);
  });

  it('words the row as "N system events" with a correct singular', () => {
    expect(buildRoutineGroupLabel(1)).toBe('1 system event');
    expect(buildRoutineGroupLabel(2)).toBe('2 system events');
    expect(buildRoutineGroupLabel(12)).toBe('12 system events');
  });

  it('builds a group row that other groups cannot merge into by action', () => {
    const message: OutputMessage = {
      id: 'r1',
      type: 'system',
      timestamp: 1_000,
      content: 'Interrupted — waiting for input',
      metadata: { audience: 'routine', action: 'get_children', source: 'orchestration' },
    };
    const item = createRoutineNoticeGroup(message, 7);

    expect(item).toMatchObject({
      id: 'sysgrp-r1',
      type: 'system-event-group',
      groupAction: ROUTINE_NOTICE_GROUP_ACTION,
      groupLabel: '1 system event',
      groupPreview: 'Interrupted — waiting for input',
      timestamp: 1_000,
      bufferIndex: 7,
    });
    expect(item.systemEvents).toEqual([message]);
  });
});

describe('isQuietProviderCompactionMarker', () => {
  // xqs4fg7sl's transcript was three rows per compaction; the boundary row alone says it happened.
  it('hides the start and successful finish notices of a provider compaction', () => {
    expect(isQuietProviderCompactionMarker(system({ providerCompaction: 'started' }))).toBe(true);
    expect(isQuietProviderCompactionMarker(system({ providerCompaction: 'completed', providerCompactionOutcome: 'settled' })))
      .toBe(true);
  });

  it('keeps the boundary row and every failed outcome visible', () => {
    expect(isQuietProviderCompactionMarker(system({ providerCompaction: 'completed', threadCompacted: true }))).toBe(false);
    expect(isQuietProviderCompactionMarker(system({ providerCompaction: 'completed', isCompactionBoundary: true }))).toBe(false);
    for (const outcome of ['timed-out', 'stalled', 'aborted', 'failed', 'cancelled']) {
      expect(isQuietProviderCompactionMarker(system({ providerCompaction: 'completed', providerCompactionOutcome: outcome })))
        .toBe(false);
    }
    expect(isQuietProviderCompactionMarker({ ...system({ providerCompaction: 'started' }), type: 'error' })).toBe(false);
    expect(isQuietProviderCompactionMarker(system({}))).toBe(false);
  });
});
