import { describe, expect, it } from 'vitest';
import type { OutputMessage } from '../../core/state/instance/instance.types';
import {
  isCopilotPlanUpdateMessage,
  parseCopilotPlanUpdate,
  summarizeCopilotPlanUpdate,
} from './copilot-plan-update';

function makePlanMessage(
  entries: unknown[],
  overrides: Partial<Pick<OutputMessage, 'content'>> = {},
): Pick<OutputMessage, 'type' | 'metadata' | 'content'> {
  return {
    type: 'system',
    content: '',
    metadata: {
      sessionUpdate: 'plan',
      entries,
    },
    ...overrides,
  };
}

describe('copilot plan updates', () => {
  it('detects ACP plan messages from system metadata', () => {
    expect(isCopilotPlanUpdateMessage(makePlanMessage([]))).toBe(true);
    expect(isCopilotPlanUpdateMessage({ type: 'assistant', content: '', metadata: { sessionUpdate: 'plan' } })).toBe(false);
    expect(isCopilotPlanUpdateMessage({ type: 'system', content: '', metadata: { sessionUpdate: 'tool_call' } })).toBe(false);
  });

  it('detects flattened plan blocks from raw system content', () => {
    expect(isCopilotPlanUpdateMessage({
      type: 'system',
      content: 'Plan:\n- Adding backend tests (completed / medium)\n- Verifying suites (in_progress / high)',
    })).toBe(true);
    expect(isCopilotPlanUpdateMessage({
      type: 'system',
      content: 'Plan: no entries advertised.',
    })).toBe(true);
    expect(isCopilotPlanUpdateMessage({
      type: 'system',
      content: 'Not a plan block',
    })).toBe(false);
  });

  it('parses entries and normalizes common status and priority aliases', () => {
    const parsed = parseCopilotPlanUpdate(makePlanMessage([
      { content: 'Audit controllers', status: 'done', priority: 'HIGH' },
      { content: 'Write tests', status: 'active', priority: 'standard' },
      { content: 'Re-run coverage', status: 'queued', priority: 'nice-to-have' },
      { content: 'Skip docs', status: 'skipped' },
      { content: 'Investigate edge case', status: 'needs-review', priority: 'p1' },
    ]));

    expect(parsed).not.toBeNull();
    expect(parsed?.completedCount).toBe(1);
    expect(parsed?.inProgressCount).toBe(1);
    expect(parsed?.pendingCount).toBe(1);
    expect(parsed?.cancelledCount).toBe(1);
    expect(parsed?.unknownCount).toBe(1);
    expect(parsed?.entries).toEqual([
      expect.objectContaining({ statusKind: 'completed', statusLabel: 'Done', priorityKind: 'high', priorityLabel: 'High' }),
      expect.objectContaining({ statusKind: 'in_progress', statusLabel: 'In progress', priorityKind: 'medium', priorityLabel: 'Medium' }),
      expect.objectContaining({ statusKind: 'pending', statusLabel: 'Pending', priorityKind: 'low', priorityLabel: 'Low' }),
      expect.objectContaining({ statusKind: 'cancelled', statusLabel: 'Cancelled', priorityKind: 'unknown' }),
      expect.objectContaining({ statusKind: 'unknown', statusLabel: 'Needs Review', priorityKind: 'unknown', priorityLabel: 'P1' }),
    ]);
  });

  it('prefers the active step for the compact preview and falls back to pending/latest', () => {
    const active = parseCopilotPlanUpdate(makePlanMessage([
      { content: 'Done item', status: 'completed' },
      { content: 'Current item', status: 'in_progress' },
      { content: 'Later item', status: 'pending' },
    ]));
    const pending = parseCopilotPlanUpdate(makePlanMessage([
      { content: 'Done item', status: 'completed' },
      { content: 'Next up', status: 'pending' },
    ]));
    const latest = parseCopilotPlanUpdate(makePlanMessage([
      { content: 'Done item', status: 'completed' },
      { content: 'Wrapped up', status: 'completed' },
    ]));

    expect(active?.preview).toBe('Current item');
    expect(pending?.preview).toBe('Next up');
    expect(latest?.preview).toBe('Wrapped up');
  });

  it('builds a concise summary line for compact transcript cards', () => {
    const parsed = parseCopilotPlanUpdate(makePlanMessage([
      { content: 'One', status: 'completed' },
      { content: 'Two', status: 'in_progress' },
      { content: 'Three', status: 'pending' },
      { content: 'Four', status: 'pending' },
    ]));

    expect(parsed).not.toBeNull();
    expect(summarizeCopilotPlanUpdate(parsed!)).toBe('4 steps · 1 active · 1 done · 2 pending');
    expect(summarizeCopilotPlanUpdate(parseCopilotPlanUpdate(makePlanMessage([]))!)).toBe('No advertised steps');
  });

  it('falls back to parsing flattened markdown plan content when metadata entries are absent', () => {
    const parsed = parseCopilotPlanUpdate({
      type: 'system',
      content: [
        'Plan:',
        '- Adding backend tests (completed / medium)',
        '- Finding branch gaps (in_progress / medium)',
        '- Verifying BE coverage (pending / medium)',
      ].join('\n'),
      metadata: { sessionUpdate: 'plan' },
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.entries).toEqual([
      expect.objectContaining({
        content: 'Adding backend tests',
        statusKind: 'completed',
        priorityKind: 'medium',
      }),
      expect.objectContaining({
        content: 'Finding branch gaps',
        statusKind: 'in_progress',
        priorityKind: 'medium',
      }),
      expect.objectContaining({
        content: 'Verifying BE coverage',
        statusKind: 'pending',
        priorityKind: 'medium',
      }),
    ]);
    expect(summarizeCopilotPlanUpdate(parsed!)).toBe('3 steps · 1 active · 1 done · 1 pending');
  });

  it('keeps structured empty plan updates on the dedicated plan-update path', () => {
    expect(parseCopilotPlanUpdate(makePlanMessage([]))).toMatchObject({
      entries: [],
      totalCount: 0,
    });
    expect(parseCopilotPlanUpdate({
      type: 'system',
      content: 'Plan: no entries advertised.',
      metadata: { sessionUpdate: 'plan' },
    })).toMatchObject({
      entries: [],
      totalCount: 0,
    });
  });

  it('returns null for malformed non-plan content with no parseable entries', () => {
    expect(parseCopilotPlanUpdate({
      type: 'system',
      content: 'Plan:\nNo bullets here',
    })).toBeNull();
  });
});
