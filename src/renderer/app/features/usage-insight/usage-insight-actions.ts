/**
 * Turns a cause's button description into something the card can draw and run.
 *
 * Every button must have a real target. A button whose target does not exist (a
 * settings tab that was renamed, a session that is not Claude) resolves to null and
 * the card shows the sentence alone, never a button that does nothing.
 */

import type { UsageCauseAction } from '../../../../shared/usage-insight/usage-cause-rules';
import type { UsageInsightScope } from '../../../../shared/usage-insight/usage-insight.types';
import { isSettingsTab, type SettingsTab } from '../settings/settings-navigation';

/** The session a button would act on. */
export interface UsageActionTarget {
  id: string;
  name: string;
}

export type ResolvedUsageAction =
  | { kind: 'compact'; label: string; instanceId: string }
  | { kind: 'settings'; label: string; tab: SettingsTab }
  | { kind: 'route'; label: string; path: string }
  | { kind: 'context'; label: string; instanceId: string };

const NAME_LIMIT = 28;

function shortName(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > NAME_LIMIT ? `${trimmed.slice(0, NAME_LIMIT - 1).trimEnd()}…` : trimmed;
}

/**
 * On a session's own card the buttons act on that session. On the Costs page they
 * act on the Claude session currently selected, and say so in the label, so
 * "Compact first" never quietly changes a session the reader did not choose.
 */
export function resolveUsageAction(
  action: UsageCauseAction | undefined,
  scope: UsageInsightScope,
  target: UsageActionTarget | null,
): ResolvedUsageAction | null {
  if (!action) return null;
  switch (action.kind) {
    case 'open-settings':
      return isSettingsTab(action.tab) ? { kind: 'settings', label: action.label, tab: action.tab } : null;
    case 'open-route':
      return { kind: 'route', label: action.label, path: action.path };
    case 'compact-session':
      if (!target) return null;
      return {
        kind: 'compact',
        instanceId: target.id,
        label: scope.kind === 'session' ? action.label : `Compact "${shortName(target.name)}" first`,
      };
    case 'open-context-details':
      if (!target) return null;
      return {
        kind: 'context',
        instanceId: target.id,
        label: scope.kind === 'session' ? action.label : `${action.label} for "${shortName(target.name)}"`,
      };
  }
}
