import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CacheAnalyticsService } from './cache-analytics-service';
import { wireContextAnalytics } from './context-analytics-wiring';

describe('wireContextAnalytics', () => {
  let instanceEvents: EventEmitter;
  let settingsEvents: EventEmitter;
  let service: CacheAnalyticsService;

  beforeEach(() => {
    CacheAnalyticsService._resetForTesting();
    service = CacheAnalyticsService.getInstance();
    instanceEvents = new EventEmitter();
    settingsEvents = new EventEmitter();
    wireContextAnalytics({ instanceEvents, settingsEvents, service });
  });

  it('notes model changes and yolo respawns per instance', () => {
    const spy = vi.spyOn(service, 'noteConfigEvent');
    instanceEvents.emit('instance:model-changed', { instanceId: 'i1' });
    instanceEvents.emit('instance:yolo-toggled', { instanceId: 'i1', yoloMode: true });
    expect(spy).toHaveBeenCalledWith('i1', 'model/provider change');
    expect(spy).toHaveBeenCalledWith('i1', 'permission-mode respawn');
  });

  it('drops instance state on removal', () => {
    const spy = vi.spyOn(service, 'removeInstance');
    instanceEvents.emit('instance:removed', 'i1');
    expect(spy).toHaveBeenCalledWith('i1');
  });

  it('notes only MCP-affecting settings changes, globally', () => {
    const spy = vi.spyOn(service, 'noteGlobalConfigEvent');
    settingsEvents.emit('setting-changed', 'browserMcpToolDeferral', true);
    settingsEvents.emit('setting-changed', 'theme', 'dark');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('settings change: browserMcpToolDeferral');
  });

  it('cleanup detaches all listeners', () => {
    const cleanup = wireContextAnalytics({ instanceEvents, settingsEvents, service });
    cleanup();
    const spy = vi.spyOn(service, 'noteConfigEvent');
    // Only the beforeEach wiring remains — one call, not two.
    instanceEvents.emit('instance:model-changed', { instanceId: 'i1' });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
