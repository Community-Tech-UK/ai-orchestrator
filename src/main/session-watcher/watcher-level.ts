import { getSettingsManager } from '../core/config/settings-manager';
import { WATCHER_LEVELS, type WatcherLevel } from './watcher-post-checks';

/** The `keepSessionsGoing` setting. Anything unrecognised reads as off. */
export function watcherLevel(): WatcherLevel | 'off' {
  const value = getSettingsManager().get('keepSessionsGoing');
  return (WATCHER_LEVELS as readonly string[]).includes(value) ? value as WatcherLevel : 'off';
}
