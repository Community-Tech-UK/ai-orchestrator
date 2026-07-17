/**
 * WS8 wiring: feed cache-analytics config-event correlation from existing
 * runtime events — no lifecycle code changes needed. Model/provider changes
 * and yolo respawns recycle the provider session (a legitimate cache-break
 * cause); MCP-affecting settings changes alter the injected tool surface for
 * subsequent spawns.
 */

import type { EventEmitter } from 'events';
import type { AppSettings } from '../../shared/types/settings.types';
import { CacheAnalyticsService, getCacheAnalyticsService } from './cache-analytics-service';

/** Settings keys that change the injected MCP/tool surface of new sessions. */
const MCP_AFFECTING_SETTINGS: ReadonlySet<keyof AppSettings> = new Set<keyof AppSettings>([
  'browserMcpToolDeferral',
  'codememEnabled',
  'computerUseEnabled',
  'chromeDevtoolsAttachEnabled',
]);

export interface ContextAnalyticsWiringSources {
  /** InstanceManager (or a compatible emitter in tests). */
  instanceEvents: Pick<EventEmitter, 'on' | 'off'>;
  /** SettingsManager (or a compatible emitter in tests). */
  settingsEvents: Pick<EventEmitter, 'on' | 'off'>;
  service?: CacheAnalyticsService;
}

export function wireContextAnalytics(sources: ContextAnalyticsWiringSources): () => void {
  const service = sources.service ?? getCacheAnalyticsService();

  const onModelChanged = (payload: { instanceId?: string }): void => {
    if (payload?.instanceId) service.noteConfigEvent(payload.instanceId, 'model/provider change');
  };
  const onYoloToggled = (payload: { instanceId?: string }): void => {
    if (payload?.instanceId) service.noteConfigEvent(payload.instanceId, 'permission-mode respawn');
  };
  const onRemoved = (instanceId: unknown): void => {
    if (typeof instanceId === 'string') service.removeInstance(instanceId);
  };
  const onSettingChanged = (key: unknown): void => {
    if (typeof key === 'string' && MCP_AFFECTING_SETTINGS.has(key as keyof AppSettings)) {
      service.noteGlobalConfigEvent(`settings change: ${key}`);
    }
  };

  sources.instanceEvents.on('instance:model-changed', onModelChanged);
  sources.instanceEvents.on('instance:yolo-toggled', onYoloToggled);
  sources.instanceEvents.on('instance:removed', onRemoved);
  sources.settingsEvents.on('setting-changed', onSettingChanged);

  return () => {
    sources.instanceEvents.off('instance:model-changed', onModelChanged);
    sources.instanceEvents.off('instance:yolo-toggled', onYoloToggled);
    sources.instanceEvents.off('instance:removed', onRemoved);
    sources.settingsEvents.off('setting-changed', onSettingChanged);
  };
}
