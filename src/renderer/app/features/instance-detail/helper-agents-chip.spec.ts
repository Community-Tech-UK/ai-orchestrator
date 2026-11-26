import { describe, expect, it, vi } from 'vitest';
import {
  helperAgentsChip,
  helperAgentsTooltip,
  helpersDockChip,
  sessionHelperAgentsRunning,
} from './helper-agents-chip';
import type { DockChipContext } from './session-status-dock.rules';

const context = (patch: Partial<DockChipContext> = {}): DockChipContext => ({
  reviewHasContent: false,
  reviewIssueCount: null,
  reviewHasErrors: false,
  childCount: 0,
  checkpointCount: 0,
  helperAgentsRunning: 0,
  ...patch,
});

describe('helperAgentsChip (part 7c)', () => {
  it('is hidden at zero and at non-counts', () => {
    expect(helperAgentsChip(0)).toBeNull();
    expect(helperAgentsChip(-1)).toBeNull();
    expect(helperAgentsChip(Number.NaN)).toBeNull();
    expect(helperAgentsChip(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('uses singular and plural wording and never the bare word "Agents"', () => {
    expect(helperAgentsChip(1)?.label).toBe('1 helper agent running');
    expect(helperAgentsChip(2)?.label).toBe('2 helper agents running');
    for (const count of [1, 2, 12]) {
      const chip = helperAgentsChip(count);
      expect(chip?.label).not.toMatch(/\bAgents\b/);
      expect(chip?.label).toMatch(/^\d+ helper agents? running$/);
      expect(chip?.tooltipKey).toBe('strip.helperAgents');
    }
  });

  it('reads only the owning session native summary, ignoring other sessions', () => {
    const sessions: Record<string, { nativeHelpers?: { running: number } }> = {
      parent: { nativeHelpers: { running: 2 } }, other: { nativeHelpers: { running: 10 } },
    };
    expect(sessionHelperAgentsRunning('parent', id => sessions[id])).toBe(2);
    expect(sessionHelperAgentsRunning('child', id => sessions[id])).toBe(0);
  });

  it.each(['', 'new'])('does not read or subscribe to live state for draft id %j', id => {
    const read = vi.fn(() => ({ nativeHelpers: { running: 3 } }));
    expect(sessionHelperAgentsRunning(id, read)).toBe(0);
    expect(read).not.toHaveBeenCalled();
  });
});

describe('helpersDockChip registration (part 7c)', () => {
  it('is a typed non-blocking informational chip in the strip registry shape', () => {
    expect(helpersDockChip.id).toBe('helpers');
    expect(helpersDockChip.blocker).toBe(false);
    expect(helpersDockChip.informational).toBe(true);
  });

  it('is hidden at zero and at non-counts', () => {
    expect(helpersDockChip.describe(context(), false)).toBeNull();
    expect(helpersDockChip.describe(context({ helperAgentsRunning: -1 }), false)).toBeNull();
    expect(helpersDockChip.describe(context({ helperAgentsRunning: Number.NaN }), false)).toBeNull();
  });

  it('labels singular and plural runs and never says "Agents"', () => {
    expect(helpersDockChip.describe(context({ helperAgentsRunning: 1 }), false)?.label).toBe(
      '1 helper agent running',
    );
    expect(helpersDockChip.describe(context({ helperAgentsRunning: 2 }), false)?.label).toBe(
      '2 helper agents running',
    );
    for (const running of [1, 2, 12]) {
      const presentation = helpersDockChip.describe(context({ helperAgentsRunning: running }), false);
      expect(presentation?.label).not.toMatch(/\bAgents\b/);
      expect(presentation?.title).toBe(helperAgentsTooltip);
      expect(presentation?.title).toBe(
        'Helper agents the AI started inside this session. They are not separate sessions.',
      );
      expect(presentation?.badge).toBeNull();
    }
  });

  it('counts only native helpers, never separate child sessions', () => {
    // Child sessions (the "Agents (N)" chip's population) must never substitute
    // for the native helpers this chip names.
    const withChildren = context({ childCount: 3, helperAgentsRunning: 1 });
    expect(helpersDockChip.describe(withChildren, false)?.label).toBe('1 helper agent running');
    const onlyChildren = context({ childCount: 3, helperAgentsRunning: 0 });
    expect(helpersDockChip.describe(onlyChildren, false)).toBeNull();
  });

  it('keeps its label while shown (it has no panel to open)', () => {
    expect(helpersDockChip.describe(context({ helperAgentsRunning: 2 }), true)?.label).toBe(
      '2 helper agents running',
    );
  });
});
