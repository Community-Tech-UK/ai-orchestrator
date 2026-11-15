import type { Instance } from '../../core/state/instance/instance.types';
import type { ContextMenuItem } from '../../shared/components/context-menu/context-menu.component';

/**
 * The per-session switch for "Keep sessions going without me". Ticked means the helper may carry the session on or
 * flag it; unticked is the mute. Not offered while the setting is off, or on a session the watcher never looks at
 * (only your own Claude sessions are judged, not the helper agents they start), because there is nothing to switch.
 */
export function watcherMenuItems(
  instance: Pick<Instance, 'id' | 'watcherMuted' | 'provider' | 'parentId'>,
  keepSessionsGoing: string,
  setMuted: (instanceId: string, muted: boolean) => void,
): ContextMenuItem[] {
  if (keepSessionsGoing === 'off' || instance.provider !== 'claude' || instance.parentId !== null) return [];
  const keepingGoing = instance.watcherMuted !== true;
  return [{
    id: 'keep-session-going',
    label: 'Keep this session going without me',
    checked: keepingGoing,
    action: () => setMuted(instance.id, keepingGoing),
  }];
}
