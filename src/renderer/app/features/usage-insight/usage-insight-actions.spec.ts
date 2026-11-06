import { describe, expect, it } from 'vitest';
import { USAGE_CAUSES, type UsageCauseAction } from '../../../../shared/usage-insight/usage-cause-rules';
import { isSettingsTab } from '../settings/settings-navigation';
import { resolveUsageAction } from './usage-insight-actions';

const ALL = { kind: 'all' } as const;
const SESSION = { kind: 'session', instanceId: 'inst-1' } as const;
const TARGET = { id: 'inst-1', name: 'Fix the login bug' };

describe('resolveUsageAction', () => {
  it('gives nothing for a cause with no button', () => {
    expect(resolveUsageAction(undefined, ALL, TARGET)).toBeNull();
  });

  it('opens the Settings tab the cause names', () => {
    expect(resolveUsageAction({ kind: 'open-settings', tab: 'memory', label: 'Chat size cap' }, ALL, null))
      .toEqual({ kind: 'settings', label: 'Chat size cap', tab: 'memory' });
  });

  it('gives no button for a Settings tab that does not exist, rather than a button that does nothing', () => {
    const renamed = { kind: 'open-settings', tab: 'no-such-tab', label: 'Somewhere' } as unknown as UsageCauseAction;
    expect(resolveUsageAction(renamed, ALL, TARGET)).toBeNull();
  });

  it('opens a page', () => {
    expect(resolveUsageAction({ kind: 'open-route', path: '/automations', label: 'Scheduled jobs' }, ALL, null))
      .toEqual({ kind: 'route', label: 'Scheduled jobs', path: '/automations' });
  });

  describe('buttons that act on a session', () => {
    const compact: UsageCauseAction = { kind: 'compact-session', label: 'Compact first' };
    const context: UsageCauseAction = { kind: 'open-context-details', label: 'Context details' };

    it('have no target, so no button, when there is no Claude session to act on', () => {
      expect(resolveUsageAction(compact, ALL, null)).toBeNull();
      expect(resolveUsageAction(context, SESSION, null)).toBeNull();
    });

    it("keep the plain label on a session's own card", () => {
      expect(resolveUsageAction(compact, SESSION, TARGET)).toEqual({ kind: 'compact', label: 'Compact first', instanceId: 'inst-1' });
      expect(resolveUsageAction(context, SESSION, TARGET)).toEqual({ kind: 'context', label: 'Context details', instanceId: 'inst-1' });
    });

    it('name the session on the Costs page, so nothing changes a session the reader did not choose', () => {
      expect(resolveUsageAction(compact, ALL, TARGET)).toMatchObject({ label: 'Compact "Fix the login bug" first' });
      expect(resolveUsageAction(context, ALL, TARGET)).toMatchObject({ label: 'Context details for "Fix the login bug"' });
    });

    it('shorten a long session name', () => {
      const long = { id: 'inst-2', name: 'Refactor the whole payment provider integration layer' };
      const label = resolveUsageAction(compact, ALL, long)!.label;
      expect(label).toBe('Compact "Refactor the whole payment…" first');
    });
  });

  it('resolves every button the causes define against a real Settings tab or page', () => {
    for (const { action } of USAGE_CAUSES) {
      if (action?.kind === 'open-settings') expect(isSettingsTab(action.tab)).toBe(true);
      if (action?.kind === 'open-route') expect(action.path.startsWith('/')).toBe(true);
    }
  });
});
